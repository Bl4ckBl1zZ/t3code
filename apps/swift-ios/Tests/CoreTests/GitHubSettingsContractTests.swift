import Foundation
import Testing
@testable import T3Code

@Suite("GitHub settings contracts")
struct GitHubSettingsContractTests {
    private let baseSettings = #""defaultThreadEnvMode":"local","newWorktreesStartFromOrigin":true"#

    @Test func decodesPerHostChoicesAndTheTokenMarker() throws {
        let json = """
        {\(baseSettings),"github":{
          "hosts":{"GitHub.com":{"account":" octocat ","enabled":true},"ghe.example":{"enabled":false},"other.example":{}},
          "tokens":{"ghe.example":"\(GitHubSettings.redactedToken)","github.com":""}
        }}
        """
        let settings = try JSONDecoder.t3.decode(ServerSettingsSnapshot.self, from: Data(json.utf8))
        let github = try #require(settings.github)

        #expect(github.hosts["github.com"] == GitHubSettings.Host(account: "octocat", enabled: true))
        #expect(github.hosts["ghe.example"] == GitHubSettings.Host(enabled: false))
        // `enabled` defaults on, like the contract's decoding default.
        #expect(github.hosts["other.example"] == GitHubSettings.Host())
        #expect(github.hasSavedToken("GHE.example"))
        #expect(!github.hasSavedToken("github.com"))
    }

    @Test func olderServersAndUntouchedSettingsHaveNoGitHubKey() throws {
        let settings = try JSONDecoder.t3.decode(
            ServerSettingsSnapshot.self,
            from: Data("{\(baseSettings)}".utf8)
        )
        #expect(settings.github == nil)
    }

    @Test func decodesDiscoveredLoginsAndToleratesTheirAbsence() throws {
        let json = #"""
        [
          {"status":"authenticated","account":"octocat","host":"github.com","detail":null,
           "accounts":[
             {"host":"github.com","account":"octocat","active":true,"authenticated":true},
             {"host":"github.com","account":"hubot","active":false,"authenticated":false,"error":"token expired"},
             {"host":"github.com","account":"ci-bot","active":false,"authenticated":true,"environmentVariable":"GH_TOKEN"}
           ]},
          {"status":"unknown","account":null,"host":null,"detail":null},
          {"status":"unknown","account":null,"host":null,"detail":null,"accounts":[{"host":"github.com"}]}
        ]
        """#
        let auths = try JSONDecoder.t3.decode([SourceControlProviderAuth].self, from: Data(json.utf8))

        let accounts = try #require(auths[0].accounts)
        #expect(accounts.map(\.account) == ["octocat", "hubot", "ci-bot"])
        #expect(accounts[1].error == "token expired")
        #expect(accounts[2].environmentVariable == "GH_TOKEN")
        #expect(accounts[0].error == nil && accounts[0].environmentVariable == nil)
        #expect(auths[1].accounts == nil)
        // A list this build cannot read drops the logins, not the discovery result.
        #expect(auths[2].accounts == nil)
    }

    @Test func hostChangesCarryEveryOtherHostAndDropDefaults() {
        let current: [String: GitHubSettings.Host] = [
            "github.com": .init(account: "octocat"),
            "ghe.example": .init(enabled: false),
        ]

        let pinned = GitHubSettingsPatch.changingHost("ghe.example", in: current, enabled: true, account: .some("hubot"))
        #expect(pinned.hosts == ["github.com": .init(account: "octocat"), "ghe.example": .init(account: "hubot")])
        #expect(pinned.tokens == nil)

        // Back on gh's defaults, a host leaves the map instead of being stored.
        let unpinned = GitHubSettingsPatch.changingHost("GitHub.com", in: current, account: .some(nil))
        #expect(unpinned.hosts == ["ghe.example": .init(enabled: false)])

        // Turning a host off keeps its pin for when it comes back on.
        let disabled = GitHubSettingsPatch.changingHost("github.com", in: current, enabled: false)
        #expect(disabled.hosts?["github.com"] == .init(account: "octocat", enabled: false))
    }

    @Test func tokenPatchesNeverSendTheMarkerOrABlankAsANewToken() {
        #expect(GitHubSettingsPatch.savingToken("  ghp_new  ", host: " GitHub.com ")?.tokens == ["github.com": "ghp_new"])
        #expect(GitHubSettingsPatch.savingToken("   ", host: "github.com") == nil)
        #expect(GitHubSettingsPatch.savingToken(GitHubSettings.redactedToken, host: "github.com") == nil)
        #expect(GitHubSettingsPatch.savingToken("ghp_new", host: " ") == nil)
        #expect(GitHubSettingsPatch.removingToken(host: "GHE.example").tokens == ["ghe.example": ""])
    }

    @Test func patchesSendOnlyTheGitHubKey() {
        let hosts = ServerSettingsPatchInput(github: .init(hosts: ["ghe.example": .init(account: "hubot", enabled: false)]))
        #expect(hosts.json == .object(["github": .object(["hosts": .object([
            "ghe.example": .object(["account": .string("hubot"), "enabled": .bool(false)]),
        ])])]))

        let emptied = ServerSettingsPatchInput(github: .init(hosts: [:]))
        #expect(emptied.json == .object(["github": .object(["hosts": .object([:])])]))

        let token = ServerSettingsPatchInput(github: .removingToken(host: "github.com"))
        #expect(token.json == .object(["github": .object(["tokens": .object(["github.com": .string("")])])]))

        // Machine configuration, so it never travels to the other servers.
        #expect(SharedServerSettings.isEmpty(SharedServerSettings.split(hosts).shared))
    }

    @Test func pendingWritesMergeTheWayTheServerAppliesThem() {
        let first = ServerSettingsPatchInput(github: .init(hosts: ["a.example": .init(enabled: false)], tokens: ["a.example": "one"]))
        let second = ServerSettingsPatchInput(github: .init(hosts: ["b.example": .init(enabled: false)], tokens: ["b.example": ""]))
        let merged = first.merged(with: second).github

        #expect(merged?.hosts == ["b.example": .init(enabled: false)])
        #expect(merged?.tokens == ["a.example": "one", "b.example": ""])
    }
}
