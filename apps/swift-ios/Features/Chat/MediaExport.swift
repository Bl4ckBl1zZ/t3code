import Foundation
import Photos
import SwiftUI
import UniformTypeIdentifiers

struct MediaExportFile: Identifiable, Sendable {
    let id = UUID()
    let url: URL
    let isVideo: Bool

    func remove() { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}

enum MediaExportError: LocalizedError {
    case invalidResponse, unsupportedMedia, photoAccessDenied

    var errorDescription: String? {
        switch self {
        case .invalidResponse: "The original media could not be downloaded."
        case .unsupportedMedia: "This file is not a supported image or video."
        case .photoAccessDenied: "Allow T3 Code to add photos in Settings, or use Share to save this file elsewhere."
        }
    }
}

enum MediaExport {
    static func fileType(mimeType: String?, pathExtension: String) -> UTType? {
        let type = mimeType.flatMap { UTType(mimeType: $0) }
            ?? UTType(filenameExtension: pathExtension)
        guard let type, type.conforms(to: .image) || type.conforms(to: .movie) else { return nil }
        return type
    }

    /// Downloads the original into a private temporary directory owned by the presentation.
    static func download(_ url: URL) async throws -> MediaExportFile {
        let (download, response) = try await URLSession.shared.download(from: url)
        defer { try? FileManager.default.removeItem(at: download) }
        try Task.checkCancellation()
        if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
            throw MediaExportError.invalidResponse
        }
        guard let type = fileType(mimeType: response.mimeType, pathExtension: url.pathExtension) else {
            throw MediaExportError.unsupportedMedia
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-media-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent("Media.\(type.preferredFilenameExtension ?? "bin")")
        do {
            try FileManager.default.moveItem(at: download, to: destination)
            return MediaExportFile(url: destination, isVideo: type.conforms(to: .movie))
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    static func saveToPhotos(_ file: MediaExportFile) async throws {
        let authorization = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard authorization == .authorized || authorization == .limited else {
            throw MediaExportError.photoAccessDenied
        }
        try Task.checkCancellation()
        try await PHPhotoLibrary.shared().performChanges {
            let request = PHAssetCreationRequest.forAsset()
            request.addResource(with: file.isVideo ? .video : .photo, fileURL: file.url, options: nil)
        }
    }
}

struct MediaShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
