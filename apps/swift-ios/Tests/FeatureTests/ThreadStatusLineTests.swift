import Foundation
import Testing
@testable import T3Code

struct ThreadStatusLineTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func thread(
        settled: Bool = false,
        settledAt: Date? = nil,
        snoozedUntil: Date? = nil,
        archived: Bool = false,
        supported: Bool = true
    ) -> FeatureThread {
        FeatureThread(
            id: "t", projectID: "p", title: "T",
            state: .completed,
            isArchived: archived,
            isSettled: settled,
            settledAt: settledAt,
            snoozedUntil: snoozedUntil,
            snoozedAt: snoozedUntil.map { _ in now.addingTimeInterval(-60) },
            supportsSettlement: supported,
            supportsSnooze: supported
        )
    }

    @Test func settledThreadsSayWhenWithAWayOut() throws {
        let line = try #require(ThreadStatusLine.resolve(thread(settled: true, settledAt: now.addingTimeInterval(-2 * 86_400)), now: now))
        #expect(line.kind == .settled)
        #expect(line.label.hasPrefix("Settled "))
        #expect(line.label != "Settled")
        #expect(line.actionLabel == "Un-settle")
        #expect(ThreadStatusLine.resolve(thread(settled: true), now: now)?.label == "Settled")
    }

    @Test func snoozeWinsOverSettledAndOffersWakeNow() throws {
        let line = try #require(ThreadStatusLine.resolve(
            thread(settled: true, settledAt: now, snoozedUntil: now.addingTimeInterval(3 * 3_600)), now: now
        ))
        #expect(line.kind == .snoozed)
        #expect(line.label.hasPrefix("Snoozed, "))
        #expect(line.actionLabel == "Wake now")
    }

    @Test func noLineForOpenArchivedOrUnsupportedThreads() {
        #expect(ThreadStatusLine.resolve(thread(), now: now) == nil)
        #expect(ThreadStatusLine.resolve(thread(settled: true, archived: true), now: now) == nil)
        #expect(ThreadStatusLine.resolve(thread(settled: true, supported: false), now: now) == nil)
        // A snooze that already ran out says nothing.
        #expect(ThreadStatusLine.resolve(thread(snoozedUntil: now.addingTimeInterval(-60)), now: now) == nil)
    }
}
