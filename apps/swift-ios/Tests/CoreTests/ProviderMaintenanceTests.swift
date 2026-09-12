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
}
