import XCTest

@testable import T3Code

/// Find in Thread's client half (web's `useThreadFind` / `threadFind.ts`):
/// stepping locally through the navigation window, wrapping, falling back to a
/// relative request, and how entries are named.
@MainActor
final class ThreadFindTests: XCTestCase {
    // MARK: - Stepping

    func testWrapMovesAndWrapsBothWays() {
        XCTAssertEqual(ThreadFindNavigation.wrap(0, total: 5, delta: 1), 1)
        XCTAssertEqual(ThreadFindNavigation.wrap(4, total: 5, delta: 1), 0)
        XCTAssertEqual(ThreadFindNavigation.wrap(0, total: 5, delta: -1), 4)
        XCTAssertEqual(ThreadFindNavigation.wrap(2, total: 5, delta: -7), 0)
        XCTAssertEqual(ThreadFindNavigation.wrap(9, total: 5, delta: 0), 4)
        XCTAssertEqual(ThreadFindNavigation.wrap(3, total: 0, delta: 1), 0)
    }

    func testStepInsideTheWindowNamesTheNextEntryLocally() {
        let result = Self.result(activeIndex: 1, match: ("a", 1))
        let selection = ThreadFindSelection(activeIndex: 1, match: ThreadFindMatch(entryId: "a", runId: "run-a", occurrence: 1))
        XCTAssertEqual(
            ThreadFindNavigation.step(result: result, selection: selection, delta: 1),
            .local(ThreadFindSelection(activeIndex: 2, match: ThreadFindMatch(entryId: "b", runId: nil, occurrence: 0)))
        )
        XCTAssertEqual(
            ThreadFindNavigation.step(result: result, selection: selection, delta: -1),
            .local(ThreadFindSelection(activeIndex: 0, match: ThreadFindMatch(entryId: "a", runId: "run-a", occurrence: 0)))
        )
    }

    func testStepWrapsFromLastMatchToFirst() {
        let result = Self.result(activeIndex: 4, match: ("c", 0))
        let last = ThreadFindSelection(activeIndex: 4, match: ThreadFindMatch(entryId: "c", runId: "run-c", occurrence: 0))
        XCTAssertEqual(
            ThreadFindNavigation.step(result: result, selection: last, delta: 1),
            .local(ThreadFindSelection(activeIndex: 0, match: ThreadFindMatch(entryId: "a", runId: "run-a", occurrence: 0)))
        )
        let first = ThreadFindSelection(activeIndex: 0, match: ThreadFindMatch(entryId: "a", runId: "run-a", occurrence: 0))
        XCTAssertEqual(
            ThreadFindNavigation.step(result: result, selection: first, delta: -1),
            .local(ThreadFindSelection(activeIndex: 4, match: ThreadFindMatch(entryId: "c", runId: "run-c", occurrence: 0)))
        )
    }

    func testStepOutsideTheWindowAsksRelativeToTheSelection() {
        // 40 matches, but the window only covers ordinals 10..<14.
        let result = ThreadFindResult(
            snapshotSequence: 1, totalMatches: 40, activeIndex: 13,
            match: ThreadFindMatch(entryId: "m", runId: nil, occurrence: 3),
            navigation: [ThreadFindNavigationEntry(entryId: "m", runId: nil, startIndex: 10, count: 4)]
        )
        let selection = ThreadFindSelection(activeIndex: 13, match: ThreadFindMatch(entryId: "m", runId: nil, occurrence: 3))
        XCTAssertEqual(
            ThreadFindNavigation.step(result: result, selection: selection, delta: 1),
            .remote(start: ThreadFindStart(entryId: "m", occurrence: 3), offset: 1)
        )
    }

