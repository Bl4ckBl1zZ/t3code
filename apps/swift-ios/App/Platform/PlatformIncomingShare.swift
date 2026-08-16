import Foundation
import Observation
import SwiftUI

enum PlatformIncomingShareError: LocalizedError, Equatable {
    case missingAttachment(String)
    case invalidAttachment(String)
    case invalidEnvelope

    var errorDescription: String? {
        switch self {
        case let .missingAttachment(name):
            "The shared file \(name) is no longer available. Share it again to retry."
        case let .invalidAttachment(name):
            "The shared file \(name) is incomplete or too large. Share it again to retry."
        case .invalidEnvelope:
            "This shared item is invalid. Share it again to retry."
        }
    }
}

/// The client-side attachment rule set, applied to shared files.
///
/// Ported from `validateComposerAttachment` in
/// packages/shared/src/composerAttachments.ts by way of
/// apps/mobile/src/features/sharing/incoming-share-model.ts. Classification and
/// the byte caps come from `ComposerAttachments`, which already carries the
/// shared tables — this only adds the three rejections that survive the move to
/// workspace-materialized uploads: unusable name, empty file, over cap.
/// Anything else (audio, archives, extensionless blobs) is the agent's to open.
enum PlatformIncomingShareValidation {
    struct Accepted: Equatable, Sendable {
        let kind: ComposerAttachmentKind
        let mimeType: String
        let name: String
    }

    enum Outcome: Equatable, Sendable {
        case accepted(Accepted)
        case rejected(String)
    }

    static let maximumNameLength = 255
    static let maximumMIMETypeLength = 100

    /// Runs against the manifest's declared size, before the file is read: no
    /// reason to map 30 MB into memory just to reject it.
    static func validate(fileName: String, mimeType: String, byteCount: Int) -> Outcome {
        let name = sanitizedName(fileName)
        guard !name.isEmpty else {
            return .rejected("Attachment names must be plain file names.")
        }

        let supplied = mimeType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let resolved = supplied.isEmpty
            ? (ComposerAttachments.inferMIMEType(fromFileName: name) ?? "application/octet-stream")
            : supplied
        guard resolved.count <= maximumMIMETypeLength, isWellFormedMIMEType(resolved) else {
            return .rejected("'\(name)' has no usable file type and wasn't attached.")
        }

        // Zero bytes is both a useless upload and the practical directory-drop
        // guard: a shared folder surfaces as an empty, typeless file.
        guard byteCount > 0 else {
            return .rejected("'\(name)' is empty and wasn't attached.")
        }

        let kind = ComposerAttachments.classify(mimeType: resolved, name: name)
        let maximumBytes = ComposerAttachments.maximumBytes(for: kind)
        guard byteCount <= maximumBytes else {
            let limit = "\(Int((Double(maximumBytes) / (1_024 * 1_024)).rounded())) MB"
            let actual = formattedSize(byteCount)
            let subject = kind == .image ? "an image" : "a file"
            // Just over the cap rounds to the same number as the cap, and
            // "is 10 MB — over the 10 MB limit" reads like a bug.
            return .rejected(
                actual == limit
                    ? "'\(name)' is over the \(limit) limit for \(subject)."
                    : "'\(name)' is \(actual) — over the \(limit) limit for \(subject)."
            )
        }

        return .accepted(Accepted(kind: kind, mimeType: resolved, name: name))
    }

