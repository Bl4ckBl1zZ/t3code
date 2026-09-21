import ImageIO
import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers
import UIKit

struct FeatureAttachmentPreparationState: Equatable {
    struct Operation: Hashable {
        fileprivate let id: UUID
    }

    private var pendingItemsByOperation: [Operation: Int] = [:]

    var isPreparing: Bool {
        !pendingItemsByOperation.isEmpty
    }

    var pendingItemCount: Int {
        pendingItemsByOperation.values.reduce(0, +)
    }

    var statusLabel: String {
        pendingItemCount == 1 ? "Preparing attachment…" : "Preparing \(pendingItemCount) attachments…"
    }

    @discardableResult
    mutating func begin(itemCount: Int, id: UUID = UUID()) -> Operation {
        let operation = Operation(id: id)
        pendingItemsByOperation[operation] = max(1, itemCount)
        return operation
    }

    mutating func finish(_ operation: Operation) {
        pendingItemsByOperation.removeValue(forKey: operation)
    }
}

/// The attachment sources, shared with the composer so its plus menu
/// can name them. The pickers are mutually exclusive, so one optional value
/// rather than three booleans.
enum FeatureAttachmentSource: Equatable {
    case photoLibrary
    case camera
    case files

    static var cameraAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }
}

struct FeatureImageAttachmentPicker: View {
    private typealias Source = FeatureAttachmentSource

    @Binding var attachments: [FeatureDraftAttachment]
    @Binding var preparationState: FeatureAttachmentPreparationState
    /// Mirrors whether any source is on screen, so the composer can keep this
    /// view in the hierarchy while a picker is up. Presenting a picker resigns
    /// the keyboard, and if the composer collapsed on that focus loss it would
    /// remove this view -- and tear down the presentation it just started.
    @Binding var isPresentingSource: Bool
    /// The composer's plus menu asks for a source through this binding rather
    /// than by calling into the view: the presentations live here, and the
    /// menu lives in the composer's own controls row.
    @Binding var requestedSource: FeatureAttachmentSource?
    /// False when the composer draws its own plus menu and this view only hosts
    /// the presentations it asks for.
    let showsControl: Bool
    let maximumCount: Int
    /// Whether the selected model accepts *images*. Documents are read off disk
    /// by the agent rather than sent to the vision endpoint, so they stay
    /// available on a text-only model.
    let isEnabled: Bool

    /// One optional source rather than three booleans: the pickers are mutually
    /// exclusive, and three independent flags can each be set while another
    /// cover is still on screen, which UIKit rejects.
    @State private var activeSource: Source?
    /// Debug-only identity probe: a fresh value here means SwiftUI rebuilt this
    /// view and discarded its `@State`, which would also silently reset
    /// `activeSource` and dismiss any picker mid-presentation.
    @State private var instanceID = UUID().uuidString.prefix(8)
    @State private var photoSelections: [PhotosPickerItem] = []
    @State private var errorMessage: String?

    init(
        attachments: Binding<[FeatureDraftAttachment]>,
        preparationState: Binding<FeatureAttachmentPreparationState>,
        isPresentingSource: Binding<Bool> = .constant(false),
        requestedSource: Binding<FeatureAttachmentSource?> = .constant(nil),
        showsControl: Bool = true,
        maximumCount: Int = 8,
        isEnabled: Bool = true
    ) {
        _attachments = attachments
        _preparationState = preparationState
        _isPresentingSource = isPresentingSource
        _requestedSource = requestedSource
        self.showsControl = showsControl
        self.maximumCount = maximumCount
        self.isEnabled = isEnabled
    }

