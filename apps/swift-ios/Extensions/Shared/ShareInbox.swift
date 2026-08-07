import Foundation
import UniformTypeIdentifiers

/// One shared file staged into the App Group inbox.
///
/// Carries `mimeType` rather than a resolved attachment kind: classification is
/// the shared rule set's job (`ComposerAttachments.classify`), and that lives in
/// the host app, which is the only side that can reach it. The extension records
/// the raw signals — UTI, MIME, name, size — and the app decides.
struct T3IncomingShareAttachment: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var fileName: String
    var typeIdentifier: String
    var mimeType: String
    var relativePath: String
    var byteCount: Int

    enum CodingKeys: String, CodingKey {
        case id
        case fileName
        case typeIdentifier
        case mimeType
        case relativePath
        case byteCount
    }

    init(
        id: String,
        fileName: String,
        typeIdentifier: String,
        mimeType: String = "",
        relativePath: String,
        byteCount: Int
    ) {
        self.id = id
        self.fileName = fileName
        self.typeIdentifier = typeIdentifier
        self.mimeType = mimeType
        self.relativePath = relativePath
        self.byteCount = byteCount
    }

    /// `mimeType` was added when the extension widened past images. Envelopes
    /// written by an older build are still on disk in the App Group, so it
    /// decodes as optional and falls back to the UTI it was always given.
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        fileName = try container.decode(String.self, forKey: .fileName)
        typeIdentifier = try container.decode(String.self, forKey: .typeIdentifier)
        relativePath = try container.decode(String.self, forKey: .relativePath)
        byteCount = try container.decode(Int.self, forKey: .byteCount)
        mimeType = try container.decodeIfPresent(String.self, forKey: .mimeType)
            ?? T3SharedAttachmentTypes.mimeType(forTypeIdentifier: typeIdentifier)
    }
}

struct T3IncomingShareEnvelope: Codable, Hashable, Identifiable, Sendable {
    static let schemaVersion = 1

    var schemaVersion: Int
    var id: String
    var createdAt: Date
    var text: String
    var attachments: [T3IncomingShareAttachment]
    var warnings: [String]

    enum CodingKeys: String, CodingKey {
        case schemaVersion
        case id
        case createdAt
        case text
        case attachments
        case warnings
    }

    init(
        schemaVersion: Int,
        id: String,
        createdAt: Date,
        text: String,
        attachments: [T3IncomingShareAttachment],
        warnings: [String]
    ) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.createdAt = createdAt
        self.text = text
        self.attachments = attachments
        self.warnings = warnings
    }

    /// Reads the pre-widening `images` key too, so a share saved by an older
    /// build is still importable after the app updates instead of being silently
    /// dropped (and stranded forever, since nothing prunes undecodable items).
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        id = try container.decode(String.self, forKey: .id)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        text = try container.decode(String.self, forKey: .text)
        warnings = try container.decode([String].self, forKey: .warnings)
        if let attachments = try container.decodeIfPresent(
            [T3IncomingShareAttachment].self,
            forKey: .attachments
        ) {
            self.attachments = attachments
        } else {
            self.attachments = try decoder
                .container(keyedBy: LegacyCodingKeys.self)
                .decodeIfPresent([T3IncomingShareAttachment].self, forKey: .images) ?? []
        }
    }

    private enum LegacyCodingKeys: String, CodingKey {
        case images
    }
}

struct T3PendingShareAttachment: Sendable {
    var stagedFileURL: URL
    var byteCount: Int
    var suggestedName: String?
    var typeIdentifier: String
    var mimeType: String
    /// Images carry the tighter contract cap, so the kind has to be known before
    /// a single byte is streamed.
    var isImage: Bool
}

/// How one `NSItemProvider` should be read.
///
/// Ported from the `SHAREABLE_ATTACHMENT_TYPES` split in
/// apps/mobile/src/features/sharing/incoming-share-model.ts: text and web URLs
/// become the draft's message body, everything else becomes a file the agent can
/// open once it is materialized into the project.
enum T3ShareItemSelection: Hashable, Sendable {
    case attachment(typeIdentifier: String, isImage: Bool)
    case webURL(typeIdentifier: String)
    case plainText(typeIdentifier: String)
}

