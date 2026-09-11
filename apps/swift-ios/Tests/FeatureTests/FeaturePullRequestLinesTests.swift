import XCTest
@testable import T3Code

final class FeaturePullRequestLinesTests: XCTestCase {
    private func link(_ number: Int, base: String = "main", host: String = "github.com") -> FeatureLinkedPullRequest {
        FeatureLinkedPullRequest(projectID: "p", repository: "org/repo", number: number,
            url: "https://\(host)/org/repo/pull/\(number)", source: "manual", linkedAt: "2026-09-11T00:00:00.000Z",
            snapshot: FeaturePullRequestSnapshot(state: "open", title: "Change \(number)", headBranch: "feature/\(number)", baseBranch: base,
                isDraft: false, updatedAt: nil, author: nil, additions: nil, deletions: nil, checksState: nil, reviewDecision: nil, mergeability: nil))
    }

    func testStackBadgeCountsOnlyOneCompleteVisibleChain() {
        XCTAssertNil(FeaturePullRequestLines.stackSize([link(1)]))
        XCTAssertNil(FeaturePullRequestLines.stackSize([link(1), link(2)]))
        XCTAssertEqual(FeaturePullRequestLines.stackSize([link(1), link(2, base: "feature/1")]), 2)
        var dismissed = link(3)
        dismissed.source = "stack-dismissed"
        XCTAssertEqual(FeaturePullRequestLines.stackSize([link(1), dismissed, link(2, base: "feature/1")]), 2)
    }

    func testOrdersDerivedChainBottomToTop() {
        let lines = FeaturePullRequestLines.resolve([link(3, base: "feature/2"), link(1), link(2, base: "feature/1")])
        XCTAssertEqual(lines.map { $0.link.number }, [1, 2, 3])
        XCTAssertEqual(lines.map(\.depth), [0, 1, 2])
        XCTAssertEqual(lines.map(\.chainSize), [3, 3, 3])
        XCTAssertFalse(lines[0].isNativeStack)
    }

    func testNativeHostOrderWinsAndDismissedLayersStayHidden() {
        var one = link(1), two = link(2), three = link(3)
        let stack = FeaturePullRequestStack(id: "s", number: 9, url: "https://github.com/org/repo/stack/9", base: "main", numbers: [2, 1, 3])
        one.stack = stack; two.stack = stack; three.stack = stack; three.source = "stack-dismissed"
        let lines = FeaturePullRequestLines.resolve([one, three, two])
        XCTAssertEqual(lines.map { $0.link.number }, [2, 1])
        XCTAssertTrue(lines.allSatisfy(\.isNativeStack))
        XCTAssertEqual(lines[0].chainSize, 2)
    }

    func testNeverChainsAcrossHosts() {
        let lines = FeaturePullRequestLines.resolve([link(1), link(2, base: "feature/1", host: "enterprise.example")])
        XCTAssertEqual(lines.map(\.depth), [0, 0])
        XCTAssertEqual(Set(lines.map(\.id)).count, 2)
    }

    func testCyclesRemainVisibleWithoutInventingAnOrder() {
        let lines = FeaturePullRequestLines.resolve([link(1, base: "feature/2"), link(2, base: "feature/1")])
        XCTAssertEqual(lines.map { $0.link.number }, [1, 2])
        XCTAssertEqual(lines.map(\.depth), [0, 0])
    }

    func testDuplicateHeadNamesDoNotChooseAnArbitraryParent() {
        var duplicate = link(2)
        duplicate.snapshot?.headBranch = "feature/1"
        let lines = FeaturePullRequestLines.resolve([link(1), duplicate, link(3, base: "feature/1")])
        XCTAssertEqual(lines.map(\.depth), [0, 0, 0])
    }

    func testCanonicalHostMetadataGroupsBrowserHostAliases() {
        var one = link(1, host: "org.visualstudio.com")
        var two = link(2, base: "feature/1", host: "dev.azure.com")
        one.host = "dev.azure.com"; two.host = "dev.azure.com"
        one.repository = "org/project/_git/repo"; two.repository = one.repository
        XCTAssertEqual(FeaturePullRequestLines.resolve([two, one]).map(\.depth), [0, 1])
    }

    func testNewestActivityMovesTheWholeChain() {
        var top = link(2, base: "feature/1")
        top.snapshot?.updatedAt = "2026-09-12T00:00:00.000Z"
        let lines = FeaturePullRequestLines.resolve([link(9), link(1), top])
        XCTAssertEqual(lines.map { $0.link.number }, [1, 2, 9])
    }
}
