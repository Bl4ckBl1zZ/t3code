import XCTest

@testable import T3Code

/// The terminal attaches again when its output stream ends on its own, which
/// happens when the environment reconnects under a new generation. These pin
/// when it does, and how quickly.
final class TerminalReattachTests: XCTestCase {
    func testALiveTerminalReattaches() {
        for state in [FeatureTerminalState.running, .starting, .exited, .stopped] {
            guard case .reattach = TerminalReattach.decision(state: state, attempt: 0) else {
                return XCTFail("\(state) should reattach")
            }
        }
        guard case .reattach = TerminalReattach.decision(state: nil, attempt: 0) else {
            return XCTFail("A terminal with no snapshot yet should reattach")
        }
    }

    /// A failed attach already shows why with a Retry; retrying on a timer
    /// would keep replacing that message with the same failure.
    func testAFailedAttachWaitsForRetry() {
        XCTAssertEqual(TerminalReattach.decision(state: .failed, attempt: 0), .stay)
        XCTAssertEqual(TerminalReattach.decision(state: .failed, attempt: 4), .stay)
    }

    func testQuickDropsBackOffUpToTheCap() {
        XCTAssertEqual(TerminalReattach.delay(attempt: 0), .milliseconds(500))
        XCTAssertEqual(TerminalReattach.delay(attempt: 1), .seconds(1))
        XCTAssertEqual(TerminalReattach.delay(attempt: 2), .seconds(2))
        XCTAssertEqual(TerminalReattach.delay(attempt: 3), .seconds(4))
        XCTAssertEqual(TerminalReattach.delay(attempt: 5), TerminalReattach.maximumDelay)
        XCTAssertEqual(TerminalReattach.delay(attempt: 40), TerminalReattach.maximumDelay)
    }

    /// A stream that ends right away (no route while the environment is
    /// reconnecting) counts toward the backoff, so it can never busy-loop.
    func testAnAttachThatEndsRightAwayCountsTowardTheBackoff() {
        XCTAssertEqual(TerminalReattach.nextAttempt(after: 0, attachedFor: .zero), 1)
        XCTAssertEqual(TerminalReattach.nextAttempt(after: 3, attachedFor: .milliseconds(200)), 4)
    }

    /// A healthy attach that later drops starts the backoff over, so the first
    /// reconnect after a long session is quick.
    func testAHealthyAttachResetsTheBackoff() {
        XCTAssertEqual(TerminalReattach.nextAttempt(after: 4, attachedFor: .seconds(10)), 0)
        XCTAssertEqual(TerminalReattach.nextAttempt(after: 4, attachedFor: .seconds(600)), 0)
    }

    func testTheTitleNamesTheSessionOnlyWhenThereAreSeveral() {
        XCTAssertEqual(TerminalSessionList.navigationTitle(terminalID: "default", sessionCount: 1), "Terminal")
        XCTAssertEqual(TerminalSessionList.navigationTitle(terminalID: "default", sessionCount: 2), "Terminal 1")
        XCTAssertEqual(TerminalSessionList.navigationTitle(terminalID: "term-3", sessionCount: 3), "Terminal 3")
    }
}
