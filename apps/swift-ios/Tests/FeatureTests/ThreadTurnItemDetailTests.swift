import XCTest

@testable import T3Code

/// Ports packages/client-runtime/src/work-log/itemDetail.test.ts and covers the
/// fetch cache an open work-log row reads.
@MainActor
final class ThreadTurnItemDetailTests: XCTestCase {
    private func command(
        output: String? = nil,
        omitted: Bool = false,
        status: String = "completed",
        input: String = "vp test"
    ) -> OrchestrationV2TurnItem {
        var extra: [String: JSONValue] = ["input": .string(input)]
        if let output { extra["output"] = .string(output) }
        if omitted { extra["outputOmitted"] = .bool(true) }
        return V2Fixture.turnItem(id: "command", type: "command_execution", status: status, extra: extra)
    }

    private func tool(input: JSONValue, output: JSONValue? = nil, omitted: Bool = false) -> OrchestrationV2TurnItem {
        var extra: [String: JSONValue] = ["toolName": .string("read"), "input": input]
        if let output { extra["output"] = output }
        if omitted { extra["outputOmitted"] = .bool(true) }
        return V2Fixture.turnItem(id: "tool", type: "dynamic_tool", extra: extra)
    }

    private func row(_ item: OrchestrationV2TurnItem) -> OrchestrationV2ProjectedTurnItem {
        OrchestrationV2ProjectedTurnItem(
            position: 0, visibility: .local, sourceThreadId: "thread-v2", sourceItemId: item.id, item: item
        )
    }

    // MARK: - Presentation

    func testOnlyWithheldOutputOrSummarizedInputNeedsAFetch() {
        XCTAssertTrue(ThreadTurnItemDetail.needsFetch(command(omitted: true)))
        XCTAssertFalse(ThreadTurnItemDetail.needsFetch(command(output: "ok")))
        XCTAssertTrue(ThreadTurnItemDetail.needsFetch(
            tool(input: .object(["summary": .string("{…"), "truncated": .bool(true)]))
        ))
        XCTAssertFalse(ThreadTurnItemDetail.needsFetch(tool(input: .object(["path": .string("a")]))))
    }

    func testRowsWithoutContentOfferNoDisclosure() {
        XCTAssertFalse(ThreadTurnItemDetail.hasDetail(command(input: "  ")))
        XCTAssertTrue(ThreadTurnItemDetail.hasDetail(command(omitted: true, input: "")))
        XCTAssertFalse(ThreadTurnItemDetail.hasDetail(tool(input: .object([:]))))
        XCTAssertTrue(ThreadTurnItemDetail.hasDetail(tool(input: .object([:]), omitted: true)))
        let emptySearch = V2Fixture.turnItem(id: "search", type: "file_search", extra: ["pattern": .string(" ")])
        XCTAssertFalse(ThreadTurnItemDetail.hasDetail(emptySearch))
        let created = V2Fixture.turnItem(
            id: "created", type: "thread_created",
            extra: [
                "targetThreadId": .string("t"), "targetProviderInstanceId": .string("codex"),
                "targetModel": .string("m"),
            ]
        )
        XCTAssertFalse(ThreadTurnItemDetail.hasDetail(created))
    }

    func testRunningItemsKeepOneRevisionUntilTheyFinish() {
        XCTAssertEqual(ThreadTurnItemDetail.revision(command(status: "running")), "live")
        XCTAssertEqual(ThreadTurnItemDetail.revision(command(status: "completed")), V2Fixture.timestamp)
    }

