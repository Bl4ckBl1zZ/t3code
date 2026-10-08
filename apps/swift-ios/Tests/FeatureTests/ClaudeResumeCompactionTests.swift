import Foundation
import XCTest

@testable import T3Code

/// Mirrors `shouldOfferResumeCompaction` and the compact-disabled rule in
/// apps/web/src/components/chat/ContextWindowMeter.logic.ts and ChatView.
final class ClaudeResumeCompactionTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func projected(_ item: OrchestrationV2TurnItem) -> OrchestrationV2ProjectedTurnItem {
        OrchestrationV2ProjectedTurnItem(
            position: 0, visibility: .local, sourceThreadId: "thread-v2", sourceItemId: item.id, item: item
        )
    }

    private func userMessage(_ text: String, id: String = "u") -> OrchestrationV2ProjectedTurnItem {
        projected(V2Fixture.turnItem(id: id, type: "user_message", extra: [
            "messageId": .string("message-\(id)"),
            "inputIntent": .string("turn_start"),
            "text": .string(text),
            "createdBy": .string("user"),
            "creationSource": .string("mobile"),
        ]))
    }

    private func input(
        driver: String? = "claudeAgent",
        available: Bool = true,
        tokens: Int = 150_000,
        idleMinutes: Double = 71,
        isIdle: Bool = true,
        items: [OrchestrationV2ProjectedTurnItem]? = nil
    ) -> ClaudeResumeCompaction.Input {
        ClaudeResumeCompaction.Input(
            driver: driver,
            providerAvailable: available,
            contextWindow: ThreadContextWindow(usedTokens: tokens, updatedAt: now.addingTimeInterval(-idleMinutes * 60)),
            isIdle: isIdle,
            items: items ?? [userMessage("Fix the build")],
            now: now
        )
    }

    func testOffersForALargeClaudeSessionIdlePastSeventyMinutes() {
        XCTAssertEqual(ClaudeResumeCompaction.tokens(input()), 150_000)
        XCTAssertEqual(ClaudeResumeCompaction.tokens(input(tokens: 100_000, idleMinutes: 70)), 100_000)
    }

    func testNoOfferBelowEitherThreshold() {
        XCTAssertNil(ClaudeResumeCompaction.tokens(input(tokens: 99_999)))
        XCTAssertNil(ClaudeResumeCompaction.tokens(input(idleMinutes: 69)))
        var unknownTime = input()
        unknownTime.contextWindow = ThreadContextWindow(usedTokens: 150_000, updatedAt: nil)
        XCTAssertNil(ClaudeResumeCompaction.tokens(unknownTime))
        var noUsage = input()
        noUsage.contextWindow = nil
        XCTAssertNil(ClaudeResumeCompaction.tokens(noUsage))
    }

    func testOnlyIdleClaudeThreadsWithAnAvailableInstance() {
        XCTAssertNil(ClaudeResumeCompaction.tokens(input(driver: "codex")))
        XCTAssertNil(ClaudeResumeCompaction.tokens(input(available: false)))
        XCTAssertNil(ClaudeResumeCompaction.tokens(input(isIdle: false)))
    }

    func testNeedsAConversationThatIsNotOnlyACompaction() {
        XCTAssertNil(ClaudeResumeCompaction.tokens(input(items: [])))
        XCTAssertNil(ClaudeResumeCompaction.tokens(input(items: [userMessage(" /COMPACT ")])))
        XCTAssertEqual(
            ClaudeResumeCompaction.tokens(input(items: [userMessage("/compact", id: "a"), userMessage("Next", id: "b")])),
            150_000
        )
    }

    func testContextWindowPrefersLiveTurnUsageThenProviderThreadThenCompaction() throws {
        let parse: (String) -> Date? = { ISO8601DateFormatter().date(from: $0) }
        let compaction = V2Fixture.turnItem(id: "c", type: "compaction", extra: [
            "driver": .string("claudeAgent"), "summary": .null,
            "beforeTokenCount": .number(180_000), "afterTokenCount": .number(20_000),
        ])
        let fromCompaction = try XCTUnwrap(ThreadContextWindow.latest(
            providerTurns: [], providerThread: nil, items: [compaction], parseDate: parse
        ))
        XCTAssertEqual(fromCompaction.usedTokens, 20_000)

        let thread = OrchestrationV2ProviderThread(
            id: "pt", providerInstanceId: "claude", providerSessionId: nil, appThreadId: "t", status: "idle",
            contextUsage: OrchestrationV2ContextUsage(usedTokens: 120_000), updatedAt: "2026-07-31T10:00:00Z"
        )
        XCTAssertEqual(ThreadContextWindow.latest(
            providerTurns: [], providerThread: thread, items: [compaction], parseDate: parse
        )?.usedTokens, 120_000)

        let turn = OrchestrationV2ProviderTurn(
            id: "turn", runAttemptId: nil, status: "completed",
            tokenUsage: OrchestrationV2ProviderTurnTokenUsage(usedTokens: 130_000, updatedAt: "2026-07-31T11:00:00Z")
        )
        let live = try XCTUnwrap(ThreadContextWindow.latest(
            providerTurns: [turn], providerThread: thread, items: [compaction], parseDate: parse
        ))
        XCTAssertEqual(live.usedTokens, 130_000)
        XCTAssertEqual(live.updatedAt, parse("2026-07-31T11:00:00Z"))
    }
}
