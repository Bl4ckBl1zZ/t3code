import Foundation
import Testing
@testable import T3Code

@Suite("Thread detail stream sync")
struct NativeThreadDetailSyncTests {
    @Test func anUndecodableEventHoldsLaterEventsUntilASnapshotThenReplaysThem() {
        var sync = NativeThreadDetailSync(snapshot: snapshot(sequence: 4, text: "four"))

        let held = sync.receive([
            .event(sequence: 5, event: undecodable("run.updated")),
            .event(sequence: 6, event: assistant("six")),
            .event(sequence: 7, event: assistant("seven")),
        ])

        // Nothing folds past the event that could not be read, and nothing is
        // dropped either: the projection stays readable at its last good state.
        #expect(!held.changed)
        #expect(sync.awaitingSnapshot)
        #expect(sync.holdReason == "undecodable:run.updated")
        #expect(sync.sequence == 4)
        #expect(text(sync.projection) == "four")

        // The refresh answers at sequence 6; only 7 is newer, so only 7 replays.
        let adopted = sync.adopt(snapshot(sequence: 6, text: "six from server"))
        #expect(adopted?.adoptedSnapshot == true)
        #expect(!sync.awaitingSnapshot)
        #expect(sync.sequence == 7)
        #expect(text(sync.projection) == "seven")
    }

    @Test func aSnapshotOlderThanTheHeldProjectionIsRejectedAndKeepsIt() {
        var sync = NativeThreadDetailSync(snapshot: snapshot(sequence: 10, text: "ten"))

        #expect(sync.adopt(snapshot(sequence: 8, text: "eight")) == nil)

        #expect(sync.sequence == 10)
        #expect(text(sync.projection) == "ten")
    }

    @Test func aCachedProjectionTakesTheServersSnapshotEvenAtALowerSequence() {
        let cached = snapshot(sequence: 10, text: "cached")
        var sync = NativeThreadDetailSync(
            projection: cached.projection,
            sequence: 10,
            provisional: true
        )
        #expect(sync.isProvisional)

        // The server's store was reset: its snapshot is older than the cache.
        _ = sync.receive([.snapshot(snapshot(sequence: 3, text: "server"))])

        #expect(!sync.isProvisional)
        #expect(sync.sequence == 3)
        #expect(text(sync.projection) == "server")
        // Confirmed now, so an older snapshot is a stale one again.
        #expect(sync.adopt(snapshot(sequence: 2, text: "stale")) == nil)
    }

    @Test func aCachedProjectionIsConfirmedByAReplayedGap() {
        let cached = snapshot(sequence: 10, text: "cached")
        var sync = NativeThreadDetailSync(
            projection: cached.projection,
            sequence: 10,
            provisional: true
        )

        _ = sync.receive([.event(sequence: 11, event: assistant("eleven"))])

        #expect(!sync.isProvisional)
        #expect(sync.sequence == 11)
        #expect(sync.adopt(snapshot(sequence: 9, text: "older")) == nil)
    }

    @Test func aSnapshotStillOlderThanTheUndecodableEventKeepsHolding() {
        var sync = NativeThreadDetailSync(snapshot: snapshot(sequence: 4, text: "four"))
        _ = sync.receive([
            .event(sequence: 5, event: assistant("five")),
            .event(sequence: 6, event: undecodable("message.updated")),
            .event(sequence: 7, event: assistant("seven")),
        ])
        #expect(sync.sequence == 5)

        // A snapshot from before 6 replays 6 again, which still cannot fold.
        #expect(sync.adopt(snapshot(sequence: 5, text: "five")) != nil)
        #expect(sync.awaitingSnapshot)
        #expect(sync.sequence == 5)

        _ = sync.adopt(snapshot(sequence: 7, text: "seven from server"))
        #expect(!sync.awaitingSnapshot)
        #expect(text(sync.projection) == "seven from server")
    }

    @Test func eventsBeforeAnyProjectionWaitForTheFirstSnapshot() {
        var sync = NativeThreadDetailSync(awaitingSnapshotAfter: 0)
        _ = sync.receive([.event(sequence: 3, event: assistant("three"))])
        #expect(sync.awaitingSnapshot)
        #expect(sync.projection == nil)

        let result = sync.receive([.snapshot(snapshot(sequence: 2, text: "two"))])

        #expect(result.adoptedSnapshot)
        #expect(sync.sequence == 3)
        #expect(text(sync.projection) == "three")
    }

