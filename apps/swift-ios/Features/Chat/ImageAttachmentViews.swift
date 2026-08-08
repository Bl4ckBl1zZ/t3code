import ImageIO
import PhotosUI
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

struct FeatureImageAttachmentPicker: View {
    private enum Source {
        case photoLibrary
        case camera
        case files
    }

    @Binding var attachments: [FeatureDraftAttachment]
    @Binding var preparationState: FeatureAttachmentPreparationState
    let maximumCount: Int
    /// Whether the selected model accepts *images*. Documents are read off disk
    /// by the agent rather than sent to the vision endpoint, so they stay
    /// available on a text-only model.
    let isEnabled: Bool

    @State private var isPhotoLibraryPresented = false
    @State private var isCameraPresented = false
    @State private var isDocumentPickerPresented = false
    @State private var sourcePresentationTask: Task<Void, Never>?
    @State private var errorMessage: String?

    init(
        attachments: Binding<[FeatureDraftAttachment]>,
        preparationState: Binding<FeatureAttachmentPreparationState>,
        maximumCount: Int = 8,
        isEnabled: Bool = true
    ) {
        _attachments = attachments
        _preparationState = preparationState
        self.maximumCount = maximumCount
        self.isEnabled = isEnabled
    }

    /// Matches the send button's disc so the two ends of the composer toolbar
    /// read as one control set: a glass secondary next to a filled primary.
    private var glyphShape: Circle { Circle() }

