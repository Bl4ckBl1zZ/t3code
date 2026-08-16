import Foundation

// Ported from packages/client-runtime/src/voice/stash.ts.

public struct VoiceTranscriptStashEntry: Sendable, Equatable {
    public let text: String
    public let stashedAt: Date
}

/// Holds completed transcripts whose target composer went away before the
/// transcription finished (a thread or workspace switch, navigation).
///
/// The completion handler parks the text under the composer identity it was
/// recorded against; when a composer with that identity is active again it takes
/// the entry and inserts it, so a finished transcript is never silently dropped.
@MainActor
public final class VoiceTranscriptStash {
    /// One app-wide stash: the composer survives thread switches — only its
    /// identity changes — so the entry has to outlive the switch.
    public static let shared = VoiceTranscriptStash()

    private let timeToLive: TimeInterval
    private let now: @MainActor () -> Date
    private var entries: [String: VoiceTranscriptStashEntry] = [:]

    public init(
        timeToLive: TimeInterval = 30 * 60,
        now: @escaping @MainActor () -> Date = { Date() }
    ) {
        self.timeToLive = timeToLive
        self.now = now
    }

    public func put(identity: String, text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        entries[identity] = VoiceTranscriptStashEntry(text: text, stashedAt: now())
    }

    /// Removes and returns the entry for this identity, if a fresh one exists.
    @discardableResult
    public func take(identity: String) -> VoiceTranscriptStashEntry? {
        let entry = peek(identity: identity)
        if entry != nil { entries.removeValue(forKey: identity) }
        return entry
    }

    public func peek(identity: String) -> VoiceTranscriptStashEntry? {
        guard let entry = entries[identity] else { return nil }
        guard now().timeIntervalSince(entry.stashedAt) <= timeToLive else {
            entries.removeValue(forKey: identity)
            return nil
        }
        return entry
    }

    public func clear() {
        entries.removeAll()
    }
}
