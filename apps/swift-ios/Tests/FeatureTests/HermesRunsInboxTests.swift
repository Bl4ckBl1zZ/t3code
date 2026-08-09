import Foundation
import XCTest

@testable import T3Code

/// Covers the Hermes runs inbox: the wire shape it decodes, the labels the rows
/// promise, and the store the badge and the list share.
final class HermesRunsInboxTests: XCTestCase {
    // MARK: - Wire shape

    /// The Swift client mirrors `packages/contracts/src/hermesProactive.ts` by
    /// hand, so a contract rename compiles clean here and fails on a phone.
    /// This payload is the contract's own field spelling.
    func testInboxSnapshotDecodesTheContractPayload() throws {
        let json = Data(
            """
            {
              "notifications": [
                {
                  "notificationId": "hermes-notification:abc",
                  "eventId": "hermes-event:abc",
                  "workItemId": "hermes-work:abc",
                  "projectId": null,
                  "threadId": "thread:outreach",
                  "title": "Hermes finished a run you did not start",
                  "body": "Checked the inbox and sent 50 emails.",
                  "status": "unread",
                  "createdAt": "2026-08-09T02:14:00.000Z",
                  "updatedAt": "2026-08-09T02:14:00.000Z"
                }
              ],
              "unreadCount": 1,
              "deadLetterCount": 0
            }
            """.utf8
        )

        let snapshot = try JSONDecoder().decode(HermesProactiveInboxSnapshot.self, from: json)
        XCTAssertEqual(snapshot.unreadCount, 1)
        XCTAssertEqual(snapshot.deadLetterCount, 0)
        XCTAssertEqual(snapshot.notifications.first?.threadId, "thread:outreach")
        XCTAssertEqual(snapshot.notifications.first?.status, "unread")
        XCTAssertNil(snapshot.notifications.first?.projectId)
    }

    /// A job the gateway never bound to a session produces a run with no thread,
    /// which the row has to render rather than drop.
    func testNotificationDecodesWithoutAThread() throws {
        let json = Data(
            """
            {
              "notifications": [
                {
                  "notificationId": "n1", "eventId": "e1", "workItemId": "w1",
                  "projectId": null, "threadId": null,
                  "title": "“inbox sweep” ran while T3 was closed",
                  "body": "T3 was not connected when this run finished.",
                  "status": "read",
                  "createdAt": "2026-08-09T02:14:00.000Z",
                  "updatedAt": "2026-08-09T02:14:00.000Z"
                }
              ],
              "unreadCount": 0,
              "deadLetterCount": 2
            }
            """.utf8
        )

        let snapshot = try JSONDecoder().decode(HermesProactiveInboxSnapshot.self, from: json)
        XCTAssertNil(snapshot.notifications.first?.threadId)
        XCTAssertEqual(snapshot.deadLetterCount, 2)
    }

    // MARK: - Labels

    func testEveryRowActionOffersItsReverse() {
        XCTAssertEqual(HermesRunLabels.readToggleTitle(.unread), "Mark Read")
        XCTAssertEqual(HermesRunLabels.readToggleTarget(.unread), .read)
        XCTAssertEqual(HermesRunLabels.readToggleTitle(.read), "Mark Unread")
        XCTAssertEqual(HermesRunLabels.readToggleTarget(.read), .unread)

        XCTAssertEqual(HermesRunLabels.dismissToggleTitle(.read), "Dismiss")
        XCTAssertEqual(HermesRunLabels.dismissToggleTarget(.read), .dismissed)
        XCTAssertEqual(HermesRunLabels.dismissToggleTitle(.dismissed), "Restore")
        // Restoring lands on read rather than unread: the reader has already
        // seen this row, they only changed their mind about hiding it.
        XCTAssertEqual(HermesRunLabels.dismissToggleTarget(.dismissed), .read)
    }

    func testBadgeCapsAtNinetyNinePlusAndDisappearsWhenRead() {
        XCTAssertNil(HermesRunLabels.badgeText(unreadCount: 0))
        XCTAssertEqual(HermesRunLabels.badgeText(unreadCount: 3), "3")
        XCTAssertEqual(HermesRunLabels.badgeText(unreadCount: 99), "99")
        XCTAssertEqual(HermesRunLabels.badgeText(unreadCount: 240), "99+")
    }