enum T3SharedAttachmentTypes {
    /// Picks what a provider should be read as, from the type identifiers it
    /// advertises.
    ///
    /// Order matters and is not the declaration order of the activation rule: a
    /// provider that vends an image *also* vends `public.url` and `public.data`
    /// representations, and a file URL conforms to `public.url`, so a naive
    /// "URL first" pass turns every shared photo and document into a link.
    static func selection(forRegisteredTypeIdentifiers identifiers: [String]) -> T3ShareItemSelection? {
        if let image = identifiers.first(where: { conforms($0, to: .image) }) {
            return .attachment(typeIdentifier: image, isImage: true)
        }
        if let movie = identifiers.first(where: { conforms($0, to: .movie) }) {
            return .attachment(typeIdentifier: movie, isImage: false)
        }
        // A *web* URL is a link to paste into the prompt; a file URL is a file.
        let fileURL = identifiers.first { conforms($0, to: .fileURL) }
        if fileURL == nil, let url = identifiers.first(where: { conforms($0, to: .url) }) {
            return .webURL(typeIdentifier: url)
        }
        // The concrete type first (`com.adobe.pdf` names the file better than
        // `public.file-url` does), then the file URL as the fallback for
        // providers that advertise nothing else.
        if let file = identifiers.first(where: { isFileLike($0) }) ?? fileURL {
            return .attachment(typeIdentifier: file, isImage: false)
        }
        if let text = identifiers.first(where: { conforms($0, to: .text) }) {
            return .plainText(typeIdentifier: text)
        }
        return nil
    }

    /// Plain text conforms to `public.data`, so the generic-file branch has to
    /// exclude it or a shared selection of text arrives as a `.txt` attachment
    /// instead of as the prompt. URLs are excluded for the same reason.
    static func isFileLike(_ identifier: String) -> Bool {
        guard let type = UTType(identifier) else { return false }
        guard !type.conforms(to: .text), !type.conforms(to: .url) else { return false }
        return type.conforms(to: .data) || type.conforms(to: .package)
    }

    static func mimeType(forTypeIdentifier identifier: String) -> String {
        UTType(identifier)?.preferredMIMEType ?? ""
    }

    static func fileExtension(forTypeIdentifier identifier: String) -> String {
        UTType(identifier)?.preferredFilenameExtension ?? "bin"
    }

    private static func conforms(_ identifier: String, to type: UTType) -> Bool {
        UTType(identifier)?.conforms(to: type) == true
    }
}

enum T3IncomingShareStoreError: LocalizedError {
    case appGroupUnavailable
    case noSupportedContent

    var errorDescription: String? {
        switch self {
        case .appGroupUnavailable:
            "T3 Code could not access its shared inbox."
        case .noSupportedContent:
            "This app did not provide text, a URL, or a supported file."
        }
    }
}

/// A crash-safe handoff from the short-lived share extension to the host app.
/// Each share gets its own UUID directory and an atomically-written manifest.
enum T3IncomingShareStore {
    static let inboxRelativePath = "Library/Application Support/T3Code/IncomingShares"
    static let manifestFileName = "manifest.json"
    /// Matches `NSExtensionActivationSupportsImageWithMaxCount` /
    /// `...MovieWithMaxCount` / `...FileWithMaxCount` in Extensions/Share/Info.plist
    /// and `PROVIDER_SEND_TURN_MAX_ATTACHMENTS` in the contract.
    static let maximumAttachmentCount = 8
    // The share extension is a separate module and cannot see
    // `ComposerAttachments`, so the two contract caps are restated here.
    // ExtensionContractTests asserts they agree, the same way it pins the app
    // group identifier that also lives in three places.
    static let maximumImageBytes = 10 * 1_024 * 1_024
    static let maximumFileBytes = 20 * 1_024 * 1_024

    static func maximumBytes(isImage: Bool) -> Int {
        isImage ? maximumImageBytes : maximumFileBytes
    }

    static func overLimitWarning(name: String, isImage: Bool) -> String {
        let limit = maximumBytes(isImage: isImage) / (1_024 * 1_024)
        return "'\(name)' is over the \(limit) MB limit for \(isImage ? "an image" : "a file")."
    }

    static func emptyWarning(name: String) -> String {
        "'\(name)' is empty and wasn't attached."
    }

