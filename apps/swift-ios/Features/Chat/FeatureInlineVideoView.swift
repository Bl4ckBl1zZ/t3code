import AVKit
import Foundation
import SwiftUI

/// A quiet, non-autoplaying transcript player. Older asset routes ignored byte
/// ranges and could make AVPlayer download an entire recording before showing
/// anything, so playback is offered only after a one-byte 206 probe succeeds.
struct FeatureInlineVideoView: View {
    let url: URL
    let title: String

    @State private var player: AVPlayer?
    @State private var failed = false

    var body: some View {
        Group {
            if let player {
                VideoPlayer(player: player)
                    .aspectRatio(16 / 9, contentMode: .fit)
                    .background(.black)
                    .accessibilityLabel(title)
            } else {
                VStack(spacing: 6) {
                    Image(systemName: failed ? "film.slash" : "play.rectangle")
                        .font(.system(size: 22, weight: .medium))
                    Text(failed ? "Video unavailable" : title)
                        .font(T3Typography.supporting)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                }
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(failed ? "Video unavailable: \(title)" : title)
            }
        }
        .aspectRatio(16 / 9, contentMode: .fit)
        .task(id: url) { await preparePlayer() }
        .onDisappear {
            player?.pause()
            player = nil
        }
    }

    @MainActor
    private func preparePlayer() async {
        player?.pause()
        player = nil
        failed = false
        guard await FeatureVideoRangeProbe.supportsPlayback(url) else {
            if !Task.isCancelled { failed = true }
            return
        }

        let asset = AVURLAsset(url: url)
        do {
            guard try await asset.load(.isPlayable) else {
                failed = true
                return
            }
            try Task.checkCancellation()
            player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
        } catch is CancellationError {
            return
        } catch {
            failed = true
        }
    }
}

enum FeatureVideoRangeProbe {
    static func request(for url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }

    static func supportsPlaybackResponse(_ response: URLResponse) -> Bool {
        guard let http = response as? HTTPURLResponse else { return false }
        return http.statusCode == 206
            && http.value(forHTTPHeaderField: "Accept-Ranges")?.lowercased() == "bytes"
            && http.value(forHTTPHeaderField: "Content-Range")?.hasPrefix("bytes 0-0/") == true
    }

    static func supportsPlayback(_ url: URL) async -> Bool {
        let probe = Task {
            do {
                let (bytes, response) = try await URLSession.shared.bytes(for: request(for: url))
                guard supportsPlaybackResponse(response) else {
                    withUnsafeCurrentTask { $0?.cancel() }
                    return false
                }
                var iterator = bytes.makeAsyncIterator()
                _ = try await iterator.next()
                withUnsafeCurrentTask { $0?.cancel() }
                return true
            } catch {
                return false
            }
        }
        return await withTaskCancellationHandler {
            await probe.value
        } onCancel: {
            probe.cancel()
        }
    }
}
