import Foundation

// Ported from packages/client-runtime/src/voice/preflight.ts.

/// Caches the OpenRouter status + Voice Input settings so pressing the mic can
/// open the microphone immediately instead of waiting on two relay round-trips
/// between the touch and the permission request.
@MainActor
public final class VoicePreflightCache {
    public struct Snapshot: Sendable, Equatable {
        public let status: OpenRouterIntegrationStatus
        public let settings: VoiceInputSettings
        public let fetchedAt: Date

        /// `voicePreflightReady`: a stored credential that most recently
        /// validated. Anything else means the mic would open only to have the
        /// transcription rejected.
        public var isReady: Bool {
            status.configured && status.state == .connected
        }
    }

    public static let shared = VoicePreflightCache()

    private let timeToLive: TimeInterval
    private let now: @MainActor () -> Date
    private var snapshot: Snapshot?
    private var pending: Task<Snapshot, any Error>?

    public init(
        timeToLive: TimeInterval = 60,
        now: @escaping @MainActor () -> Date = { Date() }
    ) {
        self.timeToLive = timeToLive
        self.now = now
    }

    /// The snapshot while it is still inside the TTL, otherwise nil.
    public func read() -> Snapshot? {
        guard let snapshot, now().timeIntervalSince(snapshot.fetchedAt) < timeToLive else {
            return nil
        }
        return snapshot
    }

    @discardableResult
    public func refresh(using manager: any FeatureVoiceSettingsManaging) async throws -> Snapshot {
        if let pending { return try await pending.value }
        let task = Task { @MainActor [now] () throws -> Snapshot in
            async let status = manager.openRouterIntegration()
            async let settings = manager.voiceInputSettings()
            return Snapshot(
                status: try await status,
                settings: try await settings,
                fetchedAt: now()
            )
        }
        pending = task
        defer { pending = nil }
        let fresh = try await task.value
        snapshot = fresh
        return fresh
    }

    /// Fire-and-forget warm-up; failures (signed out, offline) are swallowed
    /// because nothing is waiting on the result.
    public func prime(using manager: any FeatureVoiceSettingsManaging) {
        Task { @MainActor in
            _ = try? await refresh(using: manager)
        }
    }

    public func invalidate() {
        snapshot = nil
    }
}