    static func write(
        textFragments: [String],
        attachments pending: [T3PendingShareAttachment],
        warnings initialWarnings: [String] = [],
        now: Date = Date(),
        id: String = UUID().uuidString.lowercased()
    ) throws -> T3IncomingShareEnvelope {
        guard let containerURL = T3SharedContainer.rootURL else {
            throw T3IncomingShareStoreError.appGroupUnavailable
        }
        defer {
            for item in pending {
                try? FileManager.default.removeItem(at: item.stagedFileURL)
            }
        }

        let normalizedText = deduplicatedText(textFragments)
        let itemDirectory = containerURL
            .appending(path: inboxRelativePath, directoryHint: .isDirectory)
            .appending(path: id, directoryHint: .isDirectory)
        var warnings = initialWarnings
        var saved: [T3IncomingShareAttachment] = []
        var validOverflowCount = 0

        do {
            try FileManager.default.createDirectory(
                at: itemDirectory,
                withIntermediateDirectories: true
            )

            for item in pending {
                let values = try? item.stagedFileURL.resourceValues(forKeys: [
                    .fileSizeKey,
                    .isRegularFileKey,
                ])
                let fallbackExtension = T3SharedAttachmentTypes.fileExtension(
                    forTypeIdentifier: item.typeIdentifier
                )
                let fileName = safeFileName(
                    item.suggestedName,
                    fallback: "shared-file-\(saved.count + 1).\(fallbackExtension)"
                )
                guard values?.isRegularFile == true,
                      let byteCount = values?.fileSize,
                      byteCount > 0 else {
                    warnings.append(emptyWarning(name: fileName))
                    continue
                }
                // Re-checked against the staged file rather than trusting the
                // loader's count: the manifest is what the app validates
                // pre-read, so a size it cannot trust is worse than no share.
                guard byteCount <= maximumBytes(isImage: item.isImage),
                      byteCount == item.byteCount else {
                    warnings.append(overLimitWarning(name: fileName, isImage: item.isImage))
                    continue
                }
                guard saved.count < maximumAttachmentCount else {
                    validOverflowCount += 1
                    continue
                }

                let attachmentID = UUID().uuidString.lowercased()
                let storedName = "\(attachmentID)-\(fileName)"
                let fileURL = itemDirectory.appending(path: storedName, directoryHint: .notDirectory)
                try FileManager.default.copyItem(at: item.stagedFileURL, to: fileURL)
                saved.append(
                    T3IncomingShareAttachment(
                        id: attachmentID,
                        fileName: fileName,
                        typeIdentifier: item.typeIdentifier,
                        mimeType: item.mimeType,
                        relativePath: "\(inboxRelativePath)/\(id)/\(storedName)",
                        byteCount: byteCount
                    )
                )
            }

            if validOverflowCount > 0 {
                warnings.append(
                    "Only the first \(maximumAttachmentCount) shared files were attached."
                )
            }

            guard !normalizedText.isEmpty || !saved.isEmpty else {
                throw T3IncomingShareStoreError.noSupportedContent
            }

            let envelope = T3IncomingShareEnvelope(
                schemaVersion: T3IncomingShareEnvelope.schemaVersion,
                id: id,
                createdAt: now,
                text: normalizedText,
                attachments: saved,
                warnings: warnings
            )
            let manifestURL = itemDirectory.appending(
                path: manifestFileName,
                directoryHint: .notDirectory
            )
            try encoder.encode(envelope).write(to: manifestURL, options: .atomic)
            return envelope
        } catch {
            try? FileManager.default.removeItem(at: itemDirectory)
            throw error
        }
    }

    static func loadAll() -> [T3IncomingShareEnvelope] {
        guard let containerURL = T3SharedContainer.rootURL else { return [] }
        let inboxURL = containerURL.appending(path: inboxRelativePath, directoryHint: .isDirectory)
        guard let directories = try? FileManager.default.contentsOfDirectory(
            at: inboxURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        return directories.compactMap { directory in
            let manifestURL = directory.appending(path: manifestFileName, directoryHint: .notDirectory)
            guard let data = try? Data(contentsOf: manifestURL) else { return nil }
            return try? decoder.decode(T3IncomingShareEnvelope.self, from: data)
        }
        .filter { $0.schemaVersion == T3IncomingShareEnvelope.schemaVersion }
        .sorted { $0.createdAt < $1.createdAt }
    }

    static func remove(id: String) throws {
        guard let containerURL = T3SharedContainer.rootURL else {
            throw T3IncomingShareStoreError.appGroupUnavailable
        }
        guard UUID(uuidString: id) != nil else {
            throw T3IncomingShareStoreError.noSupportedContent
        }
        let inboxURL = containerURL
            .appending(path: inboxRelativePath, directoryHint: .isDirectory)
            .standardizedFileURL
        let itemURL = inboxURL
            .appending(path: id, directoryHint: .isDirectory)
            .standardizedFileURL
        guard itemURL.deletingLastPathComponent() == inboxURL else {
            throw T3IncomingShareStoreError.noSupportedContent
        }
        guard FileManager.default.fileExists(atPath: itemURL.path) else { return }
        try FileManager.default.removeItem(at: itemURL)
    }

    static func fileURL(for attachment: T3IncomingShareAttachment) -> URL? {
        guard let root = T3SharedContainer.rootURL?.standardizedFileURL else { return nil }
        let inbox = root.appending(path: inboxRelativePath, directoryHint: .isDirectory)
            .standardizedFileURL
        let url = root.appending(path: attachment.relativePath, directoryHint: .notDirectory)
            .standardizedFileURL
        guard url.path.hasPrefix(inbox.path + "/") else { return nil }
        return url
    }

    private static func deduplicatedText(_ fragments: [String]) -> String {
        var seen: Set<String> = []
        return fragments.compactMap { fragment in
            let value = fragment.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, seen.insert(value).inserted else { return nil }
            return value
        }.joined(separator: "\n\n")
    }

    static func safeFileName(_ proposed: String?, fallback: String) -> String {
        let candidate = proposed?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let lastPathComponent = URL(fileURLWithPath: candidate).lastPathComponent
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-_ "))
        let sanitized = String(lastPathComponent.unicodeScalars.filter(allowed.contains)).prefix(96)
        return sanitized.isEmpty ? fallback : String(sanitized)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
