import XCTest

@testable import T3Code

/// Ports apps/mobile/src/features/threads/threadForkNavigation.test.ts.
final class ThreadForkNavigationTests: XCTestCase {
    /// Mirrors the TS test's injected `now`/`delay`: sleeping advances the clock
    /// instead of waiting, so the poll loop runs instantly and the elapsed time
    /// is exact rather than approximate.
    private final class VirtualClock {
        private let base = ContinuousClock().now
        private(set) var elapsed: Duration = .zero

        var now: ContinuousClock.Instant { base.advanced(by: elapsed) }

        func sleep(_ duration: Duration) { elapsed += duration }
    }

    func testReturnsTrueWhenTheForkedThreadShellArrivesBeforeTheDeadline() async {
        let clock = VirtualClock()

        let ready = await ThreadForkNavigation.waitForThreadShellReady(
            timeout: .milliseconds(120),
            pollInterval: .milliseconds(40),
            now: { clock.now },
            sleep: { clock.sleep($0) },
            isReady: { clock.elapsed >= .milliseconds(80) }
        )

        XCTAssertTrue(ready)
    }

    func testReturnsFalseInsteadOfNavigatingWhenTheShellNeverArrives() async {
        let clock = VirtualClock()

        let ready = await ThreadForkNavigation.waitForThreadShellReady(
            timeout: .milliseconds(80),
            pollInterval: .milliseconds(40),
            now: { clock.now },
            sleep: { clock.sleep($0) },
            isReady: { false }
        )

        XCTAssertFalse(ready)
        XCTAssertEqual(clock.elapsed, .milliseconds(80))
    }

    /// The final poll is clamped to what is left of the budget, so a timeout
    /// that is not a whole number of intervals still gives up on time.
    func testNeverWaitsPastTheDeadline() async {
        let clock = VirtualClock()

        _ = await ThreadForkNavigation.waitForThreadShellReady(
            timeout: .milliseconds(50),
            pollInterval: .milliseconds(40),
            now: { clock.now },
            sleep: { clock.sleep($0) },
            isReady: { false }
        )

        XCTAssertEqual(clock.elapsed, .milliseconds(50))
    }

    /// A fork whose shell already landed navigates on the same frame; there is
    /// no poll interval of latency before the thread opens.
    func testDoesNotWaitWhenTheShellIsAlreadyPresent() async {
        let clock = VirtualClock()

        let ready = await ThreadForkNavigation.waitForThreadShellReady(
            now: { clock.now },
            sleep: { clock.sleep($0) },
            isReady: { true }
        )

        XCTAssertTrue(ready)
        XCTAssertEqual(clock.elapsed, .zero)
    }
}
