import SwiftUI
import UIKit

/// What a transcript needs to turn assistant markdown media into something
/// loadable. Absent outside a thread — the pull-request sheet and the file
/// viewer render markdown too — where media that is not already a URL has
/// nothing to resolve against and stays a named placeholder.
struct MarkdownMediaContext {
    let threadID: String
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
    init(threadID: String, client: any FeatureClient) {
        let resolver = client as? any FeatureWorkspaceAssetResolving
        self.init(threadID: threadID) { resource in
            guard let resolver else {
                throw FeatureCapabilityUnavailable("Signed media URLs")
            }
            switch resource {
            case let .workspaceFile(threadID, path):
                return try await resolver.workspaceAssetURL(threadID: threadID, path: path)
            case let .browserArtifact(fileName):
                return try await resolver.browserArtifactAssetURL(
                    threadID: threadID,
                    fileName: fileName
                )
            }
        }
    }
}

private struct MarkdownMediaContextKey: EnvironmentKey {
    static let defaultValue: MarkdownMediaContext? = nil
}

extension EnvironmentValues {
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

    /// Tracked per request rather than as a bare flag: a recycled cell can be
    /// handed a different message, and a stale image must not be shown against
    /// the new one.
    @State private var loadedRequest: Request?
    @State private var loadedImage: UIImage?
    @State private var loadedVideoURL: URL?
    @State private var failedRequest: Request?
    @State private var isExpanded = false
    /// Minted when the viewer opens rather than reused from the load: a signed
    /// URL expires, and a transcript can sit on screen for hours.
    @State private var expandedURL: URL?

    var body: some View {
        content
            .frame(maxWidth: .infinity)
            .frame(height: MarkdownMedia.frameHeight)
            .background(T3Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(T3Colors.border, lineWidth: 1)
            }
            .task(id: request) {
                await load(request)
            }
            .fullScreenCover(isPresented: $isExpanded) {
                FeatureImagePreviewSheet(url: expandedURL, title: caption)
                    .task {
                        expandedURL = try? await resolveURL(request)
                    }
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
                Image(uiImage: loadedImage)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                .font(.system(size: 20, weight: .medium))
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

/// Full-screen image viewer shared by message attachments and assistant media.
/// A nil URL is a normal state: markdown media mints its signed URL while the
/// viewer is already on screen.
struct FeatureImagePreviewSheet: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let url: URL?
    let title: String

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let url {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case let .success(image):
                            image
                                .resizable()
                                .scaledToFit()
                        case .failure:
                            ContentUnavailableView(
                                "Image unavailable",
                                systemImage: "exclamationmark.triangle"
                            )
                        case .empty:
                            ProgressView()
                        @unknown default:
                            ProgressView()
                        }
                    }
                    .padding(12)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .t3NavigationChrome()
        }
        .preferredColorScheme(.dark)
    }
}
