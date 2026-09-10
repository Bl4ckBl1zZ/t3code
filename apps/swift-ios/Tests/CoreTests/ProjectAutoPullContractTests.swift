import Foundation
import Testing
@testable import T3Code

@Suite("Automatic project pull contracts")
struct ProjectAutoPullContractTests {
    private struct Fixture: Decodable {
        let patch: JSONValue
        let settings: ServerSettingsSnapshot
        let capabilities: EnvironmentDescriptor.Capabilities
    }
    @Test func decodesServerDefaultsAndExplicitOff() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/projectAutoPull.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        #expect(fixture.settings.defaultAutoPull)
        #expect(fixture.settings.projectAutoPullOverrides == ["off": false])
        #expect(fixture.capabilities.projectAutoPull == true)
        let roundTrip = try JSONDecoder().decode(ServerSettingsSnapshot.self, from: JSONEncoder().encode(fixture.settings))
        #expect(roundTrip == fixture.settings)
        #expect(ServerSettingsPatchInput(defaultAutoPull: true, projectAutoPullOverrides: ["off": false, "reset": nil]).json == fixture.patch)
    }
    @Test func oldServersDefaultOffAndRemainCapabilityGated() throws {
        let settings = try JSONDecoder().decode(ServerSettingsSnapshot.self, from: Data(#"{"defaultThreadEnvMode":"local","newWorktreesStartFromOrigin":true}"#.utf8))
        #expect(!settings.defaultAutoPull)
        #expect(settings.projectAutoPullOverrides.isEmpty)
        let capabilities = try JSONDecoder().decode(EnvironmentDescriptor.Capabilities.self, from: Data("{}".utf8))
        #expect(capabilities.projectAutoPull == nil)
    }
    @Test func resetIsAnExplicitNullWithoutChangingOtherProjectsOrDefault() {
        let patch = ServerSettingsPatchInput(projectAutoPullOverrides: ["project": nil])
        #expect(patch.json == .object(["projectAutoPullOverrides": .object(["project": .null])]))
        #expect(!patch.isEmpty)
        #expect(ServerSettingsPatchInput(defaultAutoPull: false).json == .object(["defaultAutoPull": .bool(false)]))
    }
}
