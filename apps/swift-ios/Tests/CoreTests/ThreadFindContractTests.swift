import XCTest
@testable import T3Code

/// `orchestration.searchThread` / `searchThreadStream` and the capability flags
/// that gate them, against packages/contracts/src/orchestrationV2.ts and server.ts.
final class ThreadFindContractTests: XCTestCase {
    func testFinalResultDecodesWithNavigation() throws {
        let json = #"""
        {"snapshotSequence":42,"totalMatches":5,"activeIndex":3,
         "match":{"entryId":"message-2","runId":"run-1","occurrence":1},
         "navigation":[
           {"entryId":"message-1","runId":null,"startIndex":0,"count":2},
           {"entryId":"message-2","runId":"run-1","startIndex":2,"count":2},
           {"entryId":"plan-item","runId":"run-1","startIndex":4,"count":1}
         ]}
        """#
        let result = try JSONDecoder().decode(ThreadFindResult.self, from: Data(json.utf8))
        XCTAssertNil(result.complete)
        XCTAssertFalse(result.isCounting)
        XCTAssertEqual(result.snapshotSequence, 42)
        XCTAssertEqual(result.totalMatches, 5)
        XCTAssertEqual(result.activeIndex, 3)
        XCTAssertEqual(result.match, ThreadFindMatch(entryId: "message-2", runId: "run-1", occurrence: 1))
        XCTAssertEqual(result.navigation?.map(\.entryId), ["message-1", "message-2", "plan-item"])
        XCTAssertNil(result.navigation?[0].runId)
        XCTAssertEqual(result.navigation?[2].startIndex, 4)
    }

    func testProgressiveEarlyFrameAndNoMatchDecode() throws {
        let early = try JSONDecoder().decode(ThreadFindResult.self, from: Data(#"""
        {"complete":false,"snapshotSequence":7,"totalMatches":1,"activeIndex":0,
         "match":{"entryId":"message-9","runId":null,"occurrence":0}}
        """#.utf8))
        XCTAssertTrue(early.isCounting)
        XCTAssertNil(early.navigation)

        let none = try JSONDecoder().decode(ThreadFindResult.self, from: Data(#"""
        {"complete":true,"snapshotSequence":7,"totalMatches":0,"activeIndex":0,"match":null,"navigation":[]}
        """#.utf8))
        XCTAssertFalse(none.isCounting)
        XCTAssertNil(none.match)
        XCTAssertEqual(none.totalMatches, 0)
    }

    func testServerConfigCarriesFindCapabilities() throws {
        let both = try JSONDecoder().decode(
            ServerConfigSnapshot.self,
            from: Data(#"{"providers":[],"threadFind":true,"threadFindProgressive":true}"#.utf8)
        )
        XCTAssertEqual(both.threadFind, true)
        XCTAssertEqual(both.threadFindProgressive, true)

        let older = try JSONDecoder().decode(ServerConfigSnapshot.self, from: Data(#"{"providers":[]}"#.utf8))
        XCTAssertNil(older.threadFind)
        XCTAssertNil(older.threadFindProgressive)

        let roundTrip = try JSONDecoder().decode(ServerConfigSnapshot.self, from: JSONEncoder().encode(both))
        XCTAssertEqual(roundTrip.threadFind, true)
        XCTAssertEqual(roundTrip.threadFindProgressive, true)
    }

    func testQueryTrimsAndRejectsWhatTheServerWould() throws {
        XCTAssertNil(ThreadFindQuery(query: ""))
        XCTAssertNil(ThreadFindQuery(query: "   \n"))
        XCTAssertEqual(ThreadFindQuery(query: "  needle ")?.query, "needle")
        let long = try XCTUnwrap(ThreadFindQuery(query: String(repeating: "a", count: 250)))
        XCTAssertEqual(long.query.count, ThreadFindQuery.maxQueryLength)
    }

    func testPayloadOmitsUnsetOptionalKeys() throws {
        let query = try XCTUnwrap(ThreadFindQuery(query: "needle"))
        XCTAssertEqual(query.payload(threadID: "thread-1"), .object([
            "threadId": .string("thread-1"),
            "query": .string("needle"),
            "skills": .array([]),
        ]))
    }

    func testPayloadCarriesAnchorOffsetIndexAndSkillLabels() throws {
        let query = try XCTUnwrap(ThreadFindQuery(
            query: "needle",
            skills: [
                ThreadFindSkillLabel(name: "review", displayName: "Code Review"),
                ThreadFindSkillLabel(name: "plain", displayName: nil),
                ThreadFindSkillLabel(name: String(repeating: "x", count: 201), displayName: nil),
            ],
            index: 4,
            start: ThreadFindStart(entryId: "message-1", occurrence: 2),
            offset: -1
        ))
        XCTAssertEqual(query.payload(threadID: "thread-1"), .object([
            "threadId": .string("thread-1"),
            "query": .string("needle"),
            "skills": .array([
                .object(["name": .string("review"), "displayName": .string("Code Review")]),
                .object(["name": .string("plain")]),
            ]),
            "index": .integer(4),
            "start": .object(["entryId": .string("message-1"), "occurrence": .integer(2)]),
            "offset": .integer(-1),
        ]))
    }
}
