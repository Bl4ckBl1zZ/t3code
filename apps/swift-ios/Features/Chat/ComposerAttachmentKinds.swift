import Foundation

// Ported from apps/mobile/src/lib/composerAttachmentKinds.ts, together with the
// classification half of packages/shared/src/composerAttachments.ts that it
// delegates to. Every client used to carry its own copy of these rules and they
// drifted — a phone could attach a file web refused and the server then rejected
// at turn time — so the native client reproduces the shared classifier rather
// than inventing a third variant.

/// Mirrors the `ChatAttachment` union's `type` discriminant.
public enum ComposerAttachmentKind: String, Codable, CaseIterable, Equatable, Sendable {
    case image
    case pdf
    case video
    case file
}

/// The non-image subset a document attachment can hold.
///
/// Images are excluded at the type level rather than by convention: they are the
/// only kind that carries a preview URI, and handing a PDF to the image view
/// leaves it spinning forever on a decode that never completes.
public enum ComposerDocumentKind: String, Codable, CaseIterable, Equatable, Sendable {
    case pdf
    case video
    case file

    public var attachmentKind: ComposerAttachmentKind {
        switch self {
        case .pdf: .pdf
        case .video: .video
        case .file: .file
        }
    }
}

public enum ComposerAttachments {
    /// `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` from the contract.
    public static let maximumImageBytes = 10 * 1024 * 1024
    /// `PROVIDER_SEND_TURN_MAX_FILE_BYTES` — PDFs, video and generic files all
    /// share the looser cap.
    public static let maximumFileBytes = 20 * 1024 * 1024

    public static func maximumBytes(for kind: ComposerAttachmentKind) -> Int {
        kind == .image ? maximumImageBytes : maximumFileBytes
    }

    /// The extension table the shared classifier keys off. Pickers routinely
    /// hand back a name and nothing else — Android `content://` URIs always do —
    /// so an extension is frequently the only signal available.
    static let mimeTypeByExtension: [String: String] = [
        ".avif": "image/avif",
        ".bmp": "image/bmp",
        ".css": "text/css",
        ".csv": "text/csv",
        ".gif": "image/gif",
        ".gz": "application/gzip",
        ".heic": "image/heic",
        ".heif": "image/heif",
        ".html": "text/html",
        ".ics": "text/calendar",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".js": "text/javascript",
        ".json": "application/json",
        ".jsonl": "application/jsonl",
        ".log": "text/plain",
        ".m4a": "audio/mp4",
        ".md": "text/markdown",
        ".mkv": "video/x-matroska",
        ".mov": "video/quicktime",
        ".mp3": "audio/mpeg",
        ".mp4": "video/mp4",
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".py": "text/x-python",
        ".rs": "text/rust",
        ".sql": "application/sql",
        ".svg": "image/svg+xml",
        ".tar": "application/x-tar",
        ".tiff": "image/tiff",
        ".toml": "application/toml",
        ".ts": "text/typescript",
        ".tsv": "text/tab-separated-values",
        ".txt": "text/plain",
        ".wav": "audio/wav",
        ".webm": "video/webm",
        ".webp": "image/webp",
        ".xml": "application/xml",
        ".yaml": "application/yaml",
        ".yml": "application/yaml",
        ".zip": "application/zip",
    ]

    public static func inferMIMEType(fromFileName name: String) -> String? {
        guard let dot = name.lastIndex(of: ".") else { return nil }
        return mimeTypeByExtension[name[dot...].lowercased()]
    }

    /// Maps a MIME type onto the `ChatAttachment` union's `type` discriminant.
    ///
    /// Audio and archives intentionally land on `.file`: the contract's generic
    /// branch accepts them and the agent reads them off disk like anything else.
    public static func classify(mimeType: String, name: String = "") -> ComposerAttachmentKind {
        // Only the emptiness test trims. A padded MIME type stays padded and
        // falls through to `.file`, exactly as the shared TS classifier does.
        let supplied = mimeType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? (inferMIMEType(fromFileName: name) ?? "")
            : mimeType
        let resolved = supplied.lowercased()
        if resolved.hasPrefix("image/") { return .image }
        if resolved == "application/pdf" { return .pdf }
        if resolved.hasPrefix("video/") { return .video }
        return .file
    }

    /// `classify` as the document path sees it.
    ///
    /// An image that reaches the document picker has no preview URI, so it is
    /// carried as a generic file instead of being routed to the image path.
    public static func documentKind(
        mimeType: String,
        name: String = ""
    ) -> ComposerDocumentKind {
        switch classify(mimeType: mimeType, name: name) {
        case .pdf: .pdf
        case .video: .video
        case .image, .file: .file
        }
    }

    /// Wire shape for `thread.turn.start`: drops the client-only fields (draft
    /// id, preview URI) from every attachment kind.
    public static func uploadAttachments(
        _ attachments: [DraftComposerAttachment]
    ) -> [UploadChatAttachment] {
        attachments.map(\.upload)
    }
}

// UploadChatAttachment lives in Core/Attachments.swift, beside the image form.

/// Images carry a preview URI so the composer can show a thumbnail.
public struct DraftComposerImageAttachment: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let mimeType: String
    public let sizeBytes: Int
    public let dataUrl: String
    public let previewURI: String

    public init(
        id: String,
        name: String,
        mimeType: String,
        sizeBytes: Int,
        dataUrl: String,
        previewURI: String
    ) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.dataUrl = dataUrl
        self.previewURI = previewURI
    }
}

public struct DraftComposerDocumentAttachment: Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: ComposerDocumentKind
    public let name: String
    public let mimeType: String
    public let sizeBytes: Int
    public let dataUrl: String

    public init(
        id: String,
        kind: ComposerDocumentKind,
        name: String,
        mimeType: String,
        sizeBytes: Int,
        dataUrl: String
    ) {
        self.id = id
        self.kind = kind
        self.name = name
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.dataUrl = dataUrl
    }
}

/// Anything the composer can hold as a pending attachment.
public enum DraftComposerAttachment: Identifiable, Equatable, Sendable {
    case image(DraftComposerImageAttachment)
    case document(DraftComposerDocumentAttachment)

    public var id: String {
        switch self {
        case let .image(attachment): attachment.id
        case let .document(attachment): attachment.id
        }
    }

    public var kind: ComposerAttachmentKind {
        switch self {
        case .image: .image
        case let .document(attachment): attachment.kind.attachmentKind
        }
    }

    public var name: String {
        switch self {
        case let .image(attachment): attachment.name
        case let .document(attachment): attachment.name
        }
    }

    /// Swift's stand-in for the TS type guard: non-nil only for the branch that
    /// actually has a thumbnail to render.
    public var image: DraftComposerImageAttachment? {
        guard case let .image(attachment) = self else { return nil }
        return attachment
    }

    public var upload: UploadChatAttachment {
        switch self {
        case let .image(attachment):
            UploadChatAttachment(
                type: .image,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                dataUrl: attachment.dataUrl
            )
        case let .document(attachment):
            UploadChatAttachment(
                type: attachment.kind.attachmentKind,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                dataUrl: attachment.dataUrl
            )
        }
    }
}
