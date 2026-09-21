import LinkPresentation
import SwiftUI
import UIKit

final class T3ShareViewController: UIViewController {
    private var hostingController: UIHostingController<T3ShareExtensionView>?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground

        let content = T3ShareExtensionView(
            load: { [weak self] in
                await T3SharePayloadLoader.load(from: self?.extensionContext?.inputItems ?? [])
            },
            save: { payload, note in
                try await Task.detached {
                    try T3IncomingShareStore.write(
                        textFragments: note.isEmpty ? payload.textFragments : [note] + payload.textFragments,
                        attachments: payload.attachments,
                        warnings: payload.warnings
                    )
                }.value
            },
            cancel: { [weak self] payload in
                // Staged copies are only cleaned up by a save; a cancelled
                // share removes its own.
                for attachment in payload?.attachments ?? [] {
                    try? FileManager.default.removeItem(at: attachment.stagedFileURL)
                }
                self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
            },
            complete: { [weak self] in
                self?.extensionContext?.completeRequest(returningItems: nil)
            }
        )
        let hostingController = UIHostingController(rootView: content)
        hostingController.view.backgroundColor = .clear
        addChild(hostingController)
        hostingController.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hostingController.view)
        NSLayoutConstraint.activate([
            hostingController.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hostingController.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hostingController.view.topAnchor.constraint(equalTo: view.topAnchor),
            hostingController.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        hostingController.didMove(toParent: self)
        self.hostingController = hostingController
    }
}

/// The share sheet: a preview of what is being shared, an optional note that
/// becomes the start of the task prompt, and one confirm that saves and closes.
struct T3ShareExtensionView: View {
    enum Phase: Equatable {
        case loading
        case ready
        case saving
        case saved
        case failed(message: String, canRetry: Bool)
    }

    let load: () async -> T3LoadedSharePayload
    let save: (T3LoadedSharePayload, String) async throws -> T3IncomingShareEnvelope
    let cancel: (T3LoadedSharePayload?) -> Void
    let complete: () -> Void

    @State private var phase = Phase.loading
    @State private var payload: T3LoadedSharePayload?
    @State private var note = ""

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("T3 Code")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { cancelButton }
                    ToolbarItem(placement: .confirmationAction) { confirmButton }
                }
                .overlay {
                    if phase == .saved { savedConfirmation }
                }
        }
        .sensoryFeedback(.success, trigger: phase == .saved)
        .task { await reload() }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            ProgressView("Preparing…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message, canRetry):
            ContentUnavailableView {
                Label("Couldn't Add This", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                if canRetry {
                    Button("Try Again") { Task { await reload() } }
                        .buttonStyle(.bordered)
                }
            }
        case .ready, .saving, .saved:
            if let payload, payload.hasContent {
                form(payload)
            } else {
                ContentUnavailableView(
                    "Nothing to Add",
                    systemImage: "tray",
                    description: Text(T3IncomingShareStoreError.noSupportedContent.errorDescription ?? "")
                )
            }
        }
    }

    private func form(_ payload: T3LoadedSharePayload) -> some View {
        Form {
            Section {
                TextField("Add a note for the agent", text: $note, axis: .vertical)
                    .lineLimit(2...6)
            } footer: {
                Text("Choose a project in T3 Code to start the task.")
            }

            if let url = payload.sharedURL {
                Section {
                    T3SharedLinkPreview(url: url)
                        .frame(minHeight: 64)
                        .listRowInsets(EdgeInsets())
                }
            }

            if let text = payload.sharedText {
                Section("Text") {
                    Text(text)
                        .font(.callout)
                        .lineLimit(3)
                        .foregroundStyle(.secondary)
                }
            }

            if !payload.attachments.isEmpty {
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(payload.attachments, id: \.stagedFileURL) { attachment in
                                T3SharedAttachmentTile(attachment: attachment)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                } header: {
                    Text(payload.attachmentSummary)
                } footer: {
                    if !payload.warnings.isEmpty {
                        Text(payload.warnings.joined(separator: "\n"))
                    }
                }
            } else if !payload.warnings.isEmpty {
                Section {} footer: {
                    Text(payload.warnings.joined(separator: "\n"))
                }
            }
        }
        .disabled(phase == .saving || phase == .saved)
    }

    @ViewBuilder
    private var cancelButton: some View {
        if #available(iOS 26, *) {
            Button(role: .cancel) { cancel(payload) }
                .disabled(phase == .saving || phase == .saved)
        } else {
            Button("Cancel", role: .cancel) { cancel(payload) }
                .disabled(phase == .saving || phase == .saved)
        }
    }

    @ViewBuilder
    private var confirmButton: some View {
        if phase == .saving || phase == .saved {
            ProgressView()
                .accessibilityLabel("Adding to T3 Code")
        } else if #available(iOS 26, *) {
            Button(role: .confirm, action: confirm) {
                Label("Add to T3 Code", systemImage: "checkmark")
            }
            .disabled(!canConfirm)
        } else {
            Button(action: confirm) {
                Text("Add").fontWeight(.semibold)
            }
            .disabled(!canConfirm)
        }
    }

    private var savedConfirmation: some View {
        Label("Added to T3 Code", systemImage: "checkmark.circle.fill")
            .font(.headline)
            .symbolRenderingMode(.hierarchical)
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .modifier(T3ShareGlassCapsule())
            .transition(.opacity.combined(with: .scale(scale: 0.96)))
            .accessibilityAddTraits(.isStaticText)
    }

    private var canConfirm: Bool {
        phase == .ready && payload?.hasContent == true
    }

    private func reload() async {
        phase = .loading
        payload = await load()
        phase = .ready
    }

    private func confirm() {
        guard canConfirm, let payload else { return }
        phase = .saving
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                _ = try await save(payload, trimmedNote)
                withAnimation(.easeOut(duration: 0.2)) { phase = .saved }
                try? await Task.sleep(for: .milliseconds(800))
                complete()
            } catch {
                // A save consumes the staged copies, so a retry loads again.
                self.payload = nil
                phase = .failed(
                    message: (error as? LocalizedError)?.errorDescription
                        ?? "The shared content could not be saved.",
                    canRetry: T3ShareFailure.canRetry(error)
                )
            }
        }
    }
}