    /// Bidi overrides let `report.pdf<RLO>gpj.exe` render as `report.pdfexe.jpg`
    /// in a chip the user is about to trust. Strip them, plus control
    /// characters and path separators, everywhere.
    static func sanitizedName(_ rawName: String) -> String {
        let bidiControls: Set<Unicode.Scalar> = [
            "\u{200E}", "\u{200F}", "\u{202A}", "\u{202B}", "\u{202C}", "\u{202D}", "\u{202E}",
            "\u{2066}", "\u{2067}", "\u{2068}", "\u{2069}",
        ]
        var scalars = String.UnicodeScalarView()
        for scalar in rawName.precomposedStringWithCanonicalMapping.unicodeScalars {
            if bidiControls.contains(scalar) { continue }
            if scalar.value <= 0x1F || scalar.value == 0x7F { continue }
            scalars.append(scalar == "/" || scalar == "\\" ? "-" : scalar)
        }
        let name = String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)
        if name == "." || name == ".." { return "file" }
        guard name.count > maximumNameLength else { return name }
        return truncatePreservingExtension(name, maximumCharacters: maximumNameLength)
    }

    /// Human-readable byte size. Base-1024 to match the MiB caps it reports against.
    static func formattedSize(_ bytes: Int) -> String {
        guard bytes > 0 else { return "0 B" }
        if bytes < 1_024 { return "\(bytes) B" }
        let kilobytes = Double(bytes) / 1_024
        if kilobytes < 1_024 { return "\(Int(kilobytes.rounded())) KB" }
        let megabytes = kilobytes / 1_024
        if megabytes < 1_024 {
            return megabytes < 10
                ? String(format: "%.1f MB", megabytes)
                : "\(Int(megabytes.rounded())) MB"
        }
        return String(format: "%.1f GB", megabytes / 1_024)
    }

    /// Splits a trailing extension only when it looks like one: a 40-character
    /// "extension" is a filename with a dot in it, and treating it as an
    /// extension would truncate away the informative part of the name.
    static func splitFileExtension(_ name: String) -> (base: String, extension: String) {
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else {
            return (name, "")
        }
        let candidate = name[name.index(after: dot)...]
        let isAlphanumericASCII = { (character: Character) in
            character.isASCII && (character.isLetter || character.isNumber)
        }
        guard !candidate.isEmpty,
              candidate.count <= 16,
              candidate.allSatisfy(isAlphanumericASCII) else {
            return (name, "")
        }
        return (String(name[name.startIndex..<dot]), String(name[dot...]))
    }

    private static func truncatePreservingExtension(
        _ name: String,
        maximumCharacters: Int
    ) -> String {
        let split = splitFileExtension(name)
        let budget = maximumCharacters - split.extension.count
        guard budget > 0 else { return String(name.prefix(maximumCharacters)) }
        return String(split.base.prefix(budget)) + split.extension
    }

    private static func isWellFormedMIMEType(_ value: String) -> Bool {
        let parts = value.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return false }
        return parts.allSatisfy(isWellFormedMIMEToken)
    }

    private static func isWellFormedMIMEToken(_ token: Substring) -> Bool {
        guard let first = token.first, first.isASCII, first.isLetter || first.isNumber else {
            return false
        }
        let extra: Set<Character> = ["!", "#", "$", "&", "^", "_", ".", "+", "-"]
        return token.allSatisfy { character in
            guard character.isASCII else { return false }
            return character.isLetter || character.isNumber || extra.contains(character)
        }
    }
}

struct PlatformIncomingShareSource: Sendable {
    var loadAll: @Sendable () async -> [T3IncomingShareEnvelope]
    var data: @Sendable (T3IncomingShareAttachment) async throws -> Data
    var remove: @Sendable (String) async throws -> Void

    static let live = PlatformIncomingShareSource(
        loadAll: {
            await Task.detached(priority: .utility) {
                T3IncomingShareStore.loadAll()
            }.value
        },
        data: { attachment in
            guard let root = T3SharedContainer.rootURL?.standardizedFileURL,
                  let url = T3IncomingShareStore.fileURL(for: attachment)?.standardizedFileURL,
                  url.path.hasPrefix(root.path + "/") else {
                throw PlatformIncomingShareError.missingAttachment(attachment.fileName)
            }
            let data = try await Task.detached(priority: .userInitiated) {
                guard FileManager.default.fileExists(atPath: url.path) else {
                    throw PlatformIncomingShareError.missingAttachment(attachment.fileName)
                }
                return try Data(contentsOf: url, options: .mappedIfSafe)
            }.value
            // The cap follows the kind, so a video keeps the looser file limit
            // and an image keeps the tighter one.
            let kind = ComposerAttachments.classify(
                mimeType: attachment.mimeType,
                name: attachment.fileName
            )
            guard !data.isEmpty,
                  data.count <= ComposerAttachments.maximumBytes(for: kind),
                  data.count == attachment.byteCount else {
                throw PlatformIncomingShareError.invalidAttachment(attachment.fileName)
            }
            return data
        },
        remove: { id in
            guard UUID(uuidString: id) != nil else {
                throw PlatformIncomingShareError.invalidEnvelope
            }
            try await Task.detached(priority: .utility) {
                try T3IncomingShareStore.remove(id: id)
            }.value
        }
    )
}

