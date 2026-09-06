import Foundation
import Testing
@testable import T3Code

@Suite("Pull request previews")
struct PullRequestLinkPreviewTests {
    @Test
    func scopesGithubAndNestedGitlabLinks() throws {
        let github = try #require(PullRequestLinkTarget(URL(string: "https://github.com/Org/Repo/pull/42#discussion")!))
        #expect(github.repositoryKey == "github.com/org/repo")
        #expect(github.number == 42)
        let gitlab = try #require(PullRequestLinkTarget(URL(string: "https://gitlab.example.com/group/sub/repo/-/merge_requests/12")!))
        #expect(gitlab.repositoryKey == "gitlab.example.com/group/sub/repo")
        #expect(gitlab.number == 12)
        #expect(PullRequestLinkTarget(URL(string: "file:///org/repo/pull/42")!) == nil)
        #expect(PullRequestLinkTarget(URL(string: "https://github.com/org/repo/issues/42")!) == nil)
    }

    @Test
    func deduplicatesLinksInAMessage() {
        let url = "https://github.com/org/repo/pull/42"
        #expect(PullRequestLinkTarget.links(in: "Review \(url) and \(url)").count == 1)
    }
}