    var body: some View {
        Menu {
            Button { present(.photoLibrary) } label: {
                Label("Photo Library", systemImage: "photo.on.rectangle")
            }
            .disabled(!isEnabled)
            Button { present(.camera) } label: {
                Label("Camera", systemImage: "camera")
            }
            .disabled(!isEnabled || !UIImagePickerController.isSourceTypeAvailable(.camera))
            Button { present(.files) } label: {
                Label("Files", systemImage: "folder")
            }
        } label: {
            Image(systemName: preparationState.isPreparing ? "hourglass" : "paperclip")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(T3Colors.textSecondary)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 34, height: 34)
                // Liquid Glass on iOS 26, the closest pre-glass material below
                // it. `.clear` because this floats over the draft the user is
                // reading rather than over chrome.
                .t3GlassEffect(.clear, in: glyphShape)
                // A material alone all but disappears against the composer's own
                // fill, so the rim is what makes the control legible on both
                // paths.
                .overlay { glyphShape.stroke(T3Colors.inputBorder, lineWidth: 1) }
                .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        // The composer sits at the bottom, so the menu opens upward; `.priority`
        // ordering would flip the list and put Files on top.
        .menuOrder(.fixed)
        .buttonStyle(.plain)
        .animation(
            .spring(response: 0.32, dampingFraction: 0.72),
            value: preparationState.isPreparing
        )
        .disabled(!canAdd)
        .opacity(canAdd ? 1 : 0.3)
        .accessibilityLabel(attachmentAccessibilityLabel)
        .accessibilityIdentifier("image-attachment-picker")
        .accessibilityHint(attachmentAccessibilityHint)
        .fullScreenCover(isPresented: $isPhotoLibraryPresented) {
            FeaturePhotoLibraryPicker(
                maximumCount: max(1, remainingCount),
                onSelect: { images in
                    isPhotoLibraryPresented = false
                    loadPhotoSelections(images)
                },
                onCancel: { isPhotoLibraryPresented = false }
            )
            .ignoresSafeArea()
        }
        .fullScreenCover(isPresented: $isCameraPresented) {
            FeatureCameraPicker(
                onCapture: loadCapturedImage,
                onCancel: { isCameraPresented = false }
            )
            .ignoresSafeArea()
        }
        .fullScreenCover(isPresented: $isDocumentPickerPresented) {
            FeatureDocumentPicker(
                maximumCount: max(1, remainingCount),
                onSelect: { urls in
                    isDocumentPickerPresented = false
                    loadFiles(urls)
                },
                onCancel: { isDocumentPickerPresented = false }
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
        .onDisappear {
            sourcePresentationTask?.cancel()
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
        sourcePresentationTask?.cancel()
        sourcePresentationTask = Task { @MainActor in
            // The menu is still the active presenter while its action runs. Wait
            // for its dismissal animation before presenting another controller or
            // UIKit can reject (or race) the new presentation.
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled, canAdd else { return }
            switch source {
            case .photoLibrary:
                isPhotoLibraryPresented = true
            case .camera:
                isCameraPresented = true
            case .files:
                isDocumentPickerPresented = true
            }
        }
    }

    private func loadPhotoSelections(_ images: [Data]) {
        guard !images.isEmpty, canAdd else { return }
        let selected = Array(images.prefix(remainingCount))
        let firstOrdinal = attachments.count + preparationState.pendingItemCount + 1
        let operation = preparationState.begin(itemCount: selected.count)

        Task {
            defer { preparationState.finish(operation) }
            for (offset, data) in selected.enumerated() {
                do {
                    try await appendImage(data, ordinal: firstOrdinal + offset)
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func loadCapturedImage(_ image: UIImage) {
        isCameraPresented = false
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
                        try await appendImage(attachment.data)
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

    private func appendImage(_ data: Data, ordinal: Int? = nil) async throws {
        let ordinal = ordinal ?? attachments.count + 1
        let attachment = try await Task.detached(priority: .userInitiated) {
            try FeatureImageProcessor.attachment(from: data, ordinal: ordinal)
        }.value
        attachments.append(attachment)
    }
}

/// The system document browser.
///
/// Ported from `pickComposerDocuments` in apps/mobile/src/lib/composerDocuments.ts:
/// the type filter is deliberately unrestricted so PDFs, video and arbitrary
/// documents share one affordance. The server validates the MIME against the
/// contract, so a second allowlist here could only drift from it.
private struct FeatureDocumentPicker: UIViewControllerRepresentable {
    let maximumCount: Int
    let onSelect: ([URL]) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(maximumCount: maximumCount, onSelect: onSelect, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        // `asCopy` puts a readable copy in the app's temporary directory, which
        // is what makes the bytes available after the picker is dismissed.
        let controller = UIDocumentPickerViewController(
            forOpeningContentTypes: [.item],
            asCopy: true
        )
        controller.allowsMultipleSelection = maximumCount > 1
        controller.shouldShowFileExtensions = true
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        private let maximumCount: Int
        private let onSelect: ([URL]) -> Void
        private let onCancel: () -> Void

        init(
            maximumCount: Int,
            onSelect: @escaping ([URL]) -> Void,
            onCancel: @escaping () -> Void
        ) {
            self.maximumCount = maximumCount
            self.onSelect = onSelect
            self.onCancel = onCancel
        }

        func documentPicker(
            _ controller: UIDocumentPickerViewController,
            didPickDocumentsAt urls: [URL]
        ) {
            guard !urls.isEmpty else {
                onCancel()
                return
            }
            onSelect(Array(urls.prefix(maximumCount)))
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            onCancel()
        }
    }
}

struct FeaturePhotoLibraryItem: @unchecked Sendable {
    let provider: NSItemProvider

    func loadData() async throws -> Data {
        guard let typeIdentifier = provider.registeredTypeIdentifiers.first(where: { identifier in
            UTType(identifier)?.conforms(to: .image) == true
        }) else {
            throw FeatureImageAttachmentError.invalidImage
        }

        return try await withCheckedThrowingContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, error in
                if let data {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(
                        throwing: error ?? FeatureImageAttachmentError.encodingFailed
                    )
                }
            }
        }
    }
}

private struct FeaturePhotoLibraryPicker: UIViewControllerRepresentable {
    let maximumCount: Int
    let onSelect: ([Data]) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSelect: onSelect, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.filter = .images
        configuration.selectionLimit = maximumCount
        // The composer always normalizes uploads to JPEG, so asking Photos for
        // a compatible representation avoids slow RAW/HEIF materialization.
        configuration.preferredAssetRepresentationMode = .compatible
        let controller = PHPickerViewController(configuration: configuration)
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        private let onSelect: ([Data]) -> Void
        private let onCancel: () -> Void
        private var didFinish = false

        init(
            onSelect: @escaping ([Data]) -> Void,
            onCancel: @escaping () -> Void
        ) {
            self.onSelect = onSelect
            self.onCancel = onCancel
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard !didFinish else { return }
            didFinish = true
            guard !results.isEmpty else {
                Task { @MainActor in
                    await Task.yield()
                    onCancel()
                }
                return
            }

            // Keep the picker and its item providers alive until Photos has
            // materialized every selection. Dismissing the SwiftUI cover from
            // inside this delegate callback can tear down PhotosUI while its
            // provider transition is still in flight.
            picker.view.isUserInteractionEnabled = false
            let activity = UIActivityIndicatorView(style: .large)
            activity.translatesAutoresizingMaskIntoConstraints = false
            activity.startAnimating()
            picker.view.addSubview(activity)
            NSLayoutConstraint.activate([
                activity.centerXAnchor.constraint(equalTo: picker.view.centerXAnchor),
                activity.centerYAnchor.constraint(equalTo: picker.view.centerYAnchor),
            ])

            let items = results.map { FeaturePhotoLibraryItem(provider: $0.itemProvider) }
            Task { @MainActor in
                var images: [Data] = []
                for item in items {
                    if let data = try? await item.loadData() {
                        images.append(data)
                    }
                }
                onSelect(images)
            }
        }
    }
}

struct FeatureAttachmentStrip: View {
    @Binding var attachments: [FeatureDraftAttachment]

    var body: some View {
        if !attachments.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(attachments) { attachment in
                        FeatureAttachmentChip(attachment: attachment) {
                            attachments.removeAll { $0.id == attachment.id }
                        }
                    }
                }
                .padding(.horizontal, 1)
            }
            .scrollIndicators(.hidden)
            .accessibilityLabel("\(attachments.count) attachments")
        }
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
    let onRemove: () -> Void
    @State private var image: UIImage?

    private var kind: ComposerAttachmentKind {
        ComposerAttachments.classify(
            mimeType: attachment.mimeType,
            name: attachment.filename
        )
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
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
            .frame(width: 58, height: 58)
            .background(T3Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 22, height: 22)
                    .background(.black.opacity(0.78), in: Circle())
                    .frame(
                        width: T3Metrics.minimumTapTarget,
                        height: T3Metrics.minimumTapTarget
                    )
                    .contentShape(Rectangle())
            }
            .offset(x: 11, y: -11)
            .accessibilityLabel("Remove \(attachment.filename)")
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
            .font(.system(size: 17, weight: .medium))
            Text(attachment.filename)
                .font(.system(size: 9, weight: .medium))
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .truncationMode(.middle)
        }
        .foregroundStyle(T3Colors.textSecondary)
        .padding(.horizontal, 5)
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

    static func attachment(
        from sourceData: Data,
        ordinal: Int
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
            throw FeatureImageAttachmentError.invalidImage
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

enum FeatureImageAttachmentError: LocalizedError {
    case invalidImage
    case encodingFailed
    case tooLarge

    var errorDescription: String? {
        switch self {
        case .invalidImage:
            "That photo could not be read."
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
/// the contract gives PDFs, video and generic files 20 MB while images keep the
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
