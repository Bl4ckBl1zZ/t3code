import Foundation
import Testing
@testable import T3Code

@Suite("Subscription limit pooling")
struct UsageLimitsMergeTests {
    private func provider(_ id: String, email: String?, percent: Double, checkedAt: String = "2026-09-06T00:00:00Z") throws -> ServerProviderSnapshot {
        var auth: [String: Any] = ["status": "authenticated"]
        if let email { auth["email"] = email }
        return try JSONDecoder().decode(ServerProviderSnapshot.self, from: JSONSerialization.data(withJSONObject: [
            "instanceId": id, "driver": "codex", "enabled": true, "installed": true,
            "status": "ready", "auth": auth, "checkedAt": checkedAt, "models": [],
            "usageLimits": ["checkedAt": checkedAt, "windows": [["id": "primary", "kind": "session", "label": "Session", "usedPercent": percent, "windowDurationMins": 300]]],
        ]))
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
        #expect(limits.windows.first?.windowDurationMins == 300)
        #expect(FeatureUsageLimitsMerge.date(limits.windows.first?.resetsAt) != nil)
    }
}
