import Foundation

/// How full a thread's context window is, and as of when.
///
/// Reads in order of freshness, as web's `deriveLatestContextWindowSnapshot`
/// does: the newest provider turn's live report, then the active provider
/// thread's standing usage, then the last compaction item, which only ever
/// says how full the window was at that one moment.
public struct ThreadContextWindow: Equatable, Sendable {
    public let usedTokens: Int
    public let updatedAt: Date?
    /// The window's size, when the provider reports one; the meter shows a
    /// fill only then.
    public var maxTokens: Int? = nil
    public var totalProcessedTokens: Int? = nil
    /// True when the provider compacts on its own; nil when it never said.
    public var compactsAutomatically: Bool? = nil
    public var autoCompactThreshold: Int? = nil
    /// The prompt cache lifetime, carried only by a live provider report.
    public var promptCacheTtlMs: Int? = nil

    static func latest(
        providerTurns: [OrchestrationV2ProviderTurn],
        providerThread: OrchestrationV2ProviderThread?,
        items: [OrchestrationV2TurnItem],
        parseDate: (String) -> Date?
    ) -> ThreadContextWindow? {
        // The newest report wins, not the last turn: snapshots order provider
        // turns by thread, so an older thread's turn can come last.
        let reports = providerTurns.compactMap(\.tokenUsage).map { ($0, parseDate($0.updatedAt)) }
        if let (live, updatedAt) = reports.max(by: { ($0.1 ?? .distantPast) < ($1.1 ?? .distantPast) }) {
            return ThreadContextWindow(
                usedTokens: max(0, live.usedTokens),
                updatedAt: updatedAt,
                maxTokens: live.maxTokens,
                compactsAutomatically: true,
                promptCacheTtlMs: live.promptCacheTtlMs
            )
        }
        if let usage = providerThread?.contextUsage, let updatedAt = providerThread?.updatedAt {
            return ThreadContextWindow(
                usedTokens: usage.usedTokens,
                updatedAt: parseDate(updatedAt),
                maxTokens: usage.maxTokens,
                totalProcessedTokens: usage.totalProcessedTokens,
                compactsAutomatically: usage.compactsAutomatically,
                autoCompactThreshold: usage.autoCompactThreshold
            )
        }
        for item in items.reversed() {
            guard case let .compaction(_, _, before, after) = item.payload, let after, after >= 0 else { continue }
            return ThreadContextWindow(
                usedTokens: after,
                updatedAt: parseDate(item.base.updatedAt),
                totalProcessedTokens: before,
                compactsAutomatically: true
            )
        }
        return nil
    }
}

/// Whether the next send on a Claude thread should compact first. Claude
/// re-reads a resumed session's whole history; once that history is large and
/// the session has sat idle past Claude's own prompt cache, the next turn
/// costs far more than a `/compact` turn followed by the message. Mirrors
/// `shouldOfferResumeCompaction` and the compact-disabled rule in web's
/// ContextWindowMeter.logic / ChatView.
enum ClaudeResumeCompaction {
    /// Claude's own resume prompt thresholds: a session idle this long and this
    /// large. The idle time is the fallback for a report without its cache
    /// TTL: Claude's 1h cache plus slack.
    static let idleMinutes: Double = 70
    static let minimumTokens = 100_000

    struct Input {
        /// The selected provider instance's driver.
        var driver: String?
        /// The selected Claude instance is installed and available here. The
        /// thread's own instance is the one that can resume its session.
        var providerAvailable: Bool
        var contextWindow: ThreadContextWindow?
        /// No turn running, queued or preparing, and nothing waiting on an answer.
        var isIdle: Bool
        var items: [OrchestrationV2ProjectedTurnItem]
        var now: Date
    }

    /// The tokens a stale Claude session would re-read on its next turn, while
    /// sending should compact first; nil otherwise.
    static func tokens(_ input: Input) -> Int? {
        guard input.driver == "claudeAgent", input.providerAvailable, input.isIdle,
              let window = input.contextWindow, window.usedTokens >= minimumTokens,
              let updatedAt = window.updatedAt,
              input.now.timeIntervalSince(updatedAt)
                >= window.promptCacheTtlMs.map { Double($0) / 1000 } ?? idleMinutes * 60,
              hasCompactableConversation(input.items) else { return nil }
        return window.usedTokens
    }

    /// A started conversation that is not already just a compaction.
    static func hasCompactableConversation(_ items: [OrchestrationV2ProjectedTurnItem]) -> Bool {
        items.contains { projected in
            guard case let .userMessage(_, _, text, attachments) = projected.item.payload else { return false }
            return !isCompactCommand(text) || !attachments.isEmpty
        }
    }

    static func isCompactCommand(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "/compact"
    }

    /// "152,340" for the composer's menu.
    static func formatted(_ tokens: Int) -> String {
        tokens.formatted(.number.grouping(.automatic))
    }
}
