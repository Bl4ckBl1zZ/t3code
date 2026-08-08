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

/// The attachment sources, shared with the composer so its in-pill morph menu
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
    /// The composer's morph menu asks for a source through this binding rather
    /// than by calling into the view: the presentations live here, and the
    /// menu's buttons live in the pill this view is hidden behind.
    @Binding var requestedSource: FeatureAttachmentSource?
    /// Set when the composer owns an in-pill morph menu: the plus toggles that
    /// menu instead of opening a system context menu.
    let onToggleMenu: (() -> Void)?
    let isMenuOpen: Bool
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
        onToggleMenu: (() -> Void)? = nil,
        isMenuOpen: Bool = false,
        maximumCount: Int = 8,
        isEnabled: Bool = true
    ) {
        _attachments = attachments
        _preparationState = preparationState
        _isPresentingSource = isPresentingSource
        _requestedSource = requestedSource
        self.onToggleMenu = onToggleMenu
        self.isMenuOpen = isMenuOpen
        self.maximumCount = maximumCount
        self.isEnabled = isEnabled
    }

    /// Matches the send button's disc so the two ends of the composer toolbar
    /// read as one control set: a glass secondary next to a filled primary.

    var body: some View {
        control
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

    /// The plus. With a composer-owned morph menu it is a plain toggle that
    /// rotates into an X while the menu is up; without one it falls back to a
    /// system context menu.
    @ViewBuilder
    private var control: some View {
        if let onToggleMenu {
            Button(action: onToggleMenu) {
                glyph
                    .rotationEffect(.degrees(isMenuOpen ? 45 : 0))
                    .animation(
                        .spring(response: 0.32, dampingFraction: 0.72),
                        value: isMenuOpen
                    )
            }
        } else {
            Menu {
                Button { present(.photoLibrary) } label: {
                    Label("Photo Library", systemImage: "photo.on.rectangle")
                }
                .disabled(!isEnabled)
                Button { present(.camera) } label: {
                    Label("Camera", systemImage: "camera")
                }
                .disabled(!isEnabled || !Source.cameraAvailable)
                Button { present(.files) } label: {
                    Label("Files", systemImage: "folder")
                }
            } label: {
                glyph
            }
            // The composer sits at the bottom, so the menu opens upward;
            // `.priority` ordering would flip the list and put Files on top.
            .menuOrder(.fixed)
        }
    }

    /// A bare glyph, not a chip: the plus is the pill's quietest control and
    /// any container around it competes with the send circle at the other end
    /// of the row.
    private var glyph: some View {
        Image(systemName: preparationState.isPreparing ? "hourglass" : "plus")
            .font(.system(size: 21, weight: .regular))
            .foregroundStyle(T3Colors.textPrimary)
            .contentTransition(.symbolEffect(.replace))
            .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
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
