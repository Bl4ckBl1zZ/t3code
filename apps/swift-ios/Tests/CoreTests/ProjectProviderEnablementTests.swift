import Foundation
import Testing
@testable import T3Code

/// Mirrors the "per-project provider instance switches" suite in
/// packages/shared/src/serverSettings.test.ts, plus the picker scoping and
/// refusal wording built on it.
@Suite("Per-project provider switches")
struct ProjectProviderEnablementTests {
    private let projectID = "project-a"
    private let otherProjectID = "project-b"
    private let instanceID = "codex_work"

    private func machine(_ enabled: Bool, overrides: [String: [String: ProjectProviderInstanceOverride]] = [:]) -> ServerSettingsSnapshot {
        ServerSettingsSnapshot(
            providerInstances: [instanceID: .object(["driver": .string("codex"), "enabled": .bool(enabled), "config": .object([:])])],
            projectProviderInstanceOverrides: overrides
        )
    }

    @Test func inheritsTheMachineUntilTheProjectSetsOneInEitherDirection() {
        #expect(!machine(false).resolveProjectProviderInstanceEnabled(projectID: projectID, instanceID: instanceID))
        let turnedOn = machine(false, overrides: [projectID: [instanceID: .init(enabled: true)]])
        #expect(turnedOn.resolveProjectProviderInstanceEnabled(projectID: projectID, instanceID: instanceID))
        #expect(!turnedOn.resolveProjectProviderInstanceEnabled(projectID: otherProjectID, instanceID: instanceID))
        let turnedOff = machine(true, overrides: [projectID: [instanceID: .init(enabled: false)]])
        #expect(!turnedOff.resolveProjectProviderInstanceEnabled(projectID: projectID, instanceID: instanceID))
        // No project in scope always reads the machine.
        #expect(turnedOff.resolveProjectProviderInstanceEnabled(projectID: nil, instanceID: instanceID))
    }

