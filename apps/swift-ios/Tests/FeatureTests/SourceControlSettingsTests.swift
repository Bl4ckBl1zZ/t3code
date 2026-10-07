import Foundation
import Testing
@testable import T3Code

@Suite("Source Control settings")
struct SourceControlSettingsTests {
    private typealias Account = SourceControlProviderAuth.Account

    @Test func githubDotComLeadsAndIsAlwaysOffered() {
        let sections = GitHubHostSection.sections(settings: nil, accounts: [])
        #expect(sections.map(\.host) == ["github.com"])
        #expect(sections[0].enabled)
        #expect(!sections[0].hasSavedToken)

        let all = GitHubHostSection.sections(
            settings: GitHubSettings(
                hosts: ["z.example": .init(enabled: false)],
                tokens: ["t.example": GitHubSettings.redactedToken, "gone.example": ""]
            ),
            accounts: [
                Account(host: "GHE.example", account: "hubot", active: true, authenticated: true),
                Account(host: "github.com", account: "octocat", active: true, authenticated: true),
            ]
        )
        // Saved choices, saved tokens and gh's logins all count; a removed token does not.
        #expect(all.map(\.host) == ["github.com", "ghe.example", "t.example", "z.example"])
        #expect(all.first { $0.host == "t.example" }?.hasSavedToken == true)
        #expect(all.first { $0.host == "z.example" }?.enabled == false)
    }

    @Test func splitsUsableLoginsFromBrokenAndOverriddenOnes() {
        let section = GitHubHostSection.sections(
            settings: GitHubSettings(hosts: ["github.com": .init(account: "hubot")]),
            accounts: [
                Account(host: "github.com", account: "octocat", active: false, authenticated: true),
                Account(host: "github.com", account: "hubot", active: true, authenticated: true),
                Account(host: "github.com", account: "old", active: false, authenticated: false, error: "token expired"),
                Account(host: "github.com", account: "ci", active: false, authenticated: true, environmentVariable: "GH_TOKEN"),
            ]
        )[0]

        #expect(section.selectableAccounts == ["octocat", "hubot"])
        #expect(section.activeAccount == "hubot")
        #expect(section.pinnedAccount == "hubot")
        #expect(section.stalePin == nil)
        #expect(section.brokenAccounts.map(\.account) == ["old"])
        #expect(section.environmentVariable == "GH_TOKEN")
        #expect(SettingsSourceControlView.footer(section).contains("GH_TOKEN is set on the server"))
    }

    @Test func aPinGhNoLongerHoldsFallsBackToTheActiveLogin() {
        let section = GitHubHostSection.sections(
            settings: GitHubSettings(hosts: ["github.com": .init(account: "departed")]),
            accounts: [Account(host: "github.com", account: "octocat", active: false, authenticated: true)]
        )[0]

        #expect(section.pinnedAccount == nil)
        #expect(section.stalePin == "departed")
        // With no login marked active, gh uses the first one that works.
        #expect(section.activeAccount == "octocat")
    }

    @Test func aWriteShowsAsTheServerWillStoreIt() {
        let saved = GitHubSettings(
            hosts: ["github.com": .init(account: "octocat")],
            tokens: ["github.com": GitHubSettings.redactedToken]
        )

        let token = saved.applying(.savingToken("ghp_new", host: "ghe.example")!)
        #expect(token.tokens == ["github.com": GitHubSettings.redactedToken, "ghe.example": GitHubSettings.redactedToken])
        #expect(token.hosts == saved.hosts)

        let removed = saved.applying(.removingToken(host: "github.com"))
        #expect(!removed.hasSavedToken("github.com"))

        let hosts = saved.applying(.changingHost("github.com", in: saved.hosts, enabled: false))
        #expect(hosts.hosts == ["github.com": .init(account: "octocat", enabled: false)])
        #expect(hosts.tokens == saved.tokens)
    }
}
