import XCTest

@testable import T3Code

/// `FeatureSettings.alwaysExpandActivity` against the reader's own taps.
///
/// The preference is a default, not a lock: it decides rows nobody has touched,
/// and loses to an explicit choice on the rows that have one. That needs three
/// states per row, which is the whole reason this is a type rather than a `Set`.
final class ThreadWorkLogExpansionTests: XCTestCase {
    func testRowsStayClosedUntilTappedWhileThePreferenceIsOff() {
        var expansion = ThreadWorkLogExpansion()

        XCTAssertFalse(expansion.isExpanded("row-1", expandedByDefault: false))

        expansion.toggle("row-1", expandedByDefault: false)

        XCTAssertTrue(expansion.isExpanded("row-1", expandedByDefault: false))
        XCTAssertFalse(expansion.isExpanded("row-2", expandedByDefault: false))
    }

    func testThePreferenceOpensEveryUntouchedRow() {
        let expansion = ThreadWorkLogExpansion()

        XCTAssertTrue(expansion.isExpanded("row-1", expandedByDefault: true))
        XCTAssertTrue(expansion.isExpanded("row-2", expandedByDefault: true))
    }

    func testClosingARowTheDefaultOpenedWinsForThatRowAlone() {
        var expansion = ThreadWorkLogExpansion()

        expansion.toggle("row-1", expandedByDefault: true)

        XCTAssertFalse(expansion.isExpanded("row-1", expandedByDefault: true))
        // A lock would have reopened it; the preference is only a default.
        XCTAssertTrue(expansion.isExpanded("row-2", expandedByDefault: true))
    }

    func testAClosedRowReopensWhenTappedAgain() {
        var expansion = ThreadWorkLogExpansion()
        expansion.toggle("row-1", expandedByDefault: true)

        expansion.toggle("row-1", expandedByDefault: true)

        XCTAssertTrue(expansion.isExpanded("row-1", expandedByDefault: true))
    }

    func testTurningThePreferenceOffLeavesAnOpenedRowOpen() {
        var expansion = ThreadWorkLogExpansion()
        expansion.toggle("row-1", expandedByDefault: false)

        // Same row, preference now on and then off again: the reader's own
        // choice is what survives the flip in either direction.
        XCTAssertTrue(expansion.isExpanded("row-1", expandedByDefault: true))
        XCTAssertTrue(expansion.isExpanded("row-1", expandedByDefault: false))
    }

    func testARowClosedWhileThePreferenceWasOnStaysClosedAfterItGoesOff() {
        var expansion = ThreadWorkLogExpansion()
        expansion.toggle("row-1", expandedByDefault: true)

        XCTAssertFalse(expansion.isExpanded("row-1", expandedByDefault: false))
    }
}