struct PlatformIncomingShareDraftRepository: Sendable {
    var importContent: @Sendable (
        _ shareID: String,
        _ text: String,
        _ attachments: [FeatureDraftAttachment],
        _ key: String,
        _ maximumAttachmentCount: Int
    ) async throws -> FeatureComposerDraft

    static let live = PlatformIncomingShareDraftRepository(
        importContent: { shareID, text, attachments, key, maximumAttachmentCount in
            try await FeatureComposerDraftStore.shared.importSharedContent(
                shareID: shareID,
                text: text,
                attachments: attachments,
                for: key,
                maximumAttachmentCount: maximumAttachmentCount
            )
        }
    )
}

struct PlatformIncomingShareImport: Sendable, Equatable {
    var draft: FeatureComposerDraft
    /// Rules rejections, in input order. A rejected file never fails the whole
    /// import: the user shared five things and wants the four that are legal.
    var warnings: [String]
}

/// Moves one extension envelope into the durable new-task draft. The saved
/// attachment identifiers make the operation idempotent if inbox cleanup fails
/// after the atomic draft write.
struct PlatformIncomingSharePipeline: Sendable {
    static let maximumAttachmentCount = 8

    private let source: PlatformIncomingShareSource
    private let drafts: PlatformIncomingShareDraftRepository
    private let prepareImage: @Sendable (Data, Int) async throws -> FeatureDraftAttachment

    init(
        source: PlatformIncomingShareSource = .live,
        drafts: PlatformIncomingShareDraftRepository = .live,
        prepareImage: @escaping @Sendable (Data, Int) async throws -> FeatureDraftAttachment = {
            data,
            ordinal in
            try await Task.detached(priority: .userInitiated) {
                try FeatureImageProcessor.attachment(from: data, ordinal: ordinal)
            }.value
        }
    ) {
        self.source = source
        self.drafts = drafts
        self.prepareImage = prepareImage
    }

    func pendingEnvelopes() async -> [T3IncomingShareEnvelope] {
        await source.loadAll()
    }

    func importEnvelope(
        _ envelope: T3IncomingShareEnvelope,
        into project: FeatureProject
    ) async throws -> PlatformIncomingShareImport {
        guard UUID(uuidString: envelope.id) != nil else {
            throw PlatformIncomingShareError.invalidEnvelope
        }
        let key = FeatureComposerDraftStore.newTaskKey(project: project)
        var prepared: [FeatureDraftAttachment] = []
        var warnings: [String] = []
        prepared.reserveCapacity(envelope.attachments.count)
        for attachment in envelope.attachments {
            // Validated against the manifest's declared size, before the bytes
            // are read.
            let outcome = PlatformIncomingShareValidation.validate(
                fileName: attachment.fileName,
                mimeType: attachment.mimeType,
                byteCount: attachment.byteCount
            )
            guard case let .accepted(accepted) = outcome else {
                if case let .rejected(message) = outcome { warnings.append(message) }
                continue
            }

            let data = try await source.data(attachment)
            if accepted.kind == .image {
                // Only images go through the processor: it re-encodes to JPEG
                // and builds the thumbnail the composer chip renders. Handing a
                // PDF or a movie to it leaves the composer spinning on a decode
                // that never completes.
                let processed = try await prepareImage(data, prepared.count + 1)
                prepared.append(Self.stableAttachment(processed, for: attachment))
            } else {
                prepared.append(
                    FeatureDraftAttachment(
                        id: UUID(uuidString: attachment.id) ?? UUID(),
                        data: data,
                        filename: accepted.name,
                        mimeType: accepted.mimeType
                    )
                )
            }
        }

        let merged = try await drafts.importContent(
            envelope.id,
            envelope.text,
            prepared,
            key,
            Self.maximumAttachmentCount
        )

        // The repository's actor operation atomically merges the latest draft
        // and records the share ID. Never acknowledge the inbox before it ends.
        try await source.remove(envelope.id)
        return PlatformIncomingShareImport(
            draft: merged,
            warnings: envelope.warnings + warnings
        )
    }