    func testToolValuesUnwrapTextBlocksAndIndentJSONText() {
        let mcp: JSONValue = .object([
            "content": .array([.object(["type": .string("text"), "text": .string("{\"a\":1}")])]),
            "isError": .bool(false),
        ])
        XCTAssertEqual(ThreadTurnItemDetail.formatToolValue(mcp), "{\n  \"a\": 1\n}")
        XCTAssertEqual(
            ThreadTurnItemDetail.formatToolValue(.string("{\"a\":1}\n{\"b\":2}")),
            "{\n  \"a\": 1\n}\n\n{\n  \"b\": 2\n}"
        )
        XCTAssertNil(ThreadTurnItemDetail.formatToolValue(.object([:])))
        XCTAssertNil(ThreadTurnItemDetail.formatToolValue(.string("  ")))
        XCTAssertEqual(ThreadTurnItemDetail.formatToolValue(.object(["x": .bool(true)])), "{\n  \"x\": true\n}")
    }

    func testLegacyClaudeBashResultsReadAsTheirStreams() {
        let raw = #"{"stdout":"out","stderr":"","interrupted":false}"#
        XCTAssertEqual(ThreadTurnItemDetail.outputText(command(output: raw)), "out")
        XCTAssertNil(ThreadTurnItemDetail.outputText(command(output: "  ")))
        XCTAssertNil(ThreadTurnItemDetail.outputText(tool(input: .null, output: .string("x"), omitted: true)))
    }

    // MARK: - Fetch cache

    func testAnOpenRowFetchesOnceAndRendersTheFetchedOutput() async {
        var calls: [String] = []
        let store = ThreadTurnItemDetailStore { thread, item, revision in
            calls.append("\(thread)/\(item)@\(revision)")
            return self.command(output: "12 tests passed")
        }
        let wire = row(command(omitted: true))

        XCTAssertEqual(store.resolve(wire).output, .loading)
        await store.load(wire)
        await store.load(wire)

        XCTAssertEqual(calls, ["thread-v2/command@\(V2Fixture.timestamp)"])
        let resolved = store.resolve(wire)
        XCTAssertNil(resolved.output)
        let model = ThreadActivityInspector.build(
            row: resolved.row, currentThreadID: "thread-v2", currentWireThreadID: "thread-v2"
        )
        XCTAssertEqual(model.blocks.first?.value, "$ vp test\n\n12 tests passed")
    }

    func testAFailedFetchSaysWhyAndRetriesOnTheNextOpen() async {
        struct Boom: LocalizedError { var errorDescription: String? { "offline" } }
        var attempts = 0
        let store = ThreadTurnItemDetailStore { _, _, _ in
            attempts += 1
            if attempts == 1 { throw Boom() }
            return nil
        }
        let wire = row(command(omitted: true))

        await store.load(wire)
        XCTAssertEqual(store.resolve(wire).output, .failed("offline"))
        await store.load(wire)
        XCTAssertEqual(attempts, 2)
        // A deleted item answers null.
        XCTAssertEqual(store.resolve(wire).output, .failed("Output is no longer available."))
    }

    func testRowsTheWireDidNotWithholdNeverFetch() async {
        var called = false
        let store = ThreadTurnItemDetailStore { _, _, _ in
            called = true
            return nil
        }
        let wire = row(command(output: "inline"))
        await store.load(wire)
        XCTAssertFalse(called)
        XCTAssertNil(store.resolve(wire).output)
        XCTAssertEqual(store.resolve(wire).row, wire)
    }

    func testFetchedItemWithoutOutputSaysSo() async {
        let store = ThreadTurnItemDetailStore { _, _, _ in self.command() }
        let wire = row(command(omitted: true))
        await store.load(wire)
        XCTAssertEqual(store.resolve(wire).output, .empty)
    }

    func testCacheIsBounded() async {
        let store = ThreadTurnItemDetailStore(limit: 1) { _, _, _ in self.command(output: "x") }
        let first = row(command(omitted: true))
        let secondItem = V2Fixture.turnItem(
            id: "other", type: "command_execution",
            extra: ["input": .string("ls"), "outputOmitted": .bool(true)]
        )
        let second = row(secondItem)
        await store.load(first)
        await store.load(second)
        XCTAssertNil(store.entry(for: first))
        XCTAssertNotNil(store.entry(for: second))
    }
}
