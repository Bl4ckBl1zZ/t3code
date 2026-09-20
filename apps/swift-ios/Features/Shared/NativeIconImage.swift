import ImageIO
import SVGView
import SwiftUI

/// Remote icon bitmaps — transcript tool logos and project favicons — fetched
/// once per URL and decoded once at the size the UI draws them.
///
/// Every row that names the same project asks for that project's icon, so the
/// cache is what keeps one icon one download and one decode: scrolling reads a
/// decoded thumbnail instead of re-parsing an SVG or a 256px favicon.
@MainActor
final class NativeIconImageStore {
    /// Transcript tool logos, drawn at 16pt.
    static let toolLogos = NativeIconImageStore(maximumPixelSize: 48)
    /// Project favicons, drawn up to 32pt by the icon picker.
    static let projectFavicons = NativeIconImageStore(maximumPixelSize: 96)

    private struct Entry { let image: UIImage?; let expires: Date }

    private let maximumPixelSize: Int
    private var entries: [URL: Entry] = [:]
    private var pending: [URL: Task<UIImage?, Never>] = [:]
    private let session: URLSession

    private init(maximumPixelSize: Int) {
        self.maximumPixelSize = maximumPixelSize
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.httpMaximumConnectionsPerHost = 4
        session = URLSession(configuration: configuration)
    }

    /// The decoded icon when it is already in hand. Rows read this during body
    /// evaluation so a recycled cell redraws its icon in the same frame rather
    /// than flashing its fallback while an await hops.
    func cachedImage(for url: URL) -> UIImage? {
        guard let entry = entries[url], entry.expires > .now else { return nil }
        return entry.image
    }

    func image(for url: URL) async -> UIImage? {
        if let entry = entries[url], entry.expires > .now { return entry.image }
        if let task = pending[url] { return await task.value }
        // A noisy transcript must not create an unbounded set of concurrent downloads.
        guard pending.count < 16 else { return nil }
        let task = Task { @MainActor [session, maximumPixelSize] in
            guard let data = await Self.load(url, session: session) else { return nil as UIImage? }
            return Self.decode(data, maximumPixelSize: maximumPixelSize)
        }
        pending[url] = task
        let image = await task.value
        pending.removeValue(forKey: url)
        if entries.count >= 128, let oldest = entries.min(by: { $0.value.expires < $1.value.expires })?.key {
            entries.removeValue(forKey: oldest)
        }
        entries[url] = Entry(image: image, expires: .now.addingTimeInterval(image == nil ? 30 : 600))
        return image
    }

    /// Reads the body off the main actor, and stops at the icon budget even
    /// when the response understated its length.
    private nonisolated static func load(_ url: URL, session: URLSession) async -> Data? {
        if url.scheme?.lowercased() == "data" { return ToolIconImageData.inline(url.absoluteString) }
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        do {
            let (bytes, response) = try await session.bytes(from: url)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  response.expectedContentLength <= ToolIconImageData.maximumBytes else { return nil }
            var received = Data()
            for try await byte in bytes {
                guard received.count < ToolIconImageData.maximumBytes else { return nil }
                received.append(byte)
            }
            return received
        } catch { return nil }
    }

    /// ImageIO reads PNG, JPEG, GIF, WebP and ICO. SVG has no system decoder —
    /// the format a repo is most likely to keep its icon in — so it is parsed
    /// and rendered once into the same bitmap the other formats end up as.
    static func decode(_ data: Data, maximumPixelSize: Int) -> UIImage? {
        if let source = CGImageSourceCreateWithData(data as CFData, nil),
           let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
               kCGImageSourceCreateThumbnailFromImageAlways: true,
               kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
               kCGImageSourceCreateThumbnailWithTransform: true,
           ] as CFDictionary) {
            return UIImage(cgImage: thumbnail, scale: 3, orientation: .up)
        }
        guard ToolIconSVGValidation.accepts(data),
              let svg = SVGParser.parse(data: data, settings: SVGSettings(linker: .none)) else { return nil }
        let side = CGFloat(maximumPixelSize) / 3
        let renderer = ImageRenderer(content: SVGView(svg: svg).frame(width: side, height: side))
        renderer.scale = 3
        return renderer.uiImage
    }
}
