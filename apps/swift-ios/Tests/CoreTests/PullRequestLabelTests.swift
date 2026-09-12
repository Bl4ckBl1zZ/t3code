import Foundation
import Testing
@testable import T3Code

struct PullRequestLabelTests {
    @Test func decodesContractLabelsIncludingMissingColorsAndTruncation() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/pullRequestLabels.json")
        let list = try JSONDecoder().decode(PullRequestLabelCandidateList.self, from: Data(contentsOf: fixture))
        #expect(list.truncated)
        #expect(list.candidates.map(\.name) == ["bug", "legacy"])
        #expect(list.candidates.first?.isApplied == true)
        #expect(list.candidates.last?.color == nil)
        #expect(list.candidates.last?.description == nil)
    }

    @Test func olderPermissionsDoNotOfferLabelEditing() throws {
        let data = Data(#"{"actions":[],"comment":true,"resolve":false,"verdicts":[],"requestReviewers":false}"#.utf8)
        let viewer = try JSONDecoder().decode(NativePullRequestViewerPermissions.self, from: data)
        #expect(viewer.labels == nil)
    }
}
