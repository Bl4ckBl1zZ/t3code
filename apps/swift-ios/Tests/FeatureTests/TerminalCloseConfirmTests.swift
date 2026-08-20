import XCTest

@testable import T3Code

/// Ports the label and copy halves of apps/web/src/lib/terminalCloseConfirm.ts
/// and packages/shared/src/terminalLabels.ts.
final class TerminalCloseConfirmTests: XCTestCase {
    func testNumberedIDsReadAsTerminalN() {
        XCTAssertEqual(TerminalCloseConfirm.label(terminalID: "term-3"), "Terminal 3")
        XCTAssertEqual(TerminalCloseConfirm.label(terminalID: "terminal-12"), "Terminal 12")
        XCTAssertEqual(TerminalCloseConfirm.label(terminalID: "TERM-4"), "Terminal 4")
    }

    /// Anything that is not the generated shape is a name someone chose.
    func testOtherIDsAreLeftAlone() {
        XCTAssertEqual(TerminalCloseConfirm.label(terminalID: "default"), "default")
        XCTAssertEqual(TerminalCloseConfirm.label(terminalID: "term-"), "term-")
        XCTAssertEqual(TerminalCloseConfirm.label(terminalID: "term-abc"), "term-abc")
        XCTAssertEqual(TerminalCloseConfirm.label(terminalID: "build-2"), "build-2")
    }

    func testTheServersOwnLabelWinsWhenItHasOne() {
        XCTAssertEqual(
            TerminalCloseConfirm.label(terminalID: "term-3", sessionTitle: "pnpm dev"),
            "pnpm dev"
        )
    }

    func testABlankServerLabelFallsBackToTheID() {
        XCTAssertEqual(
            TerminalCloseConfirm.label(terminalID: "term-3", sessionTitle: "   "),
            "Terminal 3"
        )
        XCTAssertEqual(TerminalCloseConfirm.label(terminalID: "term-3", sessionTitle: nil), "Terminal 3")
    }

    /// The wording is shared with web on purpose: the same destructive action
    /// should read the same on both clients.
    func testTheConfirmationNamesTheTerminalAndWhatIsLost() {
        XCTAssertEqual(
            TerminalCloseConfirm.title(label: "Terminal 3"),
            "Close terminal “Terminal 3”?"
        )
        XCTAssertEqual(
            TerminalCloseConfirm.message,
            "This stops the running process and clears its history."
        )
    }
}
