import XCTest

@testable import T3Code

/// Ports apps/mobile/src/features/threads/threadRowMenu.test.ts.
final class ThreadRowMenuTests: XCTestCase {
    private let base = [
        ThreadRowMenuAction(id: "settle", title: "Settle"),
        ThreadRowMenuAction(id: "copy-handoff-script", title: "Copy handoff script"),
        ThreadRowMenuAction(id: "delete", title: "Delete", destructive: true),
    ]

    func testOmitsTheActionOnServersWithoutTheCapability() {
        let actions = ThreadRowMenu.withTitleRegenerationAction(
            base,
            supported: false,
            regenerating: false
        )
        XCTAssertEqual(actions.map(\.id), ["settle", "copy-handoff-script", "delete"])
    }

    func testInsertsTheActionDirectlyAboveDelete() {
        let actions = ThreadRowMenu.withTitleRegenerationAction(
            base,
            supported: true,
            regenerating: false
        )
        XCTAssertEqual(
            actions.map(\.id),
            ["settle", "copy-handoff-script", "regenerate-title", "delete"]
        )
        XCTAssertEqual(actions[2].title, "Regenerate title")
        XCTAssertFalse(actions[2].disabled)
    }

    func testDisablesAndRelabelsTheActionWhileARegenerationIsInFlight() {
        let actions = ThreadRowMenu.withTitleRegenerationAction(
            base,
            supported: true,
            regenerating: true
        )
        let regenerate = actions.first { $0.id == ThreadRowMenu.regenerateTitleActionID }
        XCTAssertEqual(regenerate?.title, "Regenerating…")
        XCTAssertEqual(regenerate?.disabled, true)
    }

    func testAppendsWhenTheMenuHasNoDeleteItem() {
        let actions = ThreadRowMenu.withTitleRegenerationAction(
            [ThreadRowMenuAction(id: "archive", title: "Archive")],
            supported: true,
            regenerating: false
        )
        XCTAssertEqual(actions.map(\.id), ["archive", "regenerate-title"])
    }

    /// Value semantics give the TS "never mutates the source array" guarantee
    /// for free; asserted anyway so a future reference-typed menu model cannot
    /// quietly reintroduce the shared-mutation bug.
    func testLeavesTheSourceMenuUntouched() {
        let source = [ThreadRowMenuAction(id: "delete", title: "Delete")]
        _ = ThreadRowMenu.withTitleRegenerationAction(source, supported: true, regenerating: false)
        XCTAssertEqual(source.count, 1)
    }
}