    func testNothingToStepWhileCountingOrWithoutMatches() {
        let match = ThreadFindMatch(entryId: "a", runId: nil, occurrence: 0)
        let selection = ThreadFindSelection(activeIndex: 0, match: match)
        let counting = ThreadFindResult(complete: false, snapshotSequence: 1, totalMatches: 1, activeIndex: 0, match: match)
        XCTAssertNil(ThreadFindNavigation.step(result: counting, selection: selection, delta: 1))
        let empty = ThreadFindResult(snapshotSequence: 1, totalMatches: 0, activeIndex: 0, match: nil, navigation: [])
        XCTAssertNil(ThreadFindNavigation.step(result: empty, selection: nil, delta: 1))
    }

    func testCountLabel() {
        XCTAssertNil(ThreadFindNavigation.countLabel(result: nil, selection: nil))
        XCTAssertEqual(ThreadFindNavigation.countLabel(result: Self.result(activeIndex: 1, match: ("a", 1)), selection: nil), "2 of 5")
        let local = ThreadFindSelection(activeIndex: 3, match: ThreadFindMatch(entryId: "b", runId: nil, occurrence: 1))
        XCTAssertEqual(ThreadFindNavigation.countLabel(result: Self.result(activeIndex: 1, match: ("a", 1)), selection: local), "4 of 5")
        let counting = ThreadFindResult(complete: false, snapshotSequence: 1, totalMatches: 1, activeIndex: 0,
            match: ThreadFindMatch(entryId: "a", runId: nil, occurrence: 0))
        XCTAssertEqual(ThreadFindNavigation.countLabel(result: counting, selection: nil), "1 of …")
        let empty = ThreadFindResult(snapshotSequence: 1, totalMatches: 0, activeIndex: 0, match: nil)
        XCTAssertEqual(ThreadFindNavigation.countLabel(result: empty, selection: nil), "No results")
    }

    // MARK: - Text

    func testOccurrencesAreCaseInsensitiveAndDoNotOverlap() {
        XCTAssertEqual(ThreadFindText.occurrences(of: "Needle", in: "a needle, a NEEDLE"),
            [NSRange(location: 2, length: 6), NSRange(location: 12, length: 6)])
        XCTAssertEqual(ThreadFindText.occurrences(of: "aa", in: "aaa"), [NSRange(location: 0, length: 2)])
        XCTAssertEqual(ThreadFindText.occurrences(of: "  ", in: "a  b"), [])
        XCTAssertEqual(ThreadFindText.occurrences(of: "x", in: ""), [])
    }

    // MARK: - Entry identity

    func testEntriesAreNamedLikeTheServerNamesThem() throws {
        let user = FeatureMessage(id: "item-u", role: .user, text: "hi", wireMessageID: "message-u")
        let assistant = FeatureMessage(id: "item-a", role: .assistant, text: "hello", wireMessageID: "message-a")
        let tool = FeatureMessage(id: "item-t", role: .tool, text: "ls", wireMessageID: "message-t")
        XCTAssertEqual(ThreadTimelineEntry.message(user).findEntryID, "message-u")
        XCTAssertEqual(ThreadTimelineEntry.message(assistant).findEntryID, "message-a")
        XCTAssertNil(ThreadTimelineEntry.message(tool).findEntryID)

        let item = V2Fixture.turnItem(id: "plan-item", type: "proposed_plan", extra: [
            "planId": .string("plan-1"),
            "markdown": .string("# Ship it\n\n- step"),
            "streaming": .bool(false),
        ])
        let projected = OrchestrationV2ProjectedTurnItem(
            position: 0, visibility: .local, sourceThreadId: "parent", sourceItemId: "plan-item", item: item
        )
        let plan = try XCTUnwrap(ThreadProposedPlan(projected))
        XCTAssertEqual(ThreadTimelineEntry.proposedPlan(ThreadProposedPlanEntry(plan: plan, isSuperseded: false)).findEntryID, "plan-item")
    }

    // MARK: - Model

