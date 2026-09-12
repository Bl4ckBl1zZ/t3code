import Foundation
import Testing
@testable import T3Code

struct EnvironmentMachineTests {
    @Test func decodesServerMachineFixture() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/environmentMachine.json")
        let descriptor = try JSONDecoder().decode(EnvironmentDescriptor.self, from: Data(contentsOf: fixture))
        #expect(descriptor.platform.machine == "mac-studio")
        #expect(descriptor.capabilities.environmentIcon == true)
        #expect(descriptor.capabilities.assistantCitations == true)
        #expect(descriptor.capabilities.customModelDefinitions == true)
        #expect(descriptor.capabilities.projectIcons == true)
        #expect(EnvironmentMachineKind(rawValue: descriptor.platform.machine!)?.symbol == "macstudio")
    }

    @Test func automaticClearsOnlyTheOverrideAndOmissionDoesNotWrite() {
        #expect(ServerSettingsPatchInput(environmentIcon: .some(nil)).json == .object(["environmentIcon": .null]))
        #expect(ServerSettingsPatchInput(environmentIcon: .some("laptop")).json == .object(["environmentIcon": .string("laptop")]))
        #expect(ServerSettingsPatchInput().json == .object([:]))
        #expect(EnvironmentMachineKind(rawValue: "future-device") == nil)
    }
}
