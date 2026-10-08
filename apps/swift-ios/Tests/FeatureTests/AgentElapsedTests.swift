import Foundation
import Testing
@testable import T3Code

/// Mirrors apps/web/src/components/chat/AgentElapsed.test.ts.
struct AgentElapsedTests {
    private static let cases: [(seconds: Double, label: String)] = [
        (45, "45s"),
        (90, "1m"),
        (3_599, "59m"),
        (3_600, "1h"),
        (5_400, "1.5h"),
        (7_140, "1.9h"),
        (52_800, "14h"),
    ]

    @Test func formatsCompactElapsedTime() {
        for (seconds, label) in Self.cases {
            #expect(AgentElapsed.compact(seconds: seconds) == label)
        }
    }

    @Test func onlySettledAgentsThatDidNotFailShowElapsedTime() {
        let start = "2026-10-07T12:00:00.000Z"
        let end = "2026-10-07T12:02:30Z"
        #expect(AgentElapsed.settledLabel(status: "completed", startedAt: start, completedAt: end) == "2m")
        #expect(AgentElapsed.settledLabel(status: "cancelled", startedAt: start, completedAt: end) == "2m")
        #expect(AgentElapsed.settledLabel(status: "failed", startedAt: start, completedAt: end) == nil)
        #expect(AgentElapsed.settledLabel(status: "running", startedAt: start, completedAt: end) == nil)
        #expect(AgentElapsed.settledLabel(status: "completed", startedAt: start, completedAt: nil) == nil)
        #expect(AgentElapsed.settledLabel(status: "completed", startedAt: nil, completedAt: end) == nil)
    }
}