/// Which save failures a second attempt can fix. Content the app never
/// provided will not appear on a retry; storage trouble might clear up.
enum T3ShareFailure {
    static func canRetry(_ error: Error) -> Bool {
        if case T3IncomingShareStoreError.noSupportedContent = error { return false }
        return true
    }
}

extension T3LoadedSharePayload {
    var hasContent: Bool {
        !attachments.isEmpty || textFragments.contains {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    /// The first shared web link, shown as a link card.
    var sharedURL: URL? {
        textFragments.lazy.compactMap { fragment -> URL? in
            let trimmed = fragment.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.contains(where: \.isWhitespace),
                  let url = URL(string: trimmed),
                  url.scheme == "https" || url.scheme == "http" else { return nil }
            return url
        }.first
    }

    /// Shared text other than the link, as a short excerpt.
    var sharedText: String? {
        let link = sharedURL?.absoluteString
        let text = textFragments
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0 != link }
            .joined(separator: "\n\n")
        return text.isEmpty ? nil : text
    }

    /// "3 files · 4.2 MB".
    var attachmentSummary: String {
        let count = attachments.count
        let noun = count == 1 ? "1 file" : "\(count) files"
        let bytes = attachments.reduce(0) { $0 + $1.byteCount }
        return "\(noun) · \(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))"
    }
}

/// A shared file: a thumbnail for images, the file's name otherwise.
private struct T3SharedAttachmentTile: View {
    let attachment: T3PendingShareAttachment
    @State private var thumbnail: UIImage?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(uiColor: .tertiarySystemFill))
            if let thumbnail {
                Image(uiImage: thumbnail)
                    .resizable()
                    .scaledToFill()
            } else {
                VStack(spacing: 4) {
                    Image(systemName: attachment.isImage ? "photo" : "doc")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text(attachment.suggestedName ?? "File")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 4)
                }
            }
        }
        .frame(width: 72, height: 72)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(attachment.suggestedName ?? (attachment.isImage ? "Image" : "File"))
        .task {
            guard attachment.isImage else { return }
            let url = attachment.stagedFileURL
            thumbnail = await Task.detached {
                UIImage(contentsOfFile: url.path)?.preparingThumbnail(of: CGSize(width: 144, height: 144))
            }.value
        }
    }
}

/// The system link card, filled in once the page's metadata arrives.
private struct T3SharedLinkPreview: UIViewRepresentable {
    let url: URL

    func makeUIView(context _: Context) -> LPLinkView {
        let view = LPLinkView(url: url)
        let provider = LPMetadataProvider()
        provider.timeout = 5
        provider.startFetchingMetadata(for: url) { metadata, _ in
            guard let metadata else { return }
            DispatchQueue.main.async { view.metadata = metadata }
        }
        return view
    }

    func updateUIView(_: LPLinkView, context _: Context) {}
}

/// Glass on iOS 26, a material capsule before.
private struct T3ShareGlassCapsule: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.glassEffect(.regular, in: Capsule())
        } else {
            content.background(.regularMaterial, in: Capsule())
        }
    }
}
