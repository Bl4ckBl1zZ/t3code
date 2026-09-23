import Foundation
import Testing
@testable import T3Code

struct ProviderMaintenanceTests {
    @Test func olderAdvisoriesNeverInventAnUpdateCapability() throws {
        let value = try JSONDecoder().decode(ServerProviderVersionAdvisory.self,
            from: Data(#"{"status":"behind_latest","currentVersion":"1","latestVersion":"2","updateCommand":"npm update"}"#.utf8))
        #expect(!value.canUpdate)
        #expect(!value.offersUpdate)
    }
    @Test func ownedBehindInstallOffersAnUpdateButCurrentAndUnknownStatusesDoNot() throws {
        for (status, expected) in [("behind_latest", true), ("current", false), ("unknown", false), ("future-status", false)] {
            let data = try JSONSerialization.data(withJSONObject: ["status": status, "canUpdate": true, "updateCommand": "brew upgrade codex"])
            let value = try JSONDecoder().decode(ServerProviderVersionAdvisory.self, from: data)
            #expect(value.offersUpdate == expected)
            #expect(try JSONDecoder().decode(ServerProviderVersionAdvisory.self, from: JSONEncoder().encode(value)) == value)
        }
    }
    @Test func capabilityWithoutACommandDoesNotOfferAnUpdate() throws {
        let value = try JSONDecoder().decode(ServerProviderVersionAdvisory.self,
            from: Data(#"{"status":"behind_latest","canUpdate":true,"updateCommand":null}"#.utf8))
        #expect(!value.offersUpdate)
    }
    @Test func queuedAndRunningRemainBusyWhileTerminalResultsRemainReadable() throws {
        for status in ["queued", "running", "succeeded", "failed", "unchanged", "idle", "future-state"] {
            let data = try JSONSerialization.data(withJSONObject: ["status": status, "message": "Result", "output": "Output"])
            let value = try JSONDecoder().decode(ServerProviderUpdateState.self, from: data)
            #expect(value.isActive == ["queued", "running"].contains(status))
            #expect(value.message == "Result")
            #expect(value.output == "Output")
        }
    }

    private func snapshot(enabled: Bool = true, versionAdvisory: [String: Any]?, compatibility: [String: Any]?) throws -> ServerProviderSnapshot {
        var object: [String: Any] = [
            "instanceId": "opencode", "driver": "opencode", "enabled": enabled, "installed": true,
            "version": "1.14.3", "status": "ready", "auth": ["status": "authenticated"],
            "checkedAt": "2026-09-23T00:00:00.000Z", "models": [],
        ]
        object["versionAdvisory"] = versionAdvisory
        object["compatibilityAdvisory"] = compatibility
        return try JSONDecoder().decode(ServerProviderSnapshot.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private let behindLatest: [String: Any] = [
        "status": "behind_latest", "latestVersion": "1.15.2", "canUpdate": true,
        "updateCommand": "npm install -g opencode-ai@latest", "canInstallVersion": true,
    ]

    @Test func olderServersNeitherWarnNorOfferAPinnedInstall() throws {
        var legacy = behindLatest
        legacy.removeValue(forKey: "canInstallVersion")
        let provider = try snapshot(versionAdvisory: legacy, compatibility: nil)
        #expect(provider.compatibilityAdvisory == nil)
        #expect(provider.versionAdvisory?.canInstallVersion == false)
        #expect(provider.offersLatestUpdate)
        #expect(provider.installableRecommendedVersion == nil)
        #expect(provider.incompatibleVersionWarning == nil)
    }

    @Test func aBrokenVersionWarnsAndOffersTheRecommendedVersionInsteadOfAnIncompatibleLatest() throws {
        let provider = try snapshot(versionAdvisory: behindLatest, compatibility: [
            "status": "broken", "latestVersionStatus": "unsupported",
            "message": "This provider version is known to be incompatible. Use 1.14.19.",
            "recommendedVersion": "1.14.19", "recommendedRange": NSNull(),
        ])
        #expect(provider.compatibilityAdvisory?.title == "Known broken version")
        #expect(provider.incompatibleVersionWarning == "This provider version is known to be incompatible. Use 1.14.19.")
        #expect(!provider.offersLatestUpdate)
        #expect(provider.installableRecommendedVersion == "1.14.19")

        var unpinnable = behindLatest
        unpinnable["canInstallVersion"] = false
        #expect(try snapshot(versionAdvisory: unpinnable, compatibility: [
            "status": "broken", "recommendedVersion": "1.14.19",
        ]).installableRecommendedVersion == nil)
    }

    @Test func limitedSupportExplainsItselfWithoutBlockingTheComposer() throws {
        let provider = try snapshot(versionAdvisory: behindLatest, compatibility: [
            "status": "graceful", "latestVersionStatus": "supported", "message": NSNull(),
            "recommendedVersion": NSNull(), "recommendedRange": ">=1.15.0",
        ])
        #expect(provider.compatibilityAdvisory?.title == "Limited support")
        #expect(provider.compatibilityAdvisory?.detail == "Use >=1.15.0 for full support.")
        #expect(provider.incompatibleVersionWarning == nil)
        #expect(provider.offersLatestUpdate)
    }

    @Test func supportedUnknownAndFutureStatusesStayQuiet() throws {
        for status in ["supported", "unknown", "future-status"] {
            let provider = try snapshot(versionAdvisory: nil, compatibility: ["status": status, "recommendedVersion": "2.0.0"])
            #expect(provider.compatibilityAdvisory?.title == nil)
            #expect(provider.incompatibleVersionWarning == nil)
        }
    }

    @Test func aDisabledProviderNeverWarns() throws {
        let provider = try snapshot(enabled: false, versionAdvisory: behindLatest, compatibility: [
            "status": "broken", "recommendedVersion": "1.14.19",
        ])
        #expect(provider.incompatibleVersionWarning == nil)
        #expect(provider.installableRecommendedVersion == nil)
        #expect(!provider.offersLatestUpdate)
    }
}
