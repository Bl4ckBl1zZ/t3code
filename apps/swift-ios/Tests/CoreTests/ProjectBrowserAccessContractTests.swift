import Foundation
import Testing
@testable import T3Code

@Suite("Project browser access contracts")
struct ProjectBrowserAccessContractTests {
    @Test func decodesOverridesAndEncodesSparseResets() throws {
        struct Fixture: Decodable {
            let patch: JSONValue
            let settings: ServerSettingsSnapshot
            let capabilities: EnvironmentDescriptor.Capabilities
        }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/projectBrowserAccess.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        #expect(fixture.settings.enableAgentBrowserAccess)
        #expect(fixture.settings.projectAgentBrowserAccessOverrides == ["off": false])
        #expect(fixture.capabilities.projectBrowserAccess == true)
        #expect(ServerSettingsPatchInput(projectAgentBrowserAccessOverrides: ["off": false, "reset": nil], enableAgentBrowserAccess: false).json == fixture.patch)
        let roundTrip = try JSONDecoder().decode(ServerSettingsSnapshot.self, from: JSONEncoder().encode(fixture.settings))
        #expect(roundTrip == fixture.settings)
    }
    @Test func legacyServersKeepTheirGlobalBehavior() throws {
        let settings = try JSONDecoder().decode(ServerSettingsSnapshot.self, from: Data(#"{"defaultThreadEnvMode":"local","newWorktreesStartFromOrigin":true,"enableAgentBrowserAccess":false}"#.utf8))
        #expect(!settings.enableAgentBrowserAccess)
        #expect(settings.projectAgentBrowserAccessOverrides.isEmpty)
        let capabilities = try JSONDecoder().decode(EnvironmentDescriptor.Capabilities.self, from: Data("{}".utf8))
        #expect(capabilities.projectBrowserAccess == nil)
        #expect(ServerSettingsPatchInput(projectAgentBrowserAccessOverrides: ["project": nil]).json == .object(["projectAgentBrowserAccessOverrides": .object(["project": .null])]))
    }
}
