import Foundation
import Testing
@testable import T3Code

@Suite("Pull request merge method defaults contracts")
struct PullRequestMergeDefaultsContractTests {
    private struct Fixture: Decodable {
        let patch: JSONValue
        let settings: ServerSettingsSnapshot
        let capabilities: EnvironmentDescriptor.Capabilities
    }

    @Test func decodesTheMachineMethodAndProjectOverrides() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/pullRequestMergeDefaults.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        #expect(fixture.settings.pullRequestMergeMethod == "squash")
        #expect(fixture.settings.projectPullRequestMergeMethodOverrides == ["rebased": "rebase"])
        #expect(fixture.capabilities.pullRequestMergeMethodDefaults == true)
        let roundTrip = try JSONDecoder().decode(ServerSettingsSnapshot.self, from: JSONEncoder().encode(fixture.settings))
        #expect(roundTrip == fixture.settings)
        #expect(ServerSettingsPatchInput(pullRequestMergeMethod: .some("squash"),
            projectPullRequestMergeMethodOverrides: ["rebased": "rebase", "reset": nil]).json == fixture.patch)
    }

    @Test func olderServersReuseTheDevicesChoice() throws {
        let settings = try JSONDecoder().decode(ServerSettingsSnapshot.self, from: Data(#"{"defaultThreadEnvMode":"local","newWorktreesStartFromOrigin":true}"#.utf8))
        #expect(settings.pullRequestMergeMethod == nil)
        #expect(settings.projectPullRequestMergeMethodOverrides.isEmpty)
        let capabilities = try JSONDecoder().decode(EnvironmentDescriptor.Capabilities.self, from: Data("{}".utf8))
        #expect(capabilities.pullRequestMergeMethodDefaults == nil)
    }

    @Test func lastUsedIsAnExplicitNull() {
        let patch = ServerSettingsPatchInput(pullRequestMergeMethod: .some(nil))
        #expect(patch.json == .object(["pullRequestMergeMethod": .null]))
        #expect(!patch.isEmpty)
        #expect(ServerSettingsPatchInput().json == .object([:]))
    }

    @Test func pendingWritesKeepTheLatestMethod() {
        let first = ServerSettingsPatchInput(pullRequestMergeMethod: .some("merge"), projectPullRequestMergeMethodOverrides: ["one": "rebase"])
        let merged = first.merged(with: ServerSettingsPatchInput(pullRequestMergeMethod: .some(nil), projectPullRequestMergeMethodOverrides: ["two": nil]))
        #expect(merged.pullRequestMergeMethod == .some(nil))
        #expect(merged.projectPullRequestMergeMethodOverrides?["one"] == .some("rebase"))
        #expect(merged.projectPullRequestMergeMethodOverrides?["two"] == .some(nil))
    }
}
