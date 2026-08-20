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

    /// The Home menu groups regeneration with Rename rather than parking it
    /// above Delete: both are ways of naming the thread.
    func testAnExplicitAnchorPlacesTheActionDirectlyAfterIt() {
        let actions = ThreadRowMenu.withTitleRegenerationAction(
            [
                ThreadRowMenuAction(id: "rename", title: "Rename"),
                ThreadRowMenuAction(id: "copy", title: "Copy"),
                ThreadRowMenuAction(id: "delete", title: "Delete", destructive: true),
            ],
            supported: true,
            regenerating: false,
            after: "rename"
        )
        XCTAssertEqual(actions.map(\.id), ["rename", "regenerate-title", "copy", "delete"])
    }

    /// A menu that never grew the anchor still gets the action, in the slot the
    /// delete-anchored callers expect.
    func testAMissingAnchorFallsBackToTheDeleteSlot() {
        let actions = ThreadRowMenu.withTitleRegenerationAction(
            [
                ThreadRowMenuAction(id: "copy", title: "Copy"),
                ThreadRowMenuAction(id: "delete", title: "Delete", destructive: true),
            ],
            supported: true,
            regenerating: false,
            after: "rename"
        )
        XCTAssertEqual(actions.map(\.id), ["copy", "regenerate-title", "delete"])
    }

    // MARK: - Sections

    func testSectionsSplitOnTheSeparatorFlag() {
        let sections = ThreadRowMenu.sections([
            ThreadRowMenuAction(id: "pin", title: "Pin"),
            ThreadRowMenuAction(id: "settle", title: "Settle"),
            ThreadRowMenuAction(id: "rename", title: "Rename", separatorBefore: true),
            ThreadRowMenuAction(id: "delete", title: "Delete", separatorBefore: true),
        ])

        XCTAssertEqual(sections.map { $0.map(\.id) }, [["pin", "settle"], ["rename"], ["delete"]])
    }

    /// A row whose first item opens a section — an archived thread, whose
    /// lifecycle group is empty — must not produce an empty leading group the
    /// menu would draw as a stray rule.
    func testALeadingSeparatorDoesNotOpenAnEmptySection() {
        let sections = ThreadRowMenu.sections([
            ThreadRowMenuAction(id: "rename", title: "Rename", separatorBefore: true),
            ThreadRowMenuAction(id: "delete", title: "Delete", separatorBefore: true),
        ])

        XCTAssertEqual(sections.map { $0.map(\.id) }, [["rename"], ["delete"]])
        XCTAssertFalse(sections.contains(where: \.isEmpty))
    }

    func testSectionsOfAnEmptyMenuAreEmpty() {
        XCTAssertTrue(ThreadRowMenu.sections([]).isEmpty)
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
