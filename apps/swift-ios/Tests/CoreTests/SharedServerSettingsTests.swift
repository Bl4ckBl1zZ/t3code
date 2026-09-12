import Foundation
import Testing
@testable import T3Code

struct SharedServerSettingsTests {
    @Test func settingsRefreshPreservesTheEnvironmentEnvelope() throws {
        var config = ServerConfigSnapshot(providers: [], t3WorkDirectory: "/work", threadSnapshotWindow: true)
        config.cwd = "/project"
        config.environment = try JSONDecoder().decode(EnvironmentDescriptor.self, from: Data(#"{"environmentId":"machine","label":"Machine","serverVersion":"1","platform":{"os":"darwin","arch":"arm64"},"capabilities":{"repositoryIdentity":true,"threadRestartContinuation":true}}"#.utf8))
        let refreshed = config.replacingSettings(.init(continueThreadsAfterServerUpdate: true))
        #expect(refreshed.environment == config.environment)
        #expect(refreshed.environment?.capabilities.threadRestartContinuation == true)
        #expect(refreshed.cwd == "/project")
        #expect(refreshed.t3WorkDirectory == "/work")
        #expect(refreshed.threadSnapshotWindow == true)
        #expect(refreshed.settings?.continueThreadsAfterServerUpdate == true)
    }
    @Test func writingStyleChangesStaySparse() {
        #expect(ServerSettingsPatchInput(sourceControlWritingStyle: .init(customInstructions: "")).json == .object(["sourceControlWritingStyle": .object(["customInstructions": .string("")])]))
        #expect(ServerSettingsPatchInput(sourceControlWritingStyle: .init(followChangeRequestTemplates: false)).json == .object(["sourceControlWritingStyle": .object(["followChangeRequestTemplates": .bool(false)])]))
    }
    @Test func keepsMachineConfigurationLocalAndPreservesExplicitOff() {
        let patch = ServerSettingsPatchInput(sidebarAutoSettleAfterDays: .some(nil),
            continueThreadsAfterServerUpdate: false, sidebarAutoSettleOnMerge: false,
            defaultThreadEnvMode: .worktree, enableAgentBrowserAccess: false)
        let split = SharedServerSettings.split(patch)
        #expect(split.shared.json == .object(["sidebarAutoSettleAfterDays": .null,
            "continueThreadsAfterServerUpdate": .bool(false), "sidebarAutoSettleOnMerge": .bool(false)]))
        #expect(split.local.json == .object(["defaultThreadEnvMode": .string("worktree"), "enableAgentBrowserAccess": .bool(false)]))
    }
    @Test func filtersIncompatibleAccountsAndUnsupportedRestart() {
        let selection = ModelSelection(instanceId: "personal", model: "model")
        let source = ServerSettingsSnapshot(providerInstances: ["personal": .object(["driver": .string("codex"), "enabled": .bool(true)])], textGenerationModelSelection: selection)
        let target = ServerSettingsSnapshot(providerInstances: ["personal": .object(["driver": .string("claudeAgent"), "enabled": .bool(true)])])
        let patch = ServerSettingsPatchInput(continueThreadsAfterServerUpdate: true, textGenerationModelSelection: selection)
        #expect(SharedServerSettings.isEmpty(SharedServerSettings.filter(patch, restartSupported: false, target: target, source: source)))
        #expect(SharedServerSettings.filter(patch, restartSupported: true, target: source, source: source) == patch)
    }
    @Test func detectsOnlyMutuallySupportedPreferenceDrift() {
        let source = ServerSettingsSnapshot(continueThreadsAfterServerUpdate: false)
        let target = ServerSettingsSnapshot(continueThreadsAfterServerUpdate: true)
        #expect(!SharedServerSettings.differs(source: source, sourceRestart: false, target: target, targetRestart: true))
        #expect(SharedServerSettings.differs(source: source, sourceRestart: true, target: target, targetRestart: true))
    }
    @Test func generatedSettingsRetainSharedModelAndWritingStyle() throws {
        struct Fixture: Decodable { let settings: ServerSettingsSnapshot }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/projectDefaults.json")
        let settings = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).settings
        #expect(settings.textGenerationModelSelection != nil)
        #expect(settings.sourceControlWritingStyle?.mode == "repo_conventions")
        #expect(try JSONDecoder().decode(ServerSettingsSnapshot.self, from: JSONEncoder().encode(settings)) == settings)
    }
}