    @Test func fallsBackToTheMachineDefaultForAnInstanceWithNoSettingsEntry() {
        let settings = ServerSettingsSnapshot()
        #expect(
            settings.resolveProjectProviderInstanceEnabled(projectID: projectID, instanceID: instanceID)
                == settings.resolveProjectProviderInstanceEnabled(projectID: nil, instanceID: instanceID)
        )
    }

    @Test func overrideWithoutEnabledInherits() {
        let settings = machine(true, overrides: [projectID: [instanceID: .init()]])
        #expect(settings.projectProviderInstanceOverride(projectID: projectID, instanceID: instanceID) == nil)
        #expect(settings.resolveProjectProviderInstanceEnabled(projectID: projectID, instanceID: instanceID))
    }

    @Test func machineEnablementFollowsTheContractsPrecedence() {
        func enabled(_ instance: [String: JSONValue]) -> Bool {
            ServerSettingsSnapshot.resolveProviderInstanceEnabled(instance)
        }
        // An explicit false on either flag wins.
        #expect(!enabled(["driver": .string("codex"), "enabled": .bool(true), "config": .object(["enabled": .bool(false)])]))
        #expect(enabled(["driver": .string("cursor"), "config": .object(["enabled": .bool(true)])]))
        // Otherwise the driver's default: Codex on, Cursor off, unknown drivers on.
        #expect(enabled(["driver": .string("codex")]))
        #expect(!enabled(["driver": .string("cursor")]))
        #expect(enabled(["driver": .string("someFork")]))
        // An unconfigured default instance reads the legacy providers block.
        let legacy = ServerSettingsSnapshot(providerDefinitions: ["codex": .object(["enabled": .bool(true)]), "cursor": .object(["enabled": .bool(false)])])
        #expect(legacy.isProviderInstanceEnabledOnMachine("codex"))
        #expect(!legacy.isProviderInstanceEnabledOnMachine("cursor"))
        #expect(!legacy.isProviderInstanceEnabledOnMachine("deleted_instance"))
    }

    // MARK: - Wire

    @Test func decodesOverridesAndCapabilityAndKeepsOlderServersWorking() throws {
        let settings = try JSONDecoder().decode(ServerSettingsSnapshot.self, from: Data(#"""
        {"defaultThreadEnvMode":"local","newWorktreesStartFromOrigin":true,
         "projectProviderInstanceOverrides":{"project-a":{"codex_work":{"enabled":false},"claudeAgent":{}}}}
        """#.utf8))
        #expect(settings.projectProviderInstanceOverrides == [
            "project-a": ["codex_work": .init(enabled: false), "claudeAgent": .init()],
        ])
        let roundTrip = try JSONDecoder().decode(ServerSettingsSnapshot.self, from: JSONEncoder().encode(settings))
        #expect(roundTrip == settings)

        let old = try JSONDecoder().decode(ServerSettingsSnapshot.self, from: Data(#"{"defaultThreadEnvMode":"local","newWorktreesStartFromOrigin":true}"#.utf8))
        #expect(old.projectProviderInstanceOverrides.isEmpty)
        let capabilities = try JSONDecoder().decode(EnvironmentDescriptor.Capabilities.self, from: Data(#"{"projectProviderInstanceOverrides":true}"#.utf8))
        #expect(capabilities.projectProviderInstanceOverrides == true)
        let oldCapabilities = try JSONDecoder().decode(EnvironmentDescriptor.Capabilities.self, from: Data("{}".utf8))
        #expect(oldCapabilities.projectProviderInstanceOverrides == nil)
    }

    // MARK: - Picker scoping

    private func config(capability: Bool, overrides: String) throws -> ServerConfigSnapshot {
        func provider(_ id: String, _ driver: String) -> String {
            #"{"instanceId":"\#(id)","driver":"\#(driver)","enabled":true,"installed":true,"status":"ready","auth":{"status":"authenticated"},"checkedAt":"2026-10-12T00:00:00.000Z","models":[{"slug":"m-\#(id)","name":"M","isCustom":false}]}"#
        }
        let json = #"""
        {"environment":{"environmentId":"env","label":"Host","platform":{"os":"darwin","arch":"arm64"},"serverVersion":"1",
          "capabilities":{"repositoryIdentity":true\#(capability ? #","projectProviderInstanceOverrides":true"# : "")}},
         "providers":[\#(provider("codex", "codex")),\#(provider("codex_work", "codex"))],
         "settings":{"defaultThreadEnvMode":"local","newWorktreesStartFromOrigin":true,
           "providers":{"codex":{"enabled":true}},
           "providerInstances":{"codex_work":{"driver":"codex","enabled":false}},
           "projectProviderInstanceOverrides":\#(overrides)}}
        """#
        return try JSONDecoder.t3.decode(ServerConfigSnapshot.self, from: Data(json.utf8))
    }

    @Test func scopesOnlyWhenTheServerEnforcesProjectSwitches() throws {
        let overrides = #"{"project-a":{"codex":{"enabled":false},"codex_work":{"enabled":true}}}"#
        // The server hydrated codex_work for project-a, so its snapshot reads
        // enabled; other projects still follow the machine and leave it off.
        let scoped = try config(capability: true, overrides: overrides)
        #expect(scoped.providerInstancesOff(inProject: "project-a") == ["codex"])
        #expect(scoped.providerInstancesOff(inProject: "project-b") == ["codex_work"])
        #expect(try config(capability: false, overrides: overrides).providerInstancesOff(inProject: "project-a") == nil)
        #expect(try config(capability: true, overrides: "{}").providerInstancesOff(inProject: "project-a") == nil)

        #expect(ModelOptions.build(config: scoped, fallbackSelection: nil, projectID: "project-a").map(\.providerKey) == ["codex_work"])
        #expect(ModelOptions.build(config: scoped, fallbackSelection: nil, projectID: "project-b").map(\.providerKey) == ["codex"])
        #expect(ModelOptions.build(config: scoped, fallbackSelection: nil).map(\.providerKey) == ["codex", "codex_work"])
        #expect(ModelOptions.selectable(ModelSelection(instanceId: "codex", model: "m-codex"), in: scoped, projectID: "project-a") == nil)
    }

    @Test func projectScopingMakesTurnedOffInstancesUnavailable() {
        let providers = [
            FeatureProvider(id: "codex", name: "Codex", driver: "codex", models: [FeatureModel(id: "m", name: "M")]),
            FeatureProvider(id: "claudeAgent", name: "Claude", driver: "claudeAgent", models: [FeatureModel(id: "m", name: "M")]),
        ]
        let project = FeatureProject(id: "p", environmentID: "env", name: "P", path: "/p", providerInstancesOff: ["codex"])
        #expect(project.scoping(providers).map(\.isAvailable) == [false, true])
        let unscoped = FeatureProject(id: "p", environmentID: "env", name: "P", path: "/p")
        #expect(unscoped.scoping(providers) == providers)
    }

    // MARK: - Refusal wording

    @Test func rewordsTheServersDisabledRefusal() {
        #expect(
            ProviderInstanceDisabledFailure.userMessage(for: #"Provider instance "codex_work" is disabled for project 0b6c1f4e-8a2d."#)
                == ProviderInstanceDisabledFailure.message
        )
        #expect(ProviderInstanceDisabledFailure.userMessage(for: "Thread not found") == nil)
    }
}
