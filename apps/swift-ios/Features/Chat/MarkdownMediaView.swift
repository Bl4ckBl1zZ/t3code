import SwiftUI
import UIKit

/// What a transcript needs to turn assistant markdown media into something
/// loadable. Absent outside a thread — the pull-request sheet and the file
/// viewer render markdown too — where media that is not already a URL has
/// nothing to resolve against and stays a named placeholder.
struct MarkdownMediaContext {
    let threadID: String
    var resolveDocumentURL: (@MainActor (FeatureMessageAttachment) async throws -> URL)? = nil
    /// Mints a signed asset URL for media that lives on the environment rather
    /// than on the open web. Throwing is the normal failure path: an
    /// environment without the capability, a purged worktree, a missing file.
    let resolveAssetURL: @MainActor (MarkdownMediaResource) async throws -> URL

    init(
        threadID: String,
        resolveAssetURL: @escaping @MainActor (MarkdownMediaResource) async throws -> URL
    ) {
        self.threadID = threadID
        self.resolveAssetURL = resolveAssetURL
    }

    /// The transcript's context: workspace files and browser artifacts both go
    /// through the client's signed asset route, which is also what resolves
    /// them for the file viewer and for message attachments.
    init(threadID: String, client: any FeatureClient, baseDirectory: String? = nil) {
        let resolver = client as? any FeatureWorkspaceAssetResolving
        self.init(threadID: threadID) { resource in
            guard let resolver else {
                throw FeatureCapabilityUnavailable("Signed media URLs")
            }
            switch resource {
            case let .workspaceFile(threadID, path):
                return try await resolver.workspaceAssetURL(threadID: threadID, path: FeatureFilePreviewPath.resolve(path, relativeTo: baseDirectory))
            case let .browserArtifact(fileName):
                return try await resolver.browserArtifactAssetURL(
                    threadID: threadID,
                    fileName: fileName
                )
            }
        }
        if let documents = client as? any FeatureDocumentAttachmentResolving {
            resolveDocumentURL = { attachment in try await documents.documentAttachmentURL(threadID: threadID, attachment: attachment) }
        }
    }
}

private struct MarkdownGalleryKey: EnvironmentKey {
    static let defaultValue: [MarkdownInlineImage] = []
}

private struct MarkdownMediaContextKey: EnvironmentKey {
    static let defaultValue: MarkdownMediaContext? = nil
}

extension EnvironmentValues {
    var markdownGallery: [MarkdownInlineImage] {
        get { self[MarkdownGalleryKey.self] }
        set { self[MarkdownGalleryKey.self] = newValue }
    }

    var markdownMediaContext: MarkdownMediaContext? {
        get { self[MarkdownMediaContextKey.self] }
        set { self[MarkdownMediaContextKey.self] = newValue }
    }
}

enum MarkdownMedia {
    /// Media reserves its frame before the bytes arrive and keeps it whether
    /// they land or not. A row that grows after it has been laid out forces the
    /// hosting collection view to re-measure a cell it already placed, which is
    /// the one thing the transcript cannot absorb cheaply.
    static let frameHeight: CGFloat = 192
    /// Bounds the decode: media is drawn at reading width, and the full-screen
    /// viewer loads its own copy.
    static let maximumWidth: CGFloat = 420
}

/// Assistant media in a message: `![alt](src)`. The src may be an ordinary URL,
/// a path inside the thread workspace, or a Hermes browser artifact, and only
/// the first can be loaded without asking the server for a signed URL.
struct MarkdownMediaView: View {
    private struct Request: Hashable {
        let src: String
        let threadID: String?
        let maximumPixelSize: Int
    }

    let image: MarkdownInlineImage

    @SwiftUI.Environment(\.markdownMediaContext) private var context
    @SwiftUI.Environment(\.displayScale) private var displayScale
    @SwiftUI.Environment(\.markdownGallery) private var gallery

