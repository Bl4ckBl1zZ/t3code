import Foundation
import Testing
@testable import T3Code

@Suite("Project model and workspace defaults")
struct ProjectDefaultsContractTests {
    @Test func decodesMachineSelectionAndEncodesReset() throws {
        struct Fixture: Decodable {
            let patch: JSONValue
            let settings: ServerSettingsSnapshot
            let capabilities: EnvironmentDescriptor.Capabilities
        }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/projectDefaults.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        #expect(fixture.settings.defaultModelSelection == ModelSelection(instanceId: "codex", model: "gpt-5.6-sol", options: [.init(id: "reasoningEffort", value: .string("high"))]))
        #expect(fixture.settings.defaultThreadEnvMode == .worktree)
        #expect(fixture.capabilities.projectDefaults == true)
        #expect(ServerSettingsPatchInput(defaultModelSelection: .some(nil), defaultThreadEnvMode: .worktree).json == fixture.patch)
        let roundTrip = try JSONDecoder().decode(ServerSettingsSnapshot.self, from: JSONEncoder().encode(fixture.settings))
        #expect(roundTrip == fixture.settings)
    }
    @Test func selectionWritesPreserveOptionsWhileOmittedDefaultsStayUntouched() {
        let selection = ModelSelection(instanceId: "remote", model: "model", options: [.init(id: "fastMode", value: .bool(true))])
        #expect(ServerSettingsPatchInput(defaultModelSelection: .some(selection)).json == .object(["defaultModelSelection": .object(["instanceId": .string("remote"), "model": .string("model"), "options": .array([.object(["id": .string("fastMode"), "value": .bool(true)])])])]))
        #expect(ServerSettingsPatchInput().isEmpty)
    }
}
