import XCTest

@testable import T3Code

/// Review opens on the branch's Changes (merge-base to the working tree) and
/// offers Uncommitted beside it; a review read without a branch-range source
/// keeps the single working-tree list.
final class ReviewChangesSectionTests: XCTestCase {
    private struct Fixture: Decodable {
        let status: VCSStatus
        let preview: ReviewDiffPreview
    }

    private func fixture() throws -> Fixture {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("CoreTests/Fixtures/reviewChanges.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testStatusCarriesTheBranchTotalsReviewOpensOn() throws {
        let status = NativeWorkspaceMapper.sourceControl(try fixture().status)
        XCTAssertEqual(status.branchChanges, FeatureBranchChanges(baseReference: "origin/main", insertions: 12, deletions: 4))
        // The working tree's own totals stay what they were.
        XCTAssertEqual(status.insertions, 3)
    }

    func testChangesAndUncommittedEachShowTheirOwnSource() throws {
        let review = NativeWorkspaceMapper.review(try fixture().preview)
        XCTAssertTrue(review.splitsBranchChanges)

        let changes = review.section(.changes)
        XCTAssertEqual(changes.title, "Changes")
        XCTAssertEqual(changes.baseReference, "origin/main")
        XCTAssertEqual(changes.files.map(\.path), ["src/app.ts", "src/new.ts"])
        XCTAssertTrue(changes.isTruncated)

        let uncommitted = review.section(.workingTree)
        XCTAssertEqual(uncommitted.title, "Uncommitted")
        XCTAssertNil(uncommitted.baseReference)
        XCTAssertEqual(uncommitted.files.map(\.path), ["src/new.ts"])
        XCTAssertFalse(uncommitted.isTruncated)
    }

    func testAReviewWithoutABranchSourceKeepsTheCombinedList() {
        let file = FeatureReviewFile(path: "a.swift", change: .modified, additions: 1, deletions: 0, sourceKind: "working-tree")
        var review = FeatureReview(files: [file])
        review.sources = [FeatureReviewSource(kind: "working-tree", baseReference: "HEAD")]
        XCTAssertFalse(review.splitsBranchChanges)
        XCTAssertEqual(review.section(.changes), review)
        XCTAssertEqual(review.section(.workingTree), review)
    }

    func testOpensOnChangesUnlessUncommittedWasAskedFor() {
        XCTAssertEqual(ReviewSectionID.resolveGit(nil, splitsBranchChanges: true), .changes)
        XCTAssertEqual(ReviewSectionID.resolveGit(.changes, splitsBranchChanges: true), .changes)
        XCTAssertEqual(ReviewSectionID.resolveGit(.workingTree, splitsBranchChanges: true), .workingTree)
        // Without the split, every git request is the one working-tree list.
        XCTAssertEqual(ReviewSectionID.resolveGit(nil, splitsBranchChanges: false), .workingTree)
        XCTAssertEqual(ReviewSectionID.resolveGit(.changes, splitsBranchChanges: false), .workingTree)
    }

    func testSectionIDsRoundTrip() {
        for id in [ReviewSectionID.changes, .workingTree, .checkpoint(id: "c1")] {
            XCTAssertEqual(ReviewSectionID(rawValue: id.rawValue), id)
        }
        XCTAssertEqual(ReviewSectionID.changes.rawValue, "git:branch-range")
        XCTAssertTrue(ReviewSectionID.changes.isGit)
        XCTAssertFalse(ReviewSectionID.checkpoint(id: "c1").isGit)
    }
}