    /// Tracked per request rather than as a bare flag: a recycled cell can be
    /// handed a different message, and a stale image must not be shown against
    /// the new one.
    @State private var loadedRequest: Request?
    @State private var loadedImage: UIImage?
    @State private var loadedVideoURL: URL?
    @State private var failedRequest: Request?
    @State private var isExpanded = false
    /// URL expires, and a transcript can sit on screen for hours.
    @State private var exportFile: MediaExportFile?
    @State private var isSharing = false
    @State private var exportTask: Task<Void, Never>?
    @State private var exportError: String?
    @ScaledMetric(relativeTo: .title3) private var placeholderGlyphSize: CGFloat = 20

    var body: some View {
        content
            .frame(maxWidth: .infinity)
            .frame(height: MarkdownMedia.frameHeight)
            .background(T3Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contextMenu {
                Button {
                    exportMedia(saveToPhotos: true)
                } label: { Label(isVideo ? "Save Video" : "Save Image", systemImage: "square.and.arrow.down") }
                .disabled(exportTask != nil)
                Button {
                    exportMedia(saveToPhotos: false)
                } label: { Label("Share Original…", systemImage: "square.and.arrow.up") }
                .disabled(exportTask != nil)
            }
            .overlay(alignment: .topTrailing) {
                if exportTask != nil { ProgressView().padding(12).background(.regularMaterial, in: Circle()) }
            }
            .sheet(isPresented: $isSharing, onDismiss: clearExport) {
                if let exportFile { MediaShareSheet(url: exportFile.url) }
            }
            .alert(isVideo ? "Couldn't Save Video" : "Couldn't Save Image", isPresented: Binding(
                get: { exportError != nil }, set: { if !$0 { exportError = nil } }
            )) { Button("OK") { exportError = nil } } message: { Text(exportError ?? "") }
            .onChange(of: request) { _, _ in
                exportTask?.cancel()
                exportTask = nil
            }
            .onDisappear { exportTask?.cancel() }
            .task(id: request) {
                await load(request)
            }
            .fullScreenCover(isPresented: $isExpanded) {
                MarkdownGallerySheet(images: gallery.isEmpty ? [image] : gallery, initial: image, context: context)
            }
    }

    @ViewBuilder
    private var content: some View {
        if isVideo, loadedRequest == request, let loadedVideoURL {
            FeatureInlineVideoView(url: loadedVideoURL, title: caption)
        } else if loadedRequest == request, let loadedImage {
            Button {
                isExpanded = true
            } label: {
                // Filled into the reserved frame, never letterboxed; the
                // full-screen viewer shows the whole picture.
                Color.clear
                    .overlay {
                        Image(uiImage: loadedImage)
                            .resizable()
                            .scaledToFill()
                    }
                    .clipped()
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(caption)
            .accessibilityHint("Opens this image full screen")
        } else {
            placeholder
        }
    }

    private var placeholder: some View {
        VStack(spacing: 6) {
            Image(systemName: placeholderSymbol)
                .font(.system(size: placeholderGlyphSize, weight: .medium))
            Text(caption)
                .font(T3Typography.supporting)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .padding(.horizontal, 12)
        }
        .foregroundStyle(T3Colors.textSecondary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            isFailed ? "Media unavailable: \(caption)" : caption
        )
    }

    private var isFailed: Bool {
        failedRequest == request
    }

    private var placeholderSymbol: String {
        if isVideo {
            return "play.rectangle"
        }
        return isFailed ? "exclamationmark.triangle" : "photo"
    }

    /// Video needs a player, which the transcript does not have inline yet;
    /// naming it beats a frame that can only ever fail to decode.
    private var isVideo: Bool {
        MarkdownMediaSource.isVideo(image.src)
    }

    private var caption: String {
        image.alt.isEmpty ? MarkdownMediaSource.fileName(image.src) : image.alt
    }

    private var request: Request {
        Request(
            src: image.src,
            threadID: context?.threadID,
            maximumPixelSize: min(
                1_280,
                max(512, Int(ceil(MarkdownMedia.maximumWidth * displayScale)))
            )
        )
    }

    /// Keyed by what the markdown said rather than by the URL it resolved to:
    /// a signed URL is minted per request and would never key the same twice,
    /// so scrolling a message back on screen would re-mint and re-download it.
    private var cacheKey: NSString {
        "markdown-media:\(request.threadID ?? "")\u{0}\(request.src)#\(request.maximumPixelSize)"
            as NSString
    }

    private func load(_ request: Request) async {
        guard loadedRequest != request else { return }

        if isVideo {
            do {
                let url = try await resolveURL(request)
                try Task.checkCancellation()
                loadedImage = nil
                loadedVideoURL = url
                loadedRequest = request
                failedRequest = nil
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                loadedVideoURL = nil
                failedRequest = request
            }
            return
        }

        if let cached = FeatureAttachmentThumbnailCache.shared.image(for: cacheKey) {
            loadedImage = cached
            loadedRequest = request
            failedRequest = nil
            return
        }

        do {
            let url = try await resolveURL(request)
            let decoded = try await FeatureAttachmentThumbnailLoader.image(
                for: url,
                maximumPixelSize: request.maximumPixelSize
            )
            try Task.checkCancellation()
            FeatureAttachmentThumbnailCache.shared.insert(decoded, for: cacheKey)
            loadedImage = decoded
            loadedVideoURL = nil
            loadedRequest = request
            failedRequest = nil
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            failedRequest = request
        }
    }

    private func clearExport() {
        exportFile?.remove()
        exportFile = nil
    }

    private func exportMedia(saveToPhotos: Bool) {
        guard exportTask == nil else { return }
        let captured = request
        exportTask = Task {
            defer { if request == captured { exportTask = nil } }
            do {
                let url = try await resolveURL(captured)
                let file = try await MediaExport.download(url)
                do {
                    try Task.checkCancellation()
                    if saveToPhotos {
                        try await MediaExport.saveToPhotos(file)
                        file.remove()
                        PlatformHapticEngine.shared.play(.success)
                        T3HUD.show("Saved to Photos", systemImage: "checkmark")
                    } else {
                        clearExport()
                        exportFile = file
                        isSharing = true
                    }
                } catch {
                    file.remove()
                    throw error
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                PlatformHapticEngine.shared.play(.error)
                exportError = error.localizedDescription
            }
        }
    }

    private func resolveURL(_ request: Request) async throws -> URL {
        switch MarkdownMediaSource.resolve(request.src, threadID: request.threadID ?? "") {
        case let .direct(url):
            guard let url = URL(string: url) else {
                throw FeatureAttachmentThumbnailError.invalidResponse
            }
            return url
        case let .resource(resource):
            guard let context else {
                throw FeatureCapabilityUnavailable("Signed media URLs")
            }
            return try await context.resolveAssetURL(resource)
        }
    }
}

/// Resolves only the selected page and its neighbours. Signed URLs are minted
/// for each presentation, so reopening an old message does not reuse an expired URL.
/// A black canvas in dark appearance, like Photos; a tap hides the chrome.
struct MarkdownGallerySheet: View {
    private struct PageLoad: Hashable {
        let index: Int
        let attempt: Int
    }

    let images: [MarkdownInlineImage]
    let context: MarkdownMediaContext?
    @State private var index: Int
    @State private var urls: [Int: URL] = [:]
    @State private var failures: Set<Int> = []
    @State private var attempt = 0
    @State private var exporting = false
    @State private var exportFile: MediaExportFile?
    @State private var sharing = false
    @State private var exportError: String?
    @State private var chromeHidden = false

    init(images: [MarkdownInlineImage], initial: MarkdownInlineImage, context: MarkdownMediaContext?) {
        self.images = images.isEmpty ? [initial] : images
        self.context = context
        _index = State(initialValue: images.firstIndex(of: initial) ?? 0)
    }

    private var title: String {
        let image = images[index]
        return image.alt.isEmpty ? MarkdownMediaSource.fileName(image.src) : image.alt
    }

    /// Nil for a single image: there is no position to report.
    private var position: String? {
        images.count > 1 ? "\(index + 1) of \(images.count)" : nil
    }

    var body: some View {
        NavigationStack {
            TabView(selection: $index) {
                ForEach(images.indices, id: \.self) { page in
                    Group {
                        if abs(page - index) > 1 {
                            Color.clear
                        } else if let url = urls[page] {
                            AsyncImage(url: url) { phase in
                                switch phase {
                                case let .success(image): ZoomableMessageImage(image: image, isCurrentPage: page == index)
                                case .failure: unavailable(page)
                                default: ProgressView()
                                }
                            }
                        } else if failures.contains(page) {
                            unavailable(page)
                        } else { ProgressView() }
                    }
                    .padding(12).tag(page)
                    .accessibilityLabel(images[page].alt)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .background(Color.black.ignoresSafeArea())
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(.snappy) { chromeHidden.toggle() } }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .modifier(GalleryPositionSubtitle(position: position))
            .t3SheetToolbar(.close)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Share Original…", systemImage: "square.and.arrow.up") { export(save: false) }
                        Button("Save Image", systemImage: "square.and.arrow.down") { export(save: true) }
                    } label: {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                    .disabled(exporting || urls[index] == nil)
                }
            }
            .toolbar(chromeHidden ? .hidden : .visible, for: .navigationBar)
            .statusBarHidden(chromeHidden)
            .sheet(isPresented: $sharing, onDismiss: { exportFile?.remove(); exportFile = nil }) {
                if let exportFile { MediaShareSheet(url: exportFile.url) }
            }
            .alert("Couldn't Export Image", isPresented: Binding(get: { exportError != nil }, set: { if !$0 { exportError = nil } })) {
                Button("OK") { exportError = nil }
            } message: { Text(exportError ?? "") }
            .task(id: PageLoad(index: index, attempt: attempt)) {
                for page in max(0, index - 1)...min(images.count - 1, index + 1) where urls[page] == nil {
                    do {
                        let url = try await resolve(images[page])
                        try Task.checkCancellation()
                        urls[page] = url
                        failures.remove(page)
                    } catch { if !Task.isCancelled { failures.insert(page) } }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func unavailable(_ page: Int) -> some View {
        ContentUnavailableView {
            Label("Image Unavailable", systemImage: "photo.badge.exclamationmark")
        } actions: {
            Button("Try Again") {
                // A fresh URL, since a signed one may be what expired.
                urls[page] = nil
                failures.remove(page)
                attempt += 1
            }
            .t3SecondaryButtonStyle()
        }
    }

    private func resolve(_ image: MarkdownInlineImage) async throws -> URL {
        switch MarkdownMediaSource.resolve(image.src, threadID: context?.threadID ?? "") {
        case let .direct(value):
            guard let resolved = URL(string: value) else { throw FeatureAttachmentThumbnailError.invalidResponse }
            return resolved
        case let .resource(resource):
            guard let context else { throw FeatureCapabilityUnavailable("Signed media URLs") }
            return try await context.resolveAssetURL(resource)
        }
    }

    private func export(save: Bool) {
        guard !exporting else { return }
        let selected = images[index]
        exporting = true
        Task {
            defer { exporting = false }
            do {
                let file = try await MediaExport.download(try await resolve(selected))
                do {
                    if save {
                        try await MediaExport.saveToPhotos(file)
                        file.remove()
                        PlatformHapticEngine.shared.play(.success)
                        T3HUD.show("Saved to Photos", systemImage: "checkmark")
                    } else { exportFile?.remove(); exportFile = file; sharing = true }
                } catch { file.remove(); throw error }
            } catch {
                PlatformHapticEngine.shared.play(.error)
                exportError = error.localizedDescription
            }
        }
    }
}

/// "2 of 5" under the title on iOS 26; earlier systems have no subtitle and
/// swiping is its own indicator.
private struct GalleryPositionSubtitle: ViewModifier {
    let position: String?

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), let position {
            content.navigationSubtitle(position)
        } else {
            content
        }
    }
}