    func testDeadLetterWarningIsSilentUntilSomethingFails() {
        XCTAssertNil(HermesRunLabels.deadLetterWarning(count: 0))
        XCTAssertEqual(
            HermesRunLabels.deadLetterWarning(count: 1),
            "1 notification could not be delivered and was given up on."
        )
        XCTAssertEqual(
            HermesRunLabels.deadLetterWarning(count: 4),
            "4 notifications could not be delivered and were given up on."
        )
    }

    /// Timestamps come back verbatim from the server; a value this build cannot
    /// parse is shown rather than swallowed.
    func testRelativeTimeFallsBackToTheRawInstant() {
        let now = Date(timeIntervalSince1970: 1_785_000_000)
        XCTAssertEqual(HermesRunLabels.relativeTime("not a date", now: now), "not a date")
        XCTAssertNotNil(HermesRunLabels.date(from: "2026-08-09T02:14:00.000Z"))
        // Servers that omit fractional seconds still parse.
        XCTAssertNotNil(HermesRunLabels.date(from: "2026-08-09T02:14:00Z"))
    }

    // MARK: - Inbox filtering

    func testDismissedRunsAreHiddenButRecoverable() {
        let inbox = FeatureHermesInbox(
            runs: [
                run(id: "a", status: .unread),
                run(id: "b", status: .dismissed),
                run(id: "c", status: .read),
            ],
            unreadCount: 1
        )

        XCTAssertEqual(inbox.visibleRuns(includingDismissed: false).map(\.id), ["a", "c"])
        XCTAssertEqual(inbox.visibleRuns(includingDismissed: true).map(\.id), ["a", "b", "c"])
        XCTAssertEqual(inbox.dismissedCount, 1)
        XCTAssertEqual(inbox.unreadIDs, ["a"])
    }

    // MARK: - Store

    @MainActor
    func testStoreSumsUnreadAcrossEveryEnvironment() async {
        let store = HermesInboxStore(retryDelay: .milliseconds(1))
        let manager = StubHermesInboxManager(
            inboxes: [
                "env-a": FeatureHermesInbox(runs: [run(id: "a", status: .unread)], unreadCount: 1),
                "env-b": FeatureHermesInbox(
                    runs: [run(id: "b", status: .unread), run(id: "c", status: .unread)],
                    unreadCount: 2,
                    deadLetterCount: 1
                ),
            ]
        )

        await store.observe(
            environments: [environment("env-a"), environment("env-b")],
            manager: manager
        )

        XCTAssertEqual(store.totalUnreadCount, 3)
        XCTAssertEqual(store.totalDeadLetterCount, 1)
        XCTAssertFalse(store.isLoading)
    }

    /// One unreachable environment records its own failure instead of blanking
    /// the environments that did answer.
    @MainActor
    func testOneFailingEnvironmentDoesNotHideTheOthers() async {
        let store = HermesInboxStore(retryDelay: .milliseconds(1))
        let manager = StubHermesInboxManager(
            inboxes: ["env-a": FeatureHermesInbox(runs: [run(id: "a", status: .unread)], unreadCount: 1)],
            failing: ["env-b"]
        )

        await store.observe(
            environments: [environment("env-a"), environment("env-b")],
            manager: manager
        )

        XCTAssertEqual(store.totalUnreadCount, 1)
        XCTAssertEqual(store.inbox(for: "env-a").runs.count, 1)
        XCTAssertNotNil(store.failures["env-b"])
        XCTAssertTrue(store.inbox(for: "env-b").runs.isEmpty)
    }

