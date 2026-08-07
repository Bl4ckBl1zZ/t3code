import Foundation
import UniformTypeIdentifiers

struct T3LoadedSharePayload: Sendable {
    var textFragments: [String]
    var attachments: [T3PendingShareAttachment]
    var warnings: [String]
}

enum T3SharePayloadLoader {
    static func load(from inputItems: [Any]) async -> T3LoadedSharePayload {
        var textFragments: [String] = []
        var attachments: [T3PendingShareAttachment] = []
        var warnings: [String] = []
        var skippedExcess = false

        for case let item as NSExtensionItem in inputItems {
            if let attributedText = item.attributedContentText?.string {
                textFragments.append(attributedText)
            }

            for provider in item.attachments ?? [] {
                switch T3SharedAttachmentTypes.selection(
                    forRegisteredTypeIdentifiers: provider.registeredTypeIdentifiers
                ) {
                case let .attachment(typeIdentifier, isImage):
                    guard attachments.count < T3IncomingShareStore.maximumAttachmentCount else {
                        skippedExcess = true
                        continue
                    }
                    do {
                        let staged = try await loadStagedAttachment(
                            from: provider,
                            typeIdentifier: typeIdentifier,
                            isImage: isImage
                        )
                        attachments.append(
                            T3PendingShareAttachment(
                                stagedFileURL: staged.url,
                                byteCount: staged.byteCount,
                                suggestedName: provider.suggestedName,
                                typeIdentifier: typeIdentifier,
                                mimeType: T3SharedAttachmentTypes.mimeType(
                                    forTypeIdentifier: typeIdentifier
                                ),
                                isImage: isImage
                            )
                        )
                    } catch let error as T3SharePayloadLoaderError {
                        warnings.append(
                            error.warning(
                                name: provider.suggestedName ?? "Shared file",
                                isImage: isImage
                            )
                        )
                    } catch {
                        // A file provider is terminal even when it also vends a
                        // URL or text representation. Falling through would
                        // silently turn a rejected attachment into other input.
                    }

                case let .webURL(typeIdentifier):
                    if let value = try? await loadItem(
                        from: provider,
                        typeIdentifier: typeIdentifier
                    ), let urlText = urlString(from: value) {
                        textFragments.append(urlText)
                    }

                case let .plainText(typeIdentifier):
                    if let value = try? await loadItem(
                        from: provider,
                        typeIdentifier: typeIdentifier
                    ), let text = textString(from: value) {
                        textFragments.append(text)
                    }

                case .none:
                    continue
                }
            }
        }

        if skippedExcess {
            warnings.append(
                "Only the first \(T3IncomingShareStore.maximumAttachmentCount) shared files were attached."
            )
        }
        return T3LoadedSharePayload(
            textFragments: textFragments,
            attachments: attachments,
            warnings: warnings
        )
    }

    private static func loadStagedAttachment(
        from provider: NSItemProvider,
        typeIdentifier: String,
        isImage: Bool
    ) async throws -> (url: URL, byteCount: Int) {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, error in
                do {
                    guard let url else {
                        throw error ?? CocoaError(.fileReadUnknown)
                    }
                    continuation.resume(
                        returning: try stage(from: url, isImage: isImage)
                    )
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// The provider-owned URL expires when its callback returns. Stream it to an
    /// extension-owned temporary file while enforcing the byte limit, so a
    /// malicious or enormous provider never has to be materialized in memory.
    private static func stage(from sourceURL: URL, isImage: Bool) throws -> (url: URL, byteCount: Int) {
        let fileManager = FileManager.default
        let maximumBytes = T3IncomingShareStore.maximumBytes(isImage: isImage)

        // Pre-read rejection: a 4 GB movie is refused off its declared size,
        // before a single byte is copied. Widening past images made this the
        // difference between a warning and an extension the OS jetsams.
        if let declared = try? sourceURL.resourceValues(forKeys: [.fileSizeKey]).fileSize {
            guard declared > 0 else { throw T3SharePayloadLoaderError.empty }
            guard declared <= maximumBytes else { throw T3SharePayloadLoaderError.tooLarge }
        }

        let stagingDirectory = fileManager.temporaryDirectory.appending(
            path: "T3CodeShareStaging",
            directoryHint: .isDirectory
        )
        try fileManager.createDirectory(
            at: stagingDirectory,
            withIntermediateDirectories: true
        )
        let stagedURL = stagingDirectory.appending(
            path: UUID().uuidString.lowercased(),
            directoryHint: .notDirectory
        )
        guard fileManager.createFile(atPath: stagedURL.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }

        do {
            let source = try FileHandle(forReadingFrom: sourceURL)
            let destination = try FileHandle(forWritingTo: stagedURL)
            defer {
                try? source.close()
                try? destination.close()
            }

            var byteCount = 0
            while let chunk = try source.read(upToCount: 64 * 1_024), !chunk.isEmpty {
                try Task.checkCancellation()
                byteCount += chunk.count
                // Providers that report no size (or lie about it) are still
                // bounded, so the declared-size check above is an optimization
                // rather than the guarantee.
                guard byteCount <= maximumBytes else {
                    throw T3SharePayloadLoaderError.tooLarge
                }
                try destination.write(contentsOf: chunk)
            }
            guard byteCount > 0 else { throw T3SharePayloadLoaderError.empty }
            return (stagedURL, byteCount)
        } catch {
            try? fileManager.removeItem(at: stagedURL)
            throw error
        }
    }

    private static func loadItem(
        from provider: NSItemProvider,
        typeIdentifier: String
    ) async throws -> NSSecureCoding {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier) { value, error in
                if let value {
                    continuation.resume(returning: value)
                } else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                }
            }
        }
    }

    private static func urlString(from value: NSSecureCoding) -> String? {
        if let url = value as? URL {
            return url.absoluteString
        }
        if let text = value as? String, URL(string: text) != nil {
            return text
        }
        return nil
    }

    private static func textString(from value: NSSecureCoding) -> String? {
        if let text = value as? String {
            return text
        }
        if let attributedText = value as? NSAttributedString {
            return attributedText.string
        }
        return nil
    }
}

enum T3SharePayloadLoaderError: Error {
    case tooLarge
    case empty

    func warning(name: String, isImage: Bool) -> String {
        let displayName = T3IncomingShareStore.safeFileName(name, fallback: "Shared file")
        return switch self {
        case .tooLarge:
            T3IncomingShareStore.overLimitWarning(name: displayName, isImage: isImage)
        case .empty:
            T3IncomingShareStore.emptyWarning(name: displayName)
        }
    }
}
