import Foundation
import Testing
@testable import T3Code

@Suite("Linked pull request settlement")
struct LinkedPullRequestSettlementTests {
    private func pr(_ number: Int, _ state: String) -> FeaturePullRequest {
        FeaturePullRequest(number: number, title: "PR", state: state, updatedAt: Date(timeIntervalSince1970: Double(number)))
    }

    @Test func anOpenLinkKeepsTheCollectionOpen() {
        #expect(FeatureLinkedPullRequestSettlement.aggregate([pr(1, "merged"), pr(2, "open")])?.state == "open")
    }

    @Test func failedReadsCannotSettleACollection() {
        #expect(FeatureLinkedPullRequestSettlement.aggregate([pr(1, "merged"), nil])?.state == "unknown")
        #expect(FeatureLinkedPullRequestSettlement.aggregate([nil, nil]) == nil)
        #expect(FeatureLinkedPullRequestSettlement.aggregate([pr(1, "closed"), pr(2, "unknown")])?.state == "unknown")
    }

    @Test func allTerminalLinksUseTheLatestTimestampAndRespectMergePreference() {
        let result = FeatureLinkedPullRequestSettlement.aggregate([pr(1, "merged"), pr(2, "closed")])
        #expect(result?.state == "merged")
        #expect(result?.updatedAt == Date(timeIntervalSince1970: 2))
        #expect(FeatureLinkedPullRequestSettlement.aggregate([pr(1, "closed"), pr(2, "closed")])?.state == "closed")
    }

    @Test func stackActionsUseExactlyTheReviewedAffectedLayers() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("CoreTests/Fixtures/pullRequestStack.json")
        let stack = try JSONDecoder().decode(PullRequestStack.self, from: Data(contentsOf: fixture))
        #expect(stack.affectedLayers(number: 2, action: "merge").map(\.number) == [2])
        #expect(stack.affectedLayers(number: 3, action: "update-branch").map(\.number) == [2, 3])
        #expect(stack.affectedLayers(number: 99, action: "merge").isEmpty)
    }
}
