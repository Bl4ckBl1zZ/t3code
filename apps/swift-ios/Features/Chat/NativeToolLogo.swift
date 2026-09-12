import SwiftUI
import ImageIO
import SVGView

/// Transcript rows display cached bitmaps. SVG parsing and image decoding happen once per URL,
/// not during body evaluation or scrolling; dark logos have their own cache identity.
@MainActor
final class NativeToolLogoStore {
    static let shared = NativeToolLogoStore()
    private struct Entry { let image: UIImage?; let expires: Date }
    private var entries: [URL: Entry] = [:]
    private var pending: [URL: Task<UIImage?, Never>] = [:]
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.httpMaximumConnectionsPerHost = 4
        return URLSession(configuration: configuration)
    }()

    func image(for url: URL) async -> UIImage? {
        if let entry = entries[url], entry.expires > .now { return entry.image }
        if let task = pending[url] { return await task.value }
        // A noisy transcript must not create an unbounded set of concurrent downloads.
        guard pending.count < 16 else { return nil }
        let task = Task { @MainActor [session] in
            do {
                let data: Data
                if url.scheme?.lowercased() == "data" {
                    guard let inline = ToolIconImageData.inline(url.absoluteString) else { return nil as UIImage? }
                    data = inline
                } else {
                    guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
                    let (bytes, response) = try await session.bytes(from: url)
                    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                          response.expectedContentLength <= ToolIconImageData.maximumBytes else { return nil }
                    var received = Data()
                    for try await byte in bytes {
                        guard received.count < ToolIconImageData.maximumBytes else { return nil }
                        received.append(byte)
                    }
                    data = received
                }
                return Self.decode(data)
            } catch { return nil }
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

    static func decode(_ data: Data) -> UIImage? {
        if let source = CGImageSourceCreateWithData(data as CFData, nil),
           let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
               kCGImageSourceCreateThumbnailFromImageAlways: true,
               kCGImageSourceThumbnailMaxPixelSize: 48,
               kCGImageSourceCreateThumbnailWithTransform: true,
           ] as CFDictionary) {
            return UIImage(cgImage: thumbnail, scale: 3, orientation: .up)
        }
        guard ToolIconSVGValidation.accepts(data), let svg = SVGParser.parse(data: data, settings: SVGSettings(linker: .none)) else { return nil }
        let renderer = ImageRenderer(content: SVGView(svg: svg).frame(width: 16, height: 16))
        renderer.scale = 3
        return renderer.uiImage
    }
}

struct NativeToolLogo: View {
    let url: URL
    let fallback: String
    @State private var loaded: (url: URL, image: UIImage?)?
    var body: some View {
        Group {
            if loaded?.url == url, let image = loaded?.image {
                Image(uiImage: image).resizable().scaledToFit()
            } else { Image(systemName: fallback) }
        }
        .frame(width: 16, height: 16)
        .accessibilityHidden(true)
        .task(id: url) {
            let image = await NativeToolLogoStore.shared.image(for: url)
            guard !Task.isCancelled else { return }
            loaded = (url, image)
        }
    }
}