    @Test func gapsAndReplaysFollowTheSequenceNotItsContiguity() {
        var sync = NativeThreadDetailSync(snapshot: snapshot(sequence: 10, text: "ten"))
        let result = sync.receive([
            .event(sequence: 9, event: assistant("replayed")),
            .event(sequence: 25, event: assistant("twenty-five")),
            .event(sequence: 20, event: assistant("late")),
            .synchronized,
        ])
        #expect(result.changed)
        #expect(result.synchronized)
        #expect(sync.sequence == 25)
        #expect(text(sync.projection) == "twenty-five")
    }

    // MARK: - Restart backoff

    @Test func restartDelaysDoubleToTheCapAndJitterWithinTheUpperHalf() {
        var backoff = NativeDetailStreamBackoff(base: .seconds(1), cap: .seconds(8))
        #expect(backoff.nextDelay(unit: 0) == .milliseconds(500))
        #expect(backoff.nextDelay(unit: 1) == .seconds(2))
        #expect(backoff.nextDelay(unit: 0) == .seconds(2))
        #expect(backoff.nextDelay(unit: 1) == .seconds(8))
        #expect(backoff.nextDelay(unit: 1) == .seconds(8))
        #expect(backoff.nextDelay(unit: 0.5) == .seconds(6))
        #expect(backoff.attempt == 6)

        backoff.reset()
        #expect(backoff.attempt == 0)
        #expect(backoff.nextDelay(unit: 1) == .seconds(1))
    }

    @Test func restartDelaysStayBoundedAfterManyFailures() {
        var backoff = NativeDetailStreamBackoff()
        for _ in 0..<200 { _ = backoff.nextDelay(unit: 1) }
        #expect(backoff.nextDelay(unit: 1) == .seconds(30))
    }

    // MARK: - Inbox

    @Test func theInboxHandsOverEverythingThatArrivedAsOneBatch() async {
        let inbox = NativeThreadDetailInbox(after: 4)
        let (source, continuation) = AsyncThrowingStream<OrchestrationV2ThreadStreamItem, Error>
            .makeStream()
        continuation.yield(.event(sequence: 5, event: assistant("five")))
        continuation.yield(.snapshot(snapshot(sequence: 9, text: "nine")))
        continuation.yield(.event(sequence: 7, event: assistant("seven")))
        continuation.yield(.synchronized)
        continuation.finish()

        await inbox.pump(source)

        let batch = inbox.drain()
        #expect(batch.count == 4)
        #expect(inbox.drain().isEmpty)
        #expect(inbox.resumeSequence == 9)
        guard case .finished = inbox.ending else {
            Issue.record("A finished source should end the inbox cleanly")
            return
        }
    }

    @Test func theInboxRecordsWhyTheSourceFailed() async {
        struct Dropped: Error {}
        let inbox = NativeThreadDetailInbox(after: 0)
        let (source, continuation) = AsyncThrowingStream<OrchestrationV2ThreadStreamItem, Error>
            .makeStream()
        continuation.finish(throwing: Dropped())

        await inbox.pump(source)

        guard case .failed = inbox.ending else {
            Issue.record("A failed source should be reported")
            return
        }
        #expect(inbox.resumeSequence == 0)
    }

    // MARK: - Helpers

    private func snapshot(sequence: Int, text: String) -> OrchestrationV2ThreadDetailSnapshot {
        OrchestrationV2ThreadDetailSnapshot(
            snapshotSequence: sequence,
            projection: V2Fixture.projection(
                items: [V2Fixture.assistantMessage(id: "item-1", text: text)]
            )
        )
    }

    private func assistant(_ text: String) -> OrchestrationV2ThreadEvent {
        OrchestrationV2ThreadEvent(
            type: "turn-item.updated",
            threadId: "thread-v2",
            occurredAt: V2Fixture.timestamp,
            change: .turnItem(V2Fixture.assistantMessage(id: "item-1", text: text))
        )
    }

    private func undecodable(_ type: String) -> OrchestrationV2ThreadEvent {
        OrchestrationV2ThreadEvent(
            type: type,
            threadId: "thread-v2",
            occurredAt: V2Fixture.timestamp,
            change: .undecodable
        )
    }

    private func text(_ projection: OrchestrationV2ThreadProjection?) -> String? {
        guard let row = projection?.visibleTurnItems.first,
              case let .assistantMessage(_, text, _) = row.item.payload else { return nil }
        return text
    }
}
