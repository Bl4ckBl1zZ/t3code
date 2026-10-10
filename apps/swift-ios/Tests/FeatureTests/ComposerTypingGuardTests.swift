import XCTest

@testable import T3Code

/// Ports web's `composerTypingGuard` cases (upstream 99d2651dd5).
final class ComposerTypingGuardTests: XCTestCase {
    private func at(_ milliseconds: Double) -> Date {
        Date(timeIntervalSinceReferenceDate: milliseconds / 1000)
    }

    private func typing() -> ComposerTypingGuard {
        var guardState = ComposerTypingGuard()
        guardState.focus()
        guardState.typed(now: at(1000))
        return guardState
    }

    func testHoldsNewRequestsWhileTheFocusedDraftWasRecentlyEdited() {
        var guardState = typing()
        guardState.requests(["approval", "question"], now: at(2499))
        XCTAssertEqual(guardState.held, ["approval", "question"])
        XCTAssertEqual(guardState.releasesAt, at(2500))
    }

    func testReleasesOnIdleSendOrBlurAndNeverReholdsTheRequest() {
        let releases: [(inout ComposerTypingGuard) -> Void] = [
            { $0.release() },
            { $0.blur() },
        ]
        for release in releases {
            var guardState = typing()
            guardState.requests(["question"], now: at(1200))
            release(&guardState)
            XCTAssertEqual(guardState.held, [])
            XCTAssertNil(guardState.releasesAt)
            guardState.focus()
            guardState.typed(now: at(2000))
            guardState.requests([], now: at(2100))
            guardState.requests(["question", "new-question"], now: at(2200))
            XCTAssertEqual(guardState.held, ["new-question"])
        }
    }

    func testShowsRequestsImmediatelyWhenIdleOrUnfocused() {
        var blurred = typing()
        blurred.blur()
        for var guardState in [ComposerTypingGuard(), typing(), blurred] {
            guardState.requests(["question"], now: at(2500))
            XCTAssertEqual(guardState.held, [])
        }
    }

    func testDoesNotHideARequestThatAlreadyTookOverWhenTypingStarts() {
        var guardState = ComposerTypingGuard()
        guardState.requests(["question"], now: at(0))
        guardState.focus()
        guardState.typed(now: at(1000))
        guardState.requests(["question"], now: at(1100))
        XCTAssertEqual(guardState.held, [])
    }

    func testDropsAHoldWhenItsRequestIsResolved() {
        var guardState = typing()
        guardState.requests(["question"], now: at(1100))
        guardState.requests([], now: at(1200))
        XCTAssertEqual(guardState.held, [])
    }

    func testAnotherDraftStartsUnseenAndKeepsFocus() {
        var guardState = typing()
        guardState.requests(["question"], now: at(1100))
        guardState.reset()
        XCTAssertEqual(guardState.held, [])
        guardState.typed(now: at(2000))
        guardState.requests(["other"], now: at(2100))
        XCTAssertEqual(guardState.held, ["other"])
    }
}
