import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// Downloads workspace files that are not text into a private temporary folder,
/// so Quick Look can preview them and Share can hand over the file itself
/// (keeping its name and type) instead of an expiring signed link.
enum FeatureFileDownload {
    /// Streams `url` to disk as `name`. Each download gets its own folder, so
    /// two files with the same name never overwrite one another.
    static func download(from url: URL, name: String) async throws -> URL {
        let (temporaryURL, response) = try await URLSession.shared.download(
            for: URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        )
        if let response = response as? HTTPURLResponse, !(200 ... 299).contains(response.statusCode) {
            try? FileManager.default.removeItem(at: temporaryURL)
            throw FeatureFileDownloadError.httpStatus(response.statusCode)
        }
        let folder = root.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appending(path: safeName(name), directoryHint: .notDirectory)
        try FileManager.default.moveItem(at: temporaryURL, to: destination)
        return destination
    }

    /// Writes bytes already in memory (a decoded image preview) to a file that
    /// can be shared under the original name.
    static func write(_ data: Data, name: String) throws -> URL {
        let folder = root.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appending(path: safeName(name), directoryHint: .notDirectory)
        try data.write(to: destination, options: .atomic)
        return destination
    }

    /// Removes a download once its preview goes away.
    static func discard(_ fileURL: URL) {
        try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent())
    }

    private static var root: URL {
        FileManager.default.temporaryDirectory.appending(path: "T3FilePreviews", directoryHint: .isDirectory)
    }

    private static func safeName(_ name: String) -> String {
        let last = URL(fileURLWithPath: name).lastPathComponent
        return last.isEmpty || last == "/" ? "File" : last
    }
}

enum FeatureFileDownloadError: LocalizedError {
    case httpStatus(Int)

    var errorDescription: String? {
        switch self {
        case let .httpStatus(status): "The file server returned HTTP \(status)."
        }
    }
}

/// A local file in Quick Look: pages, search inside the document, and zoom,
/// for PDFs, Office and iWork documents, spreadsheets, 3D models and audio.
struct FeatureQuickLookView: UIViewControllerRepresentable {
    let fileURL: URL

    static func canPreview(_ fileURL: URL) -> Bool {
        QLPreviewController.canPreview(fileURL as NSURL)
    }

    func makeCoordinator() -> Coordinator { Coordinator(fileURL: fileURL) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        guard context.coordinator.fileURL != fileURL else { return }
        context.coordinator.fileURL = fileURL
        controller.reloadData()
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var fileURL: URL

        init(fileURL: URL) { self.fileURL = fileURL }

        func numberOfPreviewItems(in _: QLPreviewController) -> Int { 1 }

        func previewController(_: QLPreviewController, previewItemAt _: Int) -> QLPreviewItem {
            fileURL as NSURL
        }
    }
}

/// Files.app's "no preview" layout: a document tile, the name, kind and size,
/// and Share so the file can go to an app that opens it.
struct FeatureFileNoPreviewView: View {
    let name: String
    let fileURL: URL?
    var sizeBytes: Int?
    var reason = "There's no preview for this kind of file."

    var body: some View {
        ContentUnavailableView {
            VStack(spacing: 12) {
                Image(systemName: "doc.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(T3Colors.textTertiary)
                    .accessibilityHidden(true)
                Text(name)
                    .font(.headline)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
        } description: {
            Text([FeatureFileKindLabel.kind(forPath: name), sizeText].compactMap { $0 }.joined(separator: " · ")
                + "\n" + reason)
        } actions: {
            if let fileURL {
                ShareLink(item: fileURL) {
                    Label("Share…", systemImage: "square.and.arrow.up")
                }
                .t3SecondaryButtonStyle()
            }
        }
    }

    private var sizeText: String? {
        let bytes = sizeBytes ?? fileURL.flatMap {
            try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize
        }
        return bytes.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }
    }
}

/// The system's name for a file's kind ("JSON", "PDF document"), from its
/// extension. Nil for extensions the system does not know.
enum FeatureFileKindLabel {
    static func kind(forPath path: String) -> String? {
        let fileExtension = URL(fileURLWithPath: path).pathExtension
        guard !fileExtension.isEmpty,
              let type = UTType(filenameExtension: fileExtension),
              !type.isDynamic else { return nil }
        return type.localizedDescription
    }
}