    /// Marking applies the server's own post-change snapshot, so the badge and
    /// the row statuses cannot drift apart.
    @MainActor
    func testMarkingAdoptsTheServerSnapshot() async {
        let store = HermesInboxStore(retryDelay: .milliseconds(1))
        let manager = StubHermesInboxManager(
            inboxes: ["env-a": FeatureHermesInbox(runs: [run(id: "a", status: .unread)], unreadCount: 1)]
        )
        await store.observe(environments: [environment("env-a")], manager: manager)
        XCTAssertEqual(store.totalUnreadCount, 1)

        manager.markResult = FeatureHermesInbox(
            runs: [run(id: "a", status: .read)],
            unreadCount: 0
        )
        await store.mark(environmentID: "env-a", ids: ["a"], status: .read, manager: manager)

        XCTAssertEqual(store.totalUnreadCount, 0)
        XCTAssertEqual(store.inbox(for: "env-a").runs.first?.status, .read)
        XCTAssertEqual(manager.marked.map(\.status), [.read])
        XCTAssertNil(store.actionFailure)
    }

    @MainActor
    func testAFailedMarkSurfacesInsteadOfSilentlyReverting() async {
        let store = HermesInboxStore(retryDelay: .milliseconds(1))
        let manager = StubHermesInboxManager(
            inboxes: ["env-a": FeatureHermesInbox(runs: [run(id: "a", status: .unread)], unreadCount: 1)]
        )
        await store.observe(environments: [environment("env-a")], manager: manager)
        manager.markFails = true

        await store.mark(environmentID: "env-a", ids: ["a"], status: .read, manager: manager)

        XCTAssertNotNil(store.actionFailure)
        XCTAssertEqual(store.totalUnreadCount, 1)
    }

    /// A client that cannot answer for Hermes settles the screen on its empty
    /// state rather than leaving it spinning.
    @MainActor
    func testAClientWithoutHermesSettlesInsteadOfSpinning() async {
        let store = HermesInboxStore(retryDelay: .milliseconds(1))
        await store.observe(
            environments: [environment("env-a")],
            manager: EmptyFeatureHermesInboxManager.shared
        )

        XCTAssertFalse(store.isLoading)
        XCTAssertEqual(store.totalUnreadCount, 0)
    }

    // MARK: - Helpers

    private func run(id: String, status: FeatureHermesRunStatus) -> FeatureHermesRun {
        FeatureHermesRun(
            id: id,
            title: "Hermes finished a run you did not start",
            body: "Checked the inbox and sent 50 emails.",
            threadID: "thread-\(id)",
            status: status,
            createdAt: "2026-08-09T02:14:00.000Z"
        )
    }

    private func environment(_ id: String) -> FeatureEnvironment {
        FeatureEnvironment(id: id, name: id.uppercased(), endpoint: "ws://127.0.0.1:1234")
    }
}

/// Emits one snapshot per environment and then finishes, so `observe` returns
/// instead of the test having to cancel a live subscription.
@MainActor
private final class StubHermesInboxManager: FeatureHermesInboxManaging {
    struct MarkCall {
        let environmentID: String
        let ids: [String]
        let status: FeatureHermesRunStatus
    }

    var inboxes: [String: FeatureHermesInbox]
    var failing: Set<String>
    var markResult = FeatureHermesInbox.empty
    var markFails = false
    private(set) var marked: [MarkCall] = []

    init(inboxes: [String: FeatureHermesInbox], failing: Set<String> = []) {
        self.inboxes = inboxes
        self.failing = failing
    }

    func hermesInboxUpdates(
        environmentID: String
    ) async -> AsyncThrowingStream<FeatureHermesInbox, Error> {
        let failed = failing.contains(environmentID)
        let inbox = inboxes[environmentID]
        return AsyncThrowingStream { continuation in
            if failed {
                continuation.finish(throwing: FeatureCapabilityUnavailable("Hermes runs"))
                return
            }
            if let inbox { continuation.yield(inbox) }
            continuation.finish()
        }
    }

    func markHermesRuns(
        environmentID: String,
        ids: [String],
        status: FeatureHermesRunStatus
    ) async throws -> FeatureHermesInbox {
        marked.append(MarkCall(environmentID: environmentID, ids: ids, status: status))
        if markFails { throw FeatureCapabilityUnavailable("Hermes runs") }
        return markResult
    }
}
