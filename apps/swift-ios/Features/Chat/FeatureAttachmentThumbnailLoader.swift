import ImageIO
import UIKit

/// Downsamples remote images once and hands the result to every transcript view
/// that asks for the same URL: message attachments and assistant markdown media
/// both scroll in and out of recycled cells, so decoding is cached rather than
/// repeated.
enum FeatureAttachmentThumbnailLoader {
    /// `identity` names the bytes when the URL does not: a signed asset URL
    /// changes on every mint, and a reconnect mints again, so a URL-keyed
    /// cache misses each time.
    static func image(for url: URL, identity: String? = nil, maximumPixelSize: Int) async throws -> UIImage {
        let cacheKey = cacheKey(for: url, identity: identity, maximumPixelSize: maximumPixelSize) as NSString
        if let cached = FeatureAttachmentThumbnailCache.shared.image(for: cacheKey) {
            return cached
        }

        let (data, response) = try await URLSession.shared.data(from: url)
        try Task.checkCancellation()
        if let response = response as? HTTPURLResponse,
           !(200...299).contains(response.statusCode) {
            throw FeatureAttachmentThumbnailError.invalidResponse
        }

        let image = try await Task.detached(priority: .utility) {
            try downsample(data: data, maximumPixelSize: maximumPixelSize)
        }.value
        try Task.checkCancellation()
        FeatureAttachmentThumbnailCache.shared.insert(image, for: cacheKey)
        return image
    }

    static func cacheKey(for url: URL, identity: String?, maximumPixelSize: Int) -> String {
        "\(identity ?? url.absoluteString)#\(maximumPixelSize)"
    }

    /// A server attachment never changes bytes once stored, so its image
    /// caches under its id, scoped by the thread (and so the environment) it
    /// belongs to. Nil without a scope, which falls back to the URL.
    static func attachmentIdentity(scope: String?, attachmentID: String) -> String? {
        scope.map { "t3-attachment:\($0.utf8.count):\($0)\(attachmentID)" }
    }

    private static func downsample(data: Data, maximumPixelSize: Int) throws -> UIImage {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
            throw FeatureAttachmentThumbnailError.decodingFailed
        }

        let thumbnailOptions = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            thumbnailOptions
        ) else {
            throw FeatureAttachmentThumbnailError.decodingFailed
        }
        return UIImage(cgImage: thumbnail)
    }
}

final class FeatureAttachmentThumbnailCache: @unchecked Sendable {
    static let shared = FeatureAttachmentThumbnailCache()

    private let images = NSCache<NSString, UIImage>()

    private init() {
        images.countLimit = 96
        images.totalCostLimit = 32 * 1_024 * 1_024
    }

    func image(for key: NSString) -> UIImage? {
        images.object(forKey: key)
    }

    func insert(_ image: UIImage, for key: NSString) {
        let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
        images.setObject(image, forKey: key, cost: cost)
    }
}

enum FeatureAttachmentThumbnailError: Error {
    case invalidResponse
    case decodingFailed
}