    var body: some View {
        Group {
            if showsControl {
                control
                    .buttonStyle(.plain)
                    .disabled(!canAdd)
                    .opacity(canAdd ? 1 : 0.3)
                    .accessibilityLabel(attachmentAccessibilityLabel)
                    .accessibilityIdentifier("image-attachment-picker")
                    .accessibilityHint(attachmentAccessibilityHint)
            } else {
                // Presentation host only: the composer's plus menu is the control.
                Color.clear
                    .frame(width: 0, height: 0)
                    .accessibilityHidden(true)
            }
        }
        .onAppear {
            #if DEBUG
            print("ATTACH appear instance=\(instanceID) source=\(String(describing: activeSource))")
            #endif
        }
        .onChange(of: activeSource) { previous, next in
            #if DEBUG
            print("ATTACH source \(String(describing: previous)) -> \(String(describing: next)) instance=\(instanceID)")
            #endif
            isPresentingSource = next != nil
        }
        .onChange(of: requestedSource) { _, next in
            guard let next else { return }
            requestedSource = nil
            present(next)
        }
        // Framework-managed presentations rather than PHPickerViewController /
        // UIDocumentPickerViewController wrapped in a representable. Both of
        // those are *remote* view controllers: their views proxy an
        // out-of-process scene, and hosting them in a fullScreenCover meant
        // this file owned a lifecycle it kept getting wrong -- dismissing from
        // inside the delegate callback, or holding the picker on screen and
        // mutating its view, both invalidated that scene and lost the
        // selection. SwiftUI owns that lifecycle here.
        .photosPicker(
            isPresented: presentationBinding(for: .photoLibrary),
            selection: $photoSelections,
            maxSelectionCount: max(1, remainingCount),
            matching: .images,
            // Carried over from the PHPickerViewController this replaced: the
            // composer re-encodes every upload to JPEG anyway, so asking Photos
            // for a compatible representation avoids materializing and shipping
            // a ProRAW/HEIF original across XPC first.
            preferredItemEncoding: .compatible
        )
        .onChange(of: photoSelections) { _, items in
            guard !items.isEmpty else { return }
            photoSelections = []
            loadPhotoItems(items)
        }
        // Ported from `pickComposerDocuments` in apps/mobile/src/lib/composerDocuments.ts:
        // the type filter is deliberately unrestricted so PDFs, video and
        // arbitrary documents share one affordance. The server validates the
        // MIME against the contract, so a second allowlist here could only
        // drift from it.
        .fileImporter(
            isPresented: presentationBinding(for: .files),
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case let .success(urls):
                loadFiles(urls)
            case let .failure(error):
                errorMessage = error.localizedDescription
            }
        }
        // No SwiftUI equivalent for capture, so the camera stays a
        // representable -- but UIImagePickerController runs in-process, so it
        // does not carry the remote-scene hazard the other two did.
        .fullScreenCover(isPresented: presentationBinding(for: .camera)) {
            FeatureCameraPicker(
                onCapture: loadCapturedImage,
                onCancel: { activeSource = nil }
            )
            .ignoresSafeArea()
        }
        .alert(
            "Couldn’t add attachment",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    /// The plus, opening a system menu of sources.
    private var control: some View {
        Menu {
            Button { present(.photoLibrary) } label: {
                Label("Photo Library", systemImage: "photo.on.rectangle")
            }
            .disabled(!isEnabled)
            if Source.cameraAvailable {
                Button { present(.camera) } label: {
                    Label("Camera", systemImage: "camera")
                }
                .disabled(!isEnabled)
            }
            Button { present(.files) } label: {
                Label("Files", systemImage: "folder")
            }
        } label: {
            Image(systemName: "plus")
                .font(.title3)
                .foregroundStyle(T3Colors.textPrimary)
                .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        // The composer sits at the bottom, so the menu opens upward;
        // `.priority` ordering would flip the list and put Files on top.
        .menuOrder(.fixed)
    }

    /// Each presentation is driven by the one `activeSource`, so the sources
    /// stay mutually exclusive without three independent flags that can each be
    /// set while another is still on screen.
    private func presentationBinding(for source: Source) -> Binding<Bool> {
        Binding(
            get: { activeSource == source },
            set: { isPresented in
                if isPresented {
                    activeSource = source
                } else if activeSource == source {
                    activeSource = nil
                }
            }
        )
    }

    private func loadPhotoItems(_ items: [PhotosPickerItem]) {
        guard canAdd else { return }
        let selected = Array(items.prefix(remainingCount))
        let firstOrdinal = attachments.count + preparationState.pendingItemCount + 1
        let operation = preparationState.begin(itemCount: selected.count)

        Task {
            defer { preparationState.finish(operation) }
            for (offset, item) in selected.enumerated() {
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else {
                        throw FeatureImageAttachmentError.invalidImage
                    }
                    try await appendImage(data, ordinal: firstOrdinal + offset)
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private var remainingCount: Int {
        max(0, maximumCount - attachments.count)
    }

    /// Documents do not need a vision-capable model, so the picker opens even
    /// when images are refused; only the photo sources are withheld.
    private var canAdd: Bool {
        !preparationState.isPreparing && remainingCount > 0
    }

    private var attachmentAccessibilityLabel: String {
        if preparationState.isPreparing { return preparationState.statusLabel }
        if remainingCount == 0 { return "Attachment limit reached" }
        return "Add attachment"
    }

    private var attachmentAccessibilityHint: String {
        if remainingCount == 0 { return "Remove an attachment before adding another" }
        if !isEnabled { return "Attach a document; the selected model does not accept images" }
        return "Choose a photo, take a photo, or browse files"
    }

    private func present(_ source: Source) {
        // A menu dismisses itself before running its action, unlike the
        // confirmation dialog this replaced, which stayed the active presenter
        // and forced a deferred hand-off. Setting the cover directly means
        // nothing can cancel the presentation in between.
        guard canAdd else { return }
        activeSource = source
    }

    private func loadCapturedImage(_ image: UIImage) {
        activeSource = nil
        guard canAdd else { return }
        let operation = preparationState.begin(itemCount: 1)

        Task {
            defer { preparationState.finish(operation) }
            do {
                let data = try await Task.detached(priority: .userInitiated) {
                    guard let data = image.jpegData(compressionQuality: 0.94) else {
                        throw FeatureImageAttachmentError.encodingFailed
                    }
                    return data
                }.value
                try await appendImage(data)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Everything the document browser can hand back — PDFs, video, plain files
    /// and images alike. An image picked here is re-encoded through the image
    /// path so it keeps its thumbnail and its tighter cap; everything else is
    /// attached verbatim, because re-encoding a PDF would corrupt it.
    private func loadFiles(_ urls: [URL]) {
        guard !urls.isEmpty, canAdd else { return }
        let operation = preparationState.begin(itemCount: min(urls.count, remainingCount))

        Task {
            defer { preparationState.finish(operation) }
            for url in urls.prefix(remainingCount) {
                do {
                    let attachment = try await Task.detached(priority: .userInitiated) {
                        // Files handed over by the document browser live outside
                        // the app container and are only readable inside a
                        // security-scoped access window.
                        let hasAccess = url.startAccessingSecurityScopedResource()
                        defer {
                            if hasAccess { url.stopAccessingSecurityScopedResource() }
                        }
                        let data = try Data(contentsOf: url, options: .mappedIfSafe)
                        return try FeatureDocumentProcessor.attachment(from: data, url: url)
                    }.value
                    if ComposerAttachments.classify(
                        mimeType: attachment.mimeType,
                        name: attachment.filename
                    ) == .image, isEnabled {
                        try await appendImage(
                            attachment.data,
                            sourceMIMEType: attachment.mimeType
                        )
                    } else {
                        attachments.append(attachment)
                    }
                } catch {
                    errorMessage = error.localizedDescription
                    break
                }
            }
        }
    }

    private func appendImage(
        _ data: Data,
        ordinal: Int? = nil,
        sourceMIMEType: String? = nil
    ) async throws {
        let ordinal = ordinal ?? attachments.count + 1
        let attachment = try await Task.detached(priority: .userInitiated) {
            try FeatureImageProcessor.attachment(
                from: data,
                ordinal: ordinal,
                sourceMIMEType: sourceMIMEType
            )
        }.value
        attachments.append(attachment)
    }
}

/// An image the composer could not prepare. It stays in the strip as a tile
/// with Retry and Remove instead of vanishing, so a photo that failed to
/// download or decode is never dropped without the reader knowing.
struct FeatureAttachmentFailure: Identifiable, Equatable {
    enum Source: Equatable {
        /// Captured or already-loaded bytes that failed to process.
        case data(Data)
        /// A library pick whose bytes never arrived (an iCloud download, say).
        case photo(PhotosPickerItem)
    }

    let id = UUID()
    let source: Source
    let message: String
}

/// The draft's attachments as a row of tiles, followed by one failed tile per
/// image that could not be prepared and one spinner tile per item still being
/// prepared. Tapping a tile previews it with Quick Look.
struct FeatureAttachmentStrip: View {
    @Binding var attachments: [FeatureDraftAttachment]
    var pendingCount = 0
    var failures: [FeatureAttachmentFailure] = []
    var onRetry: (FeatureAttachmentFailure) -> Void = { _ in }
    var onRemoveFailure: (FeatureAttachmentFailure) -> Void = { _ in }

    @State private var previewURL: URL?

    var body: some View {
        if !attachments.isEmpty || pendingCount > 0 || !failures.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(attachments) { attachment in
                        FeatureAttachmentChip(
                            attachment: attachment,
                            onPreview: { preview(attachment) },
                            onRemove: { attachments.removeAll { $0.id == attachment.id } }
                        )
                    }
                    ForEach(failures) { failure in
                        FeatureAttachmentFailureTile(
                            failure: failure,
                            onRetry: { onRetry(failure) },
                            onRemove: { onRemoveFailure(failure) }
                        )
                    }
                    ForEach(0..<pendingCount, id: \.self) { _ in
                        FeatureAttachmentPendingTile()
                    }
                }
                .padding(.horizontal, 1)
            }
            .scrollIndicators(.hidden)
            .accessibilityLabel("\(attachments.count) attachments")
            .quickLookPreview($previewURL)
        }
    }

    /// Quick Look reads files, so the draft's bytes are written to a scratch
    /// copy under the attachment's own name first, off the main thread.
    private func preview(_ attachment: FeatureDraftAttachment) {
        let data = attachment.data
        let name = attachment.filename
        let folder = attachment.id.uuidString
        Task {
            let url = await Task.detached(priority: .userInitiated) { () -> URL? in
                let directory = FileManager.default.temporaryDirectory
                    .appendingPathComponent("attachment-previews", isDirectory: true)
                    .appendingPathComponent(folder, isDirectory: true)
                let file = directory.appendingPathComponent(name.isEmpty ? "Attachment" : name)
                do {
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try data.write(to: file, options: .atomic)
                    return file
                } catch {
                    return nil
                }
            }.value
            previewURL = url
        }
    }
}

/// Tile geometry shared by every tile kind, concentric with the r=26 composer
/// at its 12pt inset.
private enum FeatureAttachmentTileMetrics {
    static let side: CGFloat = 64
    static let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
}

/// The small remove control on a tile's corner, with a full 44pt target.
private struct FeatureAttachmentRemoveBadge: View {
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark.circle.fill")
                .font(.title3)
                .symbolRenderingMode(.palette)
                .foregroundStyle(T3Colors.background, T3Colors.textSecondary)
                .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .offset(x: 13, y: -13)
        .accessibilityLabel(label)
    }
}

private struct FeatureAttachmentPendingTile: View {
    var body: some View {
        ProgressView()
            .frame(width: FeatureAttachmentTileMetrics.side, height: FeatureAttachmentTileMetrics.side)
            .background(T3Colors.subtle, in: FeatureAttachmentTileMetrics.shape)
            .padding(.top, 11)
            .padding(.trailing, 11)
            .accessibilityLabel("Preparing attachment")
            .accessibilityIdentifier("attachment-preparing")
    }
}

private struct FeatureAttachmentFailureTile: View {
    let failure: FeatureAttachmentFailure
    let onRetry: () -> Void
    let onRemove: () -> Void

    var body: some View {
        Button(action: onRetry) {
            VStack(spacing: 4) {
                Image(systemName: "exclamationmark.circle")
                    .font(.title3)
                    .foregroundStyle(T3Colors.warning)
                Text("Retry")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(T3Colors.textPrimary)
            }
            .frame(width: FeatureAttachmentTileMetrics.side, height: FeatureAttachmentTileMetrics.side)
            .background(T3Colors.subtle, in: FeatureAttachmentTileMetrics.shape)
            .overlay {
                FeatureAttachmentTileMetrics.shape.strokeBorder(T3Colors.warning.opacity(0.5), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Couldn’t add image. Retry")
        .accessibilityHint(failure.message)
        .overlay(alignment: .topTrailing) {
            FeatureAttachmentRemoveBadge(label: "Remove failed image", action: onRemove)
        }
        .padding(.top, 11)
        .padding(.trailing, 11)
        .accessibilityIdentifier("composer-attachment-failed")
    }
}

/// SF Symbols for the attachment kinds, ported from `symbolForAttachment` in
/// apps/mobile/src/components/MessageAttachmentCard.tsx. Shared by the composer
/// strip and any sent-attachment card so one file reads the same in both places.
enum FeatureAttachmentGlyph {
    static func systemImage(mimeType: String, name: String = "") -> String {
        switch ComposerAttachments.classify(mimeType: mimeType, name: name) {
        case .image: return "photo"
        case .pdf: return "doc.richtext"
        case .video: return "film"
        case .file: break
        }
        let resolved = mimeType.lowercased()
        if resolved.hasPrefix("audio/") { return "waveform" }
        if resolved.contains("zip") || resolved.contains("tar") { return "doc.zipper" }
        return "doc"
    }
}

/// One pending attachment.
///
/// Images render their thumbnail; PDFs, video and generic files get a tile
/// carrying the kind glyph and the file name, sized like an image so the strip
/// keeps one rhythm. Handing a PDF to the image path is what left the composer
/// showing a placeholder that never resolved.
private struct FeatureAttachmentChip: View {
    let attachment: FeatureDraftAttachment
    let onPreview: () -> Void
    let onRemove: () -> Void
    @State private var image: UIImage?

    private var kind: ComposerAttachmentKind {
        ComposerAttachments.classify(
            mimeType: attachment.mimeType,
            name: attachment.filename
        )
    }

    var body: some View {
        Button(action: onPreview) {
            Group {
                if kind == .image {
                    if let image {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    } else {
                        Image(systemName: "photo")
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                } else {
                    documentTile
                }
            }
            .frame(width: FeatureAttachmentTileMetrics.side, height: FeatureAttachmentTileMetrics.side)
            .background(T3Colors.surface)
            .clipShape(FeatureAttachmentTileMetrics.shape)
            .contentShape(FeatureAttachmentTileMetrics.shape)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(attachment.filename)
        .accessibilityHint("Opens a preview")
        .contextMenu {
            Text(attachment.filename)
            Button("Preview", systemImage: "eye", action: onPreview)
            Button("Remove", systemImage: "trash", role: .destructive, action: onRemove)
        }
        .overlay(alignment: .topTrailing) {
            FeatureAttachmentRemoveBadge(label: "Remove \(attachment.filename)", action: onRemove)
        }
        .padding(.top, 11)
        .padding(.trailing, 11)
        .accessibilityIdentifier("composer-attachment-\(kind.rawValue)")
        .task(id: attachment.id) {
            guard kind == .image else { return }
            let data = attachment.thumbnailData ?? attachment.data
            image = await Task.detached(priority: .utility) {
                UIImage(data: data)
            }.value
        }
    }

    private var documentTile: some View {
        VStack(spacing: 3) {
            Image(
                systemName: FeatureAttachmentGlyph.systemImage(
                    mimeType: attachment.mimeType,
                    name: attachment.filename
                )
            )
            .font(.title3)
            Text(attachment.filename)
                .font(.caption2)
                .lineLimit(1)
                .truncationMode(.middle)
                .minimumScaleFactor(0.8)
        }
        .foregroundStyle(T3Colors.textSecondary)
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct FeatureCameraPicker: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.cameraCaptureMode = .photo
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        private let onCapture: (UIImage) -> Void
        private let onCancel: () -> Void

        init(onCapture: @escaping (UIImage) -> Void, onCancel: @escaping () -> Void) {
            self.onCapture = onCapture
            self.onCancel = onCancel
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage else {
                onCancel()
                return
            }
            onCapture(image)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }
    }
}

enum FeatureImageProcessor {
    private static let maximumDimension: CGFloat = 2_048
    private static let maximumEncodedBytes = 10 * 1_024 * 1_024

    /// - Parameter sourceMIMEType: the type the picker reported, when it had
    ///   one. Everything decodable is re-encoded to JPEG regardless, so this
    ///   only sharpens the failure: a type no provider reads (SVG) gets told so
    ///   instead of being reported as an unreadable photo.
    static func attachment(
        from sourceData: Data,
        ordinal: Int,
        sourceMIMEType: String? = nil
    ) throws -> FeatureDraftAttachment {
        guard let source = CGImageSourceCreateWithData(sourceData as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(
                  source,
                  0,
                  [
                      kCGImageSourceCreateThumbnailFromImageAlways: true,
                      kCGImageSourceCreateThumbnailWithTransform: true,
                      kCGImageSourceThumbnailMaxPixelSize: maximumDimension,
                      kCGImageSourceShouldCacheImmediately: true,
                  ] as CFDictionary
              ) else {
            throw FeatureImageAttachmentError.decodeFailure(sourceMIMEType: sourceMIMEType)
        }

        let preparedImage = UIImage(cgImage: image)
        guard let data = preparedImage.jpegData(compressionQuality: 0.82),
              let thumbnailData = thumbnail(from: preparedImage) else {
            throw FeatureImageAttachmentError.encodingFailed
        }
        guard data.count <= maximumEncodedBytes else {
            throw FeatureImageAttachmentError.tooLarge
        }

        return FeatureDraftAttachment(
            data: data,
            thumbnailData: thumbnailData,
            filename: "Image \(ordinal).jpg",
            mimeType: "image/jpeg"
        )
    }

    private static func thumbnail(from image: UIImage) -> Data? {
        let longestSide = max(image.size.width, image.size.height)
        let scale = min(1, 160 / longestSide)
        let size = CGSize(
            width: max(1, image.size.width * scale),
            height: max(1, image.size.height * scale)
        )
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }.jpegData(compressionQuality: 0.72)
    }
}

enum FeatureImageAttachmentError: LocalizedError, Equatable {
    case invalidImage
    case unsupportedImageType
    case encodingFailed
    case tooLarge

    /// A decode that failed on a type providers cannot read is a supported-type
    /// problem, not a corrupt file — the reader can act on the first and not on
    /// the second, so they get different copy.
    static func decodeFailure(sourceMIMEType: String?) -> FeatureImageAttachmentError {
        guard let sourceMIMEType,
              ComposerAttachments.classify(mimeType: sourceMIMEType) == .image,
              !ComposerAttachments.isSendableImageMIMEType(sourceMIMEType) else {
            return .invalidImage
        }
        return .unsupportedImageType
    }

    var errorDescription: String? {
        switch self {
        case .invalidImage:
            "That photo could not be read."
        case .unsupportedImageType:
            "That is not a supported image type. Attach GIF, JPEG, PNG, or WebP images."
        case .encodingFailed:
            "That photo could not be prepared."
        case .tooLarge:
            "Images must be smaller than 10 MB."
        }
    }
}

/// Turns a picked file into a draft attachment without re-encoding it.
///
/// The size cap comes from the classified kind rather than a single constant:
/// the contract gives PDFs, video and generic files 50 MB while images keep the
/// tighter 10 MB limit, and validating here means a rejection is a picker error
/// instead of a failed turn.
enum FeatureDocumentProcessor {
    static func attachment(from data: Data, url: URL) throws -> FeatureDraftAttachment {
        let name = url.lastPathComponent.isEmpty ? "file" : url.lastPathComponent
        let mimeType = resolveMIMEType(for: url, name: name)
        let kind = ComposerAttachments.classify(mimeType: mimeType, name: name)
        guard !data.isEmpty else { throw FeatureDocumentAttachmentError.empty(name: name) }
        let maximumBytes = ComposerAttachments.maximumBytes(for: kind)
        guard data.count <= maximumBytes else {
            throw FeatureDocumentAttachmentError.tooLarge(
                name: name,
                maximumBytes: maximumBytes
            )
        }
        return FeatureDraftAttachment(data: data, filename: name, mimeType: mimeType)
    }

    /// The document browser hands back a URL and nothing else, so the type comes
    /// from the extension. The shared classifier's table is the fallback so a
    /// type UniformTypeIdentifiers does not know still lands where web puts it.
    static func resolveMIMEType(for url: URL, name: String) -> String {
        if let mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType {
            return mimeType
        }
        return ComposerAttachments.inferMIMEType(fromFileName: name) ?? "application/octet-stream"
    }
}

enum FeatureDocumentAttachmentError: LocalizedError, Equatable {
    case empty(name: String)
    case tooLarge(name: String, maximumBytes: Int)

    var errorDescription: String? {
        switch self {
        case let .empty(name):
            "‘\(name)’ is empty."
        case let .tooLarge(name, maximumBytes):
            "‘\(name)’ is larger than \(maximumBytes / (1_024 * 1_024)) MB."
        }
    }
}

/// NSItemProvider deletes its temporary file as soon as the callback returns.
/// Read and process inside that callback, never pass the temporary URL to a Task.
enum FeatureDroppedAttachment {
    static func presentationURL(temporaryURL: URL, suggestedName: String?, typeIdentifier: String) -> URL {
        let suggested = suggestedName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = suggested.flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0).lastPathComponent } ?? temporaryURL.lastPathComponent
        var result = URL(fileURLWithPath: name.isEmpty ? "Attachment" : name)
        if result.pathExtension.isEmpty, let suffix = UTType(typeIdentifier)?.preferredFilenameExtension {
            result.appendPathExtension(suffix)
        }
        return result
    }

    static func load(_ provider: NSItemProvider, typeIdentifier: String) async throws -> FeatureDraftAttachment {
        let suggestedName = provider.suggestedName
        return try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, error in
                do {
                    if let error { throw error }
                    guard let url else { throw CocoaError(.fileReadUnknown) }
                    let maximum = 50 * 1_024 * 1_024
                    let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                    guard values.isRegularFile == true else { throw CocoaError(.fileReadUnsupportedScheme) }
                    guard (values.fileSize ?? 0) <= maximum else {
                        throw FeatureDocumentAttachmentError.tooLarge(name: url.lastPathComponent, maximumBytes: maximum)
                    }
                    let data = try Data(contentsOf: url, options: .mappedIfSafe)
                    let namedURL = presentationURL(temporaryURL: url, suggestedName: suggestedName, typeIdentifier: typeIdentifier)
                    let document = try FeatureDocumentProcessor.attachment(from: data, url: namedURL)
                    if ComposerAttachments.classify(mimeType: document.mimeType, name: document.filename) == .image {
                        var image = try FeatureImageProcessor.attachment(from: data, ordinal: 1, sourceMIMEType: document.mimeType)
                        image.filename = namedURL.deletingPathExtension().lastPathComponent + ".jpg"
                        continuation.resume(returning: image)
                    } else {
                        continuation.resume(returning: document)
                    }
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
}