    func testLocalStepsDoNotAskTheServer() async throws {
        let server = StubFind(results: [Self.result(activeIndex: 0, match: ("a", 0))])
        let model = ThreadFindModel()
        model.open(threadID: "thread", progressive: false, search: server.search)
        model.setQuery("needle")
        await model.settle()
        XCTAssertEqual(server.requests.count, 1)
        XCTAssertEqual(model.countLabel, "1 of 5")
        XCTAssertEqual(model.highlight.activeEntryID, "a")
        XCTAssertEqual(model.reveal?.match.entryId, "a")

        model.next()
        model.next()
        XCTAssertEqual(server.requests.count, 1)
        XCTAssertEqual(model.countLabel, "3 of 5")
        XCTAssertEqual(model.selection?.match, ThreadFindMatch(entryId: "b", runId: nil, occurrence: 0))
        XCTAssertEqual(model.highlight.activeEntryID, "b")
        XCTAssertEqual(model.reveal?.match.entryId, "b")
    }

    func testStepsPastTheWindowAskRelativeToTheSelection() async throws {
        let first = ThreadFindResult(
            snapshotSequence: 1, totalMatches: 40, activeIndex: 13,
            match: ThreadFindMatch(entryId: "m", runId: nil, occurrence: 3),
            navigation: [ThreadFindNavigationEntry(entryId: "m", runId: nil, startIndex: 10, count: 4)]
        )
        let next = ThreadFindResult(
            snapshotSequence: 1, totalMatches: 40, activeIndex: 14,
            match: ThreadFindMatch(entryId: "n", runId: nil, occurrence: 0),
            navigation: [ThreadFindNavigationEntry(entryId: "n", runId: nil, startIndex: 14, count: 1)]
        )
        let server = StubFind(results: [first, next])
        let model = ThreadFindModel()
        model.open(threadID: "thread", progressive: true, search: server.search)
        model.setQuery(" needle ")
        await model.settle()
        XCTAssertEqual(server.requests.first?.query.query, "needle")
        XCTAssertEqual(server.requests.first?.progressive, true)

        model.next()
        await model.settle()
        let step = try XCTUnwrap(server.requests.last)
        XCTAssertEqual(step.query.start, ThreadFindStart(entryId: "m", occurrence: 3))
        XCTAssertEqual(step.query.offset, 1)
        // Relative steps need the final count, so they never stream.
        XCTAssertFalse(step.progressive)
        XCTAssertEqual(model.countLabel, "15 of 40")
        XCTAssertEqual(model.highlight.activeEntryID, "n")
    }

    func testProgressiveEarlyFrameBlocksSteppingUntilTheCountLands() async throws {
        let match = ThreadFindMatch(entryId: "a", runId: nil, occurrence: 0)
        let server = StubFind(results: [], gated: true)
        let model = ThreadFindModel()
        model.open(threadID: "thread", progressive: true, search: server.search)
        model.setQuery("needle")
        let continuation = try await server.nextContinuation()
        continuation.yield(ThreadFindResult(complete: false, snapshotSequence: 1, totalMatches: 1, activeIndex: 0, match: match))
        continuation.yield(Self.result(activeIndex: 0, match: ("a", 0)))
        continuation.finish()
        await model.settle()
        XCTAssertTrue(model.canStep)
        XCTAssertEqual(model.countLabel, "1 of 5")
        // Finishing the count kept the match, so it asked for one reveal only.
        XCTAssertEqual(model.reveal?.id, 1)
    }

    func testFailureReportsAndRetrySucceeds() async throws {
        let server = StubFind(results: [Self.result(activeIndex: 0, match: ("a", 0))], failuresFirst: 1)
        let model = ThreadFindModel()
        model.open(threadID: "thread", progressive: false, search: server.search)
        model.setQuery("needle")
        await model.settle()
        XCTAssertEqual(model.status, .failed)
        XCTAssertEqual(model.countLabel, "Search failed")

        model.retry()
        await model.settle()
        XCTAssertEqual(model.status, .idle)
        XCTAssertEqual(model.countLabel, "1 of 5")
    }

