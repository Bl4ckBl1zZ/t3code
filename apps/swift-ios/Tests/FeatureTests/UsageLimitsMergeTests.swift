import Foundation
import Testing
@testable import T3Code

@Suite("Subscription limit pooling")
struct UsageLimitsMergeTests {
    private func provider(_ id: String, email: String?, percent: Double, credits: Int = 0, checkedAt: String = "2026-09-06T00:00:00Z", driver: String = "codex", workspaceID: String? = nil, windowID: String = "primary", windowKind: String = "session") throws -> ServerProviderSnapshot {
        var auth: [String: Any] = ["status": "authenticated"]
        if let email { auth["email"] = email }
        if let workspaceID { auth["workspaceId"] = workspaceID }
        return try JSONDecoder().decode(ServerProviderSnapshot.self, from: JSONSerialization.data(withJSONObject: [
            "instanceId": id, "driver": driver, "enabled": true, "installed": true,
            "status": "ready", "auth": auth, "checkedAt": checkedAt, "models": [],
            "usageLimits": ["checkedAt": checkedAt, "resetCredits": ["availableCount": credits], "windows": [["id": windowID, "kind": windowKind, "label": "Session", "usedPercent": percent, "windowDurationMins": 300]]],
        ]))
    }

    /// Ports "keep one email in two workspaces as two accounts".
    @Test func oneEmailInTwoWorkspacesIsTwoAccounts() throws {
        let identity = FeatureUsageLimitsMerge.AccountIdentityResolver([
            ("codex", "me@example.com", "ws-a"), ("codex", "me@example.com", "ws-b"), ("codex", "solo@example.com", "ws-c"),
        ])
        #expect(identity.identity(driver: "codex", email: "ME@example.com", workspaceID: "ws-a") == "codex:me@example.com:ws-a")
        // A report without a workspace joins the only one known for its email,
        // and gets no key when there are several.
        #expect(identity.identity(driver: "codex", email: "solo@example.com", workspaceID: nil) == "codex:solo@example.com:ws-c")
        #expect(identity.identity(driver: "codex", email: "me@example.com", workspaceID: nil) == nil)
        #expect(identity.identity(driver: "codex", email: "new@example.com", workspaceID: nil) == "codex:new@example.com")

        let merged = FeatureUsageLimitsMerge.merge([
            .init(id: "mac", label: "Mac", providers: [
                try provider("one", email: "me@example.com", percent: 20, workspaceID: "ws-a"),
                try provider("two", email: "me@example.com", percent: 80, workspaceID: "ws-b"),
            ]),
        ])
        #expect(merged.count == 2)
    }

    /// Codex ids are slots: a weekly window pools by kind whichever slot it uses.
    @Test func codexWindowsPoolByKind() throws {
        let merged = FeatureUsageLimitsMerge.merge([
            .init(id: "mac", label: "Mac", providers: [
                try provider("one", email: "a@example.com", percent: 20, windowID: "primary", windowKind: "weekly"),
                try provider("two", email: "b@example.com", percent: 60, windowID: "secondary", windowKind: "weekly"),
            ]),
        ])
        let pool = try #require(FeatureUsageLimitsMerge.pools(merged).first)
        #expect(pool.accountCount == 2)
        #expect(pool.usedPercent == 40)
    }

