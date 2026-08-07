import XCTest

@testable import T3Code

/// Ports apps/mobile/src/features/threads/scheduledTaskMessageBadge.test.ts.
final class ScheduledTaskMessageBadgeTests: XCTestCase {
    func testMatchesSchedulerMintedMessageIDs() {
        XCTAssertTrue(
            ScheduledTaskMessageBadge.isScheduledTaskMessageID(
                "scheduled-task-message:task-1:2026-08-02T09:00"
            )
        )
    }

    func testRejectsOrdinaryMessageIDs() {
        XCTAssertFalse(ScheduledTaskMessageBadge.isScheduledTaskMessageID("message:abc"))
        XCTAssertFalse(ScheduledTaskMessageBadge.isScheduledTaskMessageID(""))
        // The scheduled-task id prefix is not the scheduled-task-message prefix.
        XCTAssertFalse(ScheduledTaskMessageBadge.isScheduledTaskMessageID("scheduled-task:task-1"))
    }
}
