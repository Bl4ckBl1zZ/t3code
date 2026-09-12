import Foundation
import Testing
@testable import T3Code

@Suite("Machine and project actions")
struct ProjectActionsContractTests {
    @Test func preservesInheritanceEmptyOverridesAndLifecycleFlags() throws {
        struct Fixture: Decodable {
            let patch: JSONValue
            let settings: ServerSettingsSnapshot
            let capabilities: EnvironmentDescriptor.Capabilities
        }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/projectActions.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        let defaults = fixture.settings.defaultProjectScripts
        #expect(defaults.first?.runOnWorktreeCreate == true)
        #expect(defaults.first?.runOnWorktreeDelete == true)
        #expect(defaults.first?.singleRun == true)
        #expect(fixture.capabilities.projectActionDefaults == true)
        #expect(ServerSettingsPatchInput(defaultProjectScripts: defaults, projectScriptOverrides: ["reset": nil, "empty": []]).json == fixture.patch)
        let legacy = [ProjectScript(id: "legacy", name: "Legacy", command: "echo legacy", icon: "play", runOnWorktreeCreate: false)]
        #expect(fixture.settings.resolvedProjectScripts(projectID: "reset", legacyScripts: legacy) == defaults)
        #expect(fixture.settings.resolvedProjectScripts(projectID: "empty", legacyScripts: legacy).isEmpty)
        #expect(fixture.settings.resolvedProjectScripts(projectID: "missing", legacyScripts: legacy) == legacy)
        #expect(fixture.settings.resolvedProjectScripts(projectID: "missing", legacyScripts: []) == defaults)
        #expect(fixture.settings.projectScriptsInheritDefaults(projectID: "reset", legacyScripts: legacy))
        #expect(!fixture.settings.projectScriptsInheritDefaults(projectID: "empty", legacyScripts: []))
        #expect(!fixture.settings.projectScriptsInheritDefaults(projectID: "missing", legacyScripts: defaults))
        let roundTrip = try JSONDecoder().decode(ServerSettingsSnapshot.self, from: JSONEncoder().encode(fixture.settings))
        #expect(roundTrip == fixture.settings)
    }
}
