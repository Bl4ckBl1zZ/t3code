import Foundation
import Testing
@testable import T3Code

/// The live reducer against the TypeScript one. `orchestrationV2Reducer.json`
/// is written by scripts/generate-swift-contract-fixtures.ts, which folds each
/// case through `applyOrchestrationV2ProjectionEvent` the way threads.ts does.
@Suite("Orchestration V2 live projection")
struct OrchestrationV2LiveProjectionTests {
    private struct Fixture: Decodable {
        struct Case: Decodable {
            let name: String
            let snapshotSequence: Int
            let projection: OrchestrationV2ThreadProjection
            let items: [OrchestrationV2ThreadStreamItem]
            let expectedSequence: Int
            let expected: OrchestrationV2ThreadProjection
        }

        let cases: [Case]
    }

    private func fixture() throws -> Fixture {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/orchestrationV2Reducer.json")
        return try JSONDecoder.t3.decode(Fixture.self, from: Data(contentsOf: url))
    }

    @Test func matchesTheTypeScriptReducerOnSharedCases() throws {
        let cases = try fixture().cases
        #expect(cases.count >= 8)
        for entry in cases {
            let snapshot = OrchestrationV2ThreadDetailSnapshot(
                snapshotSequence: entry.snapshotSequence,
                projection: entry.projection
            )

            var batched = NativeThreadDetailSync(snapshot: snapshot)
            let result = batched.receive(entry.items)
            #expect(batched.projection == entry.expected, "batched: \(entry.name)")
            #expect(batched.sequence == entry.expectedSequence, "batched cursor: \(entry.name)")
            #expect(!batched.awaitingSnapshot, "nothing should need a snapshot: \(entry.name)")
            #expect(!result.adoptedSnapshot)

            // Folding one item per batch must land in the same place.
            var single = NativeThreadDetailSync(snapshot: snapshot)
            for item in entry.items { _ = single.receive([item]) }
            #expect(single.projection == entry.expected, "single: \(entry.name)")
            #expect(single.sequence == entry.expectedSequence, "single cursor: \(entry.name)")
        }
    }

    @Test func decodingNeverThrowsForUnknownOrMalformedEvents() throws {
        let unknown = try streamItem(sequence: 4, type: "quantum.entangled", payload: .object([:]))
        guard case let .event(_, unknownEvent) = unknown, case .unknown = unknownEvent.change else {
            Issue.record("An unknown type should decode as unknown")
            return
        }
        // A known type whose payload this client cannot read must not end the
        // subscription; it becomes undecodable and waits for a snapshot.
        let malformed = try streamItem(
            sequence: 5,
            type: "run.updated",
            payload: .object(["id": .string("run-1")])
        )
        guard case let .event(_, malformedEvent) = malformed,
              case .undecodable = malformedEvent.change else {
            Issue.record("A malformed known event should decode as undecodable")
            return
        }
    }

    @Test func streamingUpdatesMutateTheTablesInPlace() throws {
        // A copy of either table per event is what made long threads O(n) per
        // token. Writing in place keeps the same storage.
        var live = OrchestrationV2LiveProjection(largeProjection(itemCount: 200))
        #expect(live.apply(commandEvent(id: "item-100", ordinal: 100, output: "warm")) == .changed)
        let items = storage(of: live.projection.turnItems)
        let rows = storage(of: live.projection.visibleTurnItems)

        for step in 0..<50 {
            let outcome = live.apply(
                commandEvent(id: "item-100", ordinal: 100, output: "token \(step)")
            )
            #expect(outcome == .changed)
            // Checked every step: a copy allocates while the original is still
            // alive, so it cannot land on the same address.
            #expect(storage(of: live.projection.turnItems) == items)
            #expect(storage(of: live.projection.visibleTurnItems) == rows)
        }

        guard case let .commandExecution(_, output, _, _) =
            live.projection.visibleTurnItems[100].item.payload else {
            Issue.record("Expected the streamed command row")
            return
        }
        #expect(output == "token 49")
        #expect(live.projection.visibleTurnItems[100].position == 100)
    }

    @Test func streamsFiveThousandEventsIntoALongThreadWithinBudget() {
        // Generous on purpose: this guards against a return to per-event
        // copies (O(events × items)), not against small regressions.
        var sync = NativeThreadDetailSync(
            snapshot: OrchestrationV2ThreadDetailSnapshot(
                snapshotSequence: 0,
                projection: largeProjection(itemCount: 2_000)
            )
        )
        let events: [OrchestrationV2ThreadStreamItem] = (1...5_000).map { step in
            let target = 1_990 + step % 10
            return .event(
                sequence: step,
                event: commandEvent(id: "item-\(target)", ordinal: target, output: "chunk \(step)")
            )
        }
        let clock = ContinuousClock()
        let elapsed = clock.measure {
            for chunk in stride(from: 0, to: events.count, by: 50) {
                _ = sync.receive(Array(events[chunk..<min(chunk + 50, events.count)]))
            }
        }
        #expect(sync.sequence == 5_000)
        #expect(sync.projection?.visibleTurnItems.count == 2_000)
        #expect(elapsed < .seconds(5))
    }

    // MARK: - Helpers

    private func storage<Element>(of array: [Element]) -> UnsafeRawPointer? {
        array.withUnsafeBufferPointer { UnsafeRawPointer($0.baseAddress) }
    }

    private func largeProjection(itemCount: Int) -> OrchestrationV2ThreadProjection {
        let items = (0..<itemCount).map { index in
            V2Fixture.turnItem(
                id: "item-\(index)",
                type: "command_execution",
                ordinal: index,
                extra: ["input": .string("pwd"), "output": .string("start"), "exitCode": .number(0)]
            )
        }
        return V2Fixture.projection(items: items)
    }

    private func commandEvent(id: String, ordinal: Int, output: String) -> OrchestrationV2ThreadEvent {
        OrchestrationV2ThreadEvent(
            type: "turn-item.updated",
            threadId: "thread-v2",
            occurredAt: V2Fixture.timestamp,
            change: .turnItem(
                V2Fixture.turnItem(
                    id: id,
                    type: "command_execution",
                    status: "running",
                    ordinal: ordinal,
                    extra: ["input": .string("pwd"), "output": .string(output), "exitCode": .null]
                )
            )
        )
    }

    private func streamItem(
        sequence: Int,
        type: String,
        payload: JSONValue
    ) throws -> OrchestrationV2ThreadStreamItem {
        let json = JSONValue.object([
            "kind": .string("event"),
            "sequence": .number(Double(sequence)),
            "event": .object([
                "id": .string("event-\(sequence)"),
                "type": .string(type),
                "threadId": .string("thread-v2"),
                "occurredAt": .string(V2Fixture.timestamp),
                "payload": payload,
            ]),
        ])
        return try JSONDecoder.t3.decode(
            OrchestrationV2ThreadStreamItem.self,
            from: JSONEncoder.t3.encode(json)
        )
    }
}