    func testNoMatchesAndCloseClearWhatTheTranscriptPaints() async throws {
        let empty = ThreadFindResult(snapshotSequence: 1, totalMatches: 0, activeIndex: 0, match: nil, navigation: [])
        let server = StubFind(results: [empty, Self.result(activeIndex: 0, match: ("a", 0))])
        let model = ThreadFindModel()
        model.open(threadID: "thread", progressive: false, search: server.search)
        model.setQuery("zzz")
        await model.settle()
        XCTAssertTrue(model.hasNoResults)
        XCTAssertEqual(model.countLabel, "No results")
        XCTAssertEqual(model.highlight.query, "")
        XCTAssertNil(model.reveal)

        model.setQuery("needle")
        await model.settle()
        XCTAssertEqual(model.highlight.query, "needle")

        model.close()
        XCTAssertFalse(model.isOpen)
        XCTAssertEqual(model.query, "")
        XCTAssertNil(model.result)
        XCTAssertEqual(model.highlight.query, "")
        XCTAssertNil(model.highlight.activeEntryID)
    }

    func testNewQueryStartsFromTheReadingPosition() async throws {
        let server = StubFind(results: [Self.result(activeIndex: 0, match: ("a", 0))])
        let model = ThreadFindModel()
        model.readingPosition = { ThreadFindStart(entryId: "visible", occurrence: 0) }
        model.open(threadID: "thread", progressive: false, search: server.search)
        model.setQuery("needle")
        await model.settle()
        XCTAssertEqual(server.requests.first?.query.start, ThreadFindStart(entryId: "visible", occurrence: 0))
        XCTAssertEqual(server.requests.first?.query.offset, 0)
    }

    // MARK: - Fixtures

    /// Five matches: two in "a", two in "b", one in "c".
    private static func result(activeIndex: Int, match: (String, Int)) -> ThreadFindResult {
        let navigation = [
            ThreadFindNavigationEntry(entryId: "a", runId: "run-a", startIndex: 0, count: 2),
            ThreadFindNavigationEntry(entryId: "b", runId: nil, startIndex: 2, count: 2),
            ThreadFindNavigationEntry(entryId: "c", runId: "run-c", startIndex: 4, count: 1),
        ]
        let runID = navigation.first { $0.entryId == match.0 }?.runId
        return ThreadFindResult(
            snapshotSequence: 1, totalMatches: 5, activeIndex: activeIndex,
            match: ThreadFindMatch(entryId: match.0, runId: runID, occurrence: match.1),
            navigation: navigation
        )
    }
}

/// Answers searches from a script and records what was asked.
@MainActor
private final class StubFind {
    struct Request {
        let query: ThreadFindQuery
        let progressive: Bool
    }

    private(set) var requests: [Request] = []
    private var results: [ThreadFindResult]
    private var failuresLeft: Int
    private let gated: Bool
    private var continuations: [AsyncThrowingStream<ThreadFindResult, Error>.Continuation] = []
    private var waiters: [CheckedContinuation<AsyncThrowingStream<ThreadFindResult, Error>.Continuation, Never>] = []

    init(results: [ThreadFindResult], failuresFirst: Int = 0, gated: Bool = false) {
        self.results = results
        failuresLeft = failuresFirst
        self.gated = gated
    }

    var search: ThreadFindModel.Search {
        { [self] query, progressive in
            requests.append(Request(query: query, progressive: progressive))
            return AsyncThrowingStream { continuation in
                if gated {
                    if waiters.isEmpty { continuations.append(continuation) } else { waiters.removeFirst().resume(returning: continuation) }
                    return
                }
                if failuresLeft > 0 {
                    failuresLeft -= 1
                    continuation.finish(throwing: RPCError.remote("Could not search this thread. Please retry."))
                    return
                }
                if !results.isEmpty { continuation.yield(results.removeFirst()) }
                continuation.finish()
            }
        }
    }

    /// The stream a gated search hands out, once the model has asked.
    func nextContinuation() async throws -> AsyncThrowingStream<ThreadFindResult, Error>.Continuation {
        if !continuations.isEmpty { return continuations.removeFirst() }
        return await withCheckedContinuation { waiters.append($0) }
    }
}