    private static func stableAttachment(
        _ attachment: FeatureDraftAttachment,
        for shared: T3IncomingShareAttachment
    ) -> FeatureDraftAttachment {
        FeatureDraftAttachment(
            id: UUID(uuidString: shared.id) ?? attachment.id,
            data: attachment.data,
            thumbnailData: attachment.thumbnailData,
            filename: attachment.filename,
            mimeType: attachment.mimeType
        )
    }
}

@MainActor
@Observable
final class PlatformIncomingShareCoordinator {
    private(set) var pendingEnvelope: T3IncomingShareEnvelope?
    private(set) var isImporting = false
    /// Rules rejections from the most recent import, kept so the destination
    /// surface can report what was dropped. Not yet rendered anywhere.
    private(set) var lastImportWarnings: [String] = []

    private let pipeline: PlatformIncomingSharePipeline
    private var isRefreshing = false
    private var lastNoProjectNoticeID: String?

    init(pipeline: PlatformIncomingSharePipeline = PlatformIncomingSharePipeline()) {
        self.pipeline = pipeline
    }

    /// Returns true once per pending envelope when the app cannot offer a
    /// destination. The envelope remains in the shared container.
    func refresh(hasProjects: Bool) async -> Bool {
        guard pendingEnvelope == nil, !isRefreshing, !isImporting else {
            return pendingEnvelope != nil
                && !hasProjects
                && markNoProjectNoticeIfNeeded()
        }
        isRefreshing = true
        let envelopes = await pipeline.pendingEnvelopes()
        isRefreshing = false
        pendingEnvelope = envelopes.first
        guard pendingEnvelope != nil, !hasProjects else { return false }
        return markNoProjectNoticeIfNeeded()
    }

    func dismissDestination() {
        guard !isImporting else { return }
        pendingEnvelope = nil
    }

    func importPending(into project: FeatureProject) async throws {
        guard let pendingEnvelope, !isImporting else { return }
        isImporting = true
        do {
            let result = try await pipeline.importEnvelope(pendingEnvelope, into: project)
            lastImportWarnings = result.warnings
            self.pendingEnvelope = nil
            lastNoProjectNoticeID = nil
            isImporting = false
        } catch {
            isImporting = false
            throw error
        }
    }

    private func markNoProjectNoticeIfNeeded() -> Bool {
        guard let id = pendingEnvelope?.id,
              lastNoProjectNoticeID != id else {
            return false
        }
        lastNoProjectNoticeID = id
        return true
    }
}

struct PlatformIncomingShareDestinationSheet: View {
    let envelope: T3IncomingShareEnvelope
    let projects: [FeatureProject]
    let environments: [FeatureEnvironment]
    let isImporting: Bool
    let onCancel: () -> Void
    let onSelect: (FeatureProject) -> Void

    var body: some View {
        NavigationStack {
            List {
                if !summary.isEmpty {
                    Section {
                        Text(summary)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                    .listRowBackground(Color(uiColor: .systemBackground))
                }

                Section("Choose a project") {
                    ForEach(projects) { project in
                        Button {
                            onSelect(project)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "folder")
                                    .foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(project.name)
                                        .font(.body.weight(.semibold))
                                        .foregroundStyle(.primary)
                                    if let environmentName = environmentName(for: project) {
                                        Text(environmentName)
                                            .font(.subheadline)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if isImporting {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Image(systemName: "chevron.right")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .frame(minHeight: 48)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(isImporting)
                        .listRowBackground(Color(uiColor: .systemBackground))
                    }
                }

                if !envelope.warnings.isEmpty {
                    Section {
                        ForEach(envelope.warnings, id: \.self) { warning in
                            Label(warning, systemImage: "exclamationmark.triangle")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .listRowBackground(Color(uiColor: .systemBackground))
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color(uiColor: .systemBackground))
            .navigationTitle("Start a task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .disabled(isImporting)
                }
            }
        }
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(isImporting)
    }

    private var summary: String {
        let count = envelope.attachments.count
        let files = "\(count) file\(count == 1 ? "" : "s")"
        if !envelope.text.isEmpty, count > 0 {
            return "\(envelope.text)\n\(files)"
        }
        if !envelope.text.isEmpty { return envelope.text }
        guard count > 0 else { return "" }
        return "\(count) shared \(count == 1 ? "file" : "files")"
    }

    private func environmentName(for project: FeatureProject) -> String? {
        guard environments.count > 1 else { return nil }
        return environments.first { $0.id == project.environmentID }?.name
    }
}