    @Test func antigravityKeepsEachGroupTogetherGeminiFirst() throws {
        func window(_ id: String, _ kind: String) -> ServerProviderUsageLimits.Window {
            .init(id: id, kind: kind, label: id, usedPercent: 0, resetsAt: nil, windowDurationMins: nil)
        }
        let windows = [window("3p-weekly", "weekly"), window("gemini-weekly", "weekly"), window("3p-5h", "session"), window("gemini-5h", "session")]
        #expect(FeatureUsageLimitsMerge.displayOrder(driver: "antigravity", windows: windows).map(\.id)
            == ["gemini-5h", "gemini-weekly", "3p-5h", "3p-weekly"])
        #expect(FeatureUsageLimitsMerge.displayOrder(driver: "codex", windows: windows).map(\.id) == windows.map(\.id))
    }

    @Test func mergesHubQuotaAndTargetsItsExactResetCredit() throws {
        struct Fixture: Decodable { let source: UsageLimitSourceSnapshot; let config: UsageLimitSourceConfig }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("CoreTests/Fixtures/usageLimitSource.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        let result = FeatureUsageLimitsMerge.merge([.init(id: "mac", label: "Mac",
            providers: [try provider("personal", email: "same@example.com", percent: 20)], sources: [fixture.source])])
        #expect(result.count == 1)
        #expect(result.first?.resetTarget?.instanceID == nil)
        #expect(result.first?.resetTarget?.sourceID == "team-hub")
        #expect(result.first?.resetTarget?.creditID == "credit-a")
        #expect(result.first?.environments == ["Mac", "Mac · Team"])
        let patch = ServerSettingsPatchInput(usageLimitSources: ["team-hub": fixture.config])
        #expect(patch.json["usageLimitSources"]?["team-hub"]?["managementKey"] == .string("••••••"))
        #expect(ServerSettingsPatchInput(usageLimitSources: ["team-hub": nil]).json["usageLimitSources"]?["team-hub"] == .null)
    }

    @Test func keepsSuccessfulRedemptionWarningsDistinctFromErrors() throws {
        let result = try JSONDecoder().decode(ProviderConsumeResetCreditResult.self, from: Data(#"{"outcome":"reset","warning":"Refresh to confirm new limits."}"#.utf8))
        #expect(result.outcome == "reset")
        #expect(result.message == "Refresh to confirm new limits.")
    }

    @Test func accountLabelsNeverRenderEmailAddresses() {
        #expect(FeatureAccountLabel.display("Work", fallback: "codex") == "Work")
        #expect(FeatureAccountLabel.display("user@example.com", fallback: "codex") == "codex")
    }

    @Test func redemptionUsesTheInstanceThatReportedDisplayedCredits() throws {
        let merged = FeatureUsageLimitsMerge.merge([
            .init(id: "a", label: "Mac", providers: [try provider("personal", email: "same@example.com", percent: 20, credits: 1)]),
            .init(id: "b", label: "Server", providers: [try provider("work", email: "same@example.com", percent: 70, credits: 2, checkedAt: "2026-09-06T01:00:00Z")]),
        ])
        #expect(merged.count == 1)
        #expect(merged.first?.resetTarget?.environmentID == "b")
        #expect(merged.first?.resetTarget?.instanceID == "work")
        #expect(merged.first?.limits?.resetCredits?.availableCount == 2)
    }

    @Test func claudeAccountsWithBankedCreditsCanRedeemThroughTheirInstance() throws {
        let merged = FeatureUsageLimitsMerge.merge([
            .init(id: "mac", label: "Mac", providers: [
                try provider("claude-work", email: "claude@example.com", percent: 90, credits: 1, driver: "claudeAgent"),
                try provider("grok", email: "grok@example.com", percent: 10, credits: 1, driver: "grok"),
            ]),
        ])
        let claude = merged.first { $0.driver == "claudeAgent" }
        #expect(claude?.resetTarget?.environmentID == "mac")
        #expect(claude?.resetTarget?.instanceID == "claude-work")
        #expect(merged.first { $0.driver == "grok" }?.resetTarget == nil)
    }

    @Test func countsKnownAccountsOnceAndUsesFreshestReport() throws {
        let merged = FeatureUsageLimitsMerge.merge([
            .init(id: "a", label: "Mac", providers: [try provider("one", email: "USER@example.com", percent: 20)]),
            .init(id: "b", label: "Server", providers: [try provider("two", email: " user@example.com ", percent: 70, checkedAt: "2026-09-06T01:00:00Z")]),
        ])
        #expect(merged.count == 1)
        #expect(merged.first?.environments == ["Mac", "Server"])
        #expect(merged.first?.limits?.windows.first?.usedPercent == 70)
        #expect(FeatureUsageLimitsMerge.pools(merged).isEmpty)
    }

    @Test func keepsUnknownAccountsSeparateAndPoolsEqualShares() throws {
        let merged = FeatureUsageLimitsMerge.merge([
            .init(id: "a", label: "Mac", providers: [try provider("one", email: nil, percent: 20), try provider("two", email: nil, percent: 80)]),
        ])
        #expect(merged.count == 2)
        let pool = try #require(FeatureUsageLimitsMerge.pools(merged).first)
        #expect(pool.accountCount == 2)
        #expect(pool.usedPercent == 50)
    }

    @Test func decodesTheServerGeneratedContractFixture() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("CoreTests/Fixtures/providerUsageLimits.json")
        let limits = try JSONDecoder().decode(ServerProviderUsageLimits.self, from: Data(contentsOf: url))
        #expect(limits.windows.first?.usedPercent == 42)
        #expect(limits.resetCredits?.availableCount == 2)
        #expect(limits.resetCredits?.nextExpiresAt == "2026-09-28T00:00:00.000Z")
        #expect(limits.windows.first?.windowDurationMins == 300)
        #expect(FeatureUsageLimitsMerge.date(limits.windows.first?.resetsAt) != nil)
    }
}
