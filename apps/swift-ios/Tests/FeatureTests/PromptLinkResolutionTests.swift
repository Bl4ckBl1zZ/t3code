import Foundation
import XCTest
@testable import T3Code

/// Ports findPromptLinkProject and findPromptLinkPullRequestThread from
/// packages/client-runtime/src/promptLinks.test.ts.
final class PromptLinkResolutionTests: XCTestCase {
    private let t3code = PromptLinks.Repository(owner: "pingdotgg", name: "t3code")

    private func project(_ environment: String, _ wireID: String, canonical: String?, grouping: String? = nil) -> FeatureProject {
        FeatureProject(
            id: FeatureScopedID.project(environmentID: environment, wireID: wireID), wireID: wireID,
            environmentID: environment, name: wireID, path: "/work/\(wireID)",
            repositoryCanonicalKey: canonical, repositoryGroupingKey: grouping ?? canonical
        )
    }

    private func thread(_ id: String, project: FeatureProject, updatedAt: TimeInterval, pullRequests: [FeatureLinkedPullRequest]? = nil) -> FeatureThread {
        var thread = FeatureThread(
            id: id, projectID: project.id, environmentID: project.environmentID, title: id,
            updatedAt: Date(timeIntervalSince1970: updatedAt)
        )
        thread.linkedPullRequests = pullRequests
        return thread
    }

    private func link(_ number: Int, source: String = "created") -> FeatureLinkedPullRequest {
        FeatureLinkedPullRequest(
            projectID: "p", repository: "pingdotgg/t3code", number: number,
            url: "https://github.com/pingdotgg/t3code/pull/\(number)", host: "github.com", source: source
        )
    }

    func testTakesTheMostRecentlyActiveExactMatchAndNeverAForkOfTheRepository() {
        let fork = project("laptop", "fork", canonical: "github.com/pingdotgg/t3code", grouping: "github.com/me/t3code")
        let none = project("laptop", "none", canonical: nil)
        let recent = project("desktop", "recent", canonical: "github.com/PingDotGG/T3Code")
        let older = project("laptop", "older", canonical: "github.com/pingdotgg/t3code")
        let projects = [fork, none, older, recent]
        let threads = [
            thread("a", project: older, updatedAt: 100),
            thread("b", project: recent, updatedAt: 200),
            thread("c", project: fork, updatedAt: 300),
        ]
        XCTAssertEqual(PromptLinkResolution.project(for: t3code, in: projects, threads: threads)?.id, recent.id)
        XCTAssertEqual(PromptLinkResolution.project(for: .init(owner: "me", name: "t3code"), in: projects, threads: threads)?.id, fork.id)
        XCTAssertNil(PromptLinkResolution.project(for: .init(owner: "gitlab", name: "x"), in: projects, threads: threads))
    }

    func testFindsTheMostRecentlyUpdatedThreadLinkedToThePullRequest() {
        let home = project("laptop", "t3", canonical: "github.com/pingdotgg/t3code")
        let threads = [
            thread("old", project: home, updatedAt: 100, pullRequests: [link(7)]),
            thread("new", project: home, updatedAt: 200, pullRequests: [link(7)]),
            thread("other", project: home, updatedAt: 300, pullRequests: [link(8)]),
            thread("dismissed", project: home, updatedAt: 400, pullRequests: [link(7, source: "stack-dismissed")]),
        ]
        let pullRequest = PromptLinks.PullRequest(repository: .init(owner: "PingDotGG", name: "t3code"), number: 7)
        XCTAssertEqual(PromptLinkResolution.pullRequestThread(in: threads, pullRequest: pullRequest)?.id, "new")
        XCTAssertNil(PromptLinkResolution.pullRequestThread(in: threads, pullRequest: .init(repository: t3code, number: 9)))
    }

    func testEnvironmentsOrderByTheirLatestThread() {
        let a = project("a", "p", canonical: nil)
        let b = project("b", "p", canonical: nil)
        let threads = [thread("1", project: a, updatedAt: 100), thread("2", project: b, updatedAt: 300), thread("3", project: a, updatedAt: 200)]
        XCTAssertEqual(PromptLinkResolution.environmentsByRecentActivity(threads), ["b", "a"])
    }

    func testPullRequestDraftsCarryTheirURLAfterThePrompt() {
        let pullRequest = PromptLinks.PullRequest(repository: t3code, number: 42)
        XCTAssertEqual(
            PromptLinkResolution.draftText(prompt: .init(text: "Review this", hiddenCharacters: 0), pullRequest: pullRequest),
            "Review this\n\nhttps://github.com/pingdotgg/t3code/pull/42"
        )
        XCTAssertEqual(PromptLinkResolution.draftText(prompt: nil, pullRequest: pullRequest), "https://github.com/pingdotgg/t3code/pull/42")
    }

    func testRepositoryGroupingKeyPrefersTheForksOwnRemote() throws {
        let json = #"{"canonicalKey":"github.com/pingdotgg/t3code","locator":{"source":"git-remote","remoteName":"origin","remoteUrl":"https://github.com/me/t3code"},"origin":{"canonicalKey":"github.com/me/t3code"}}"#
        let identity = try JSONDecoder().decode(RepositoryIdentity.self, from: Data(json.utf8))
        XCTAssertEqual(identity.groupingKey, "github.com/me/t3code")
        let plain = #"{"canonicalKey":"github.com/pingdotgg/t3code","locator":{"source":"git-remote","remoteName":"origin","remoteUrl":"https://github.com/pingdotgg/t3code"}}"#
        XCTAssertEqual(try JSONDecoder().decode(RepositoryIdentity.self, from: Data(plain.utf8)).groupingKey, "github.com/pingdotgg/t3code")
    }
}
