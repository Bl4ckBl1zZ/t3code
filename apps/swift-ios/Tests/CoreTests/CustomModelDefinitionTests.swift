import Foundation
import Testing
@testable import T3Code

struct CustomModelDefinitionTests {
    @Test func contractFixtureSurvivesEditing() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/customModels.json")
        let values = try JSONDecoder().decode([JSONValue].self, from: Data(contentsOf: fixture))
        let models = NativeCustomModelDefinition.readEntries(values)
        #expect(models.count == 2)
        #expect(models[0].json == .string("legacy-model"))
        let draft = NativeCustomModelDraft(definition: models[1])
        #expect(draft.options.count == 2)
        #expect(try draft.definition().json == values[1])
    }

    @Test func accountPatchPreservesOtherAccountsAndUnknownConfiguration() throws {
        let target: JSONValue = .object(["driver": .string("codex"), "name": .string("Work"),
            "config": .object(["binaryPath": .string("/tools/codex"), "futureFlag": .bool(true), "customModels": .array([.string("old")])])])
        let other: JSONValue = .object(["driver": .string("claudeAgent"), "config": .object(["autoCompactWindow": .string("300000")])])
        let settings = ServerSettingsSnapshot(providerInstances: ["work": target, "other": other])
        let patch = try NativeCustomModelSettings.patch(settings: settings, instanceID: "work", driver: "codex", entries: [.string("new")])
        #expect(patch.json["providerInstances"]?["other"] == other)
        #expect(patch.json["providerInstances"]?["work"]?["name"] == .string("Work"))
        #expect(patch.json["providerInstances"]?["work"]?["config"]?["futureFlag"] == .bool(true))
        #expect(patch.json["providerInstances"]?["work"]?["config"]?["binaryPath"] == .string("/tools/codex"))
        #expect(patch.json["providerInstances"]?["work"]?["config"]?["customModels"] == .array([.string("new")]))
        let encoded = try JSONEncoder().encode(settings)
        #expect(try JSONDecoder().decode(ServerSettingsSnapshot.self, from: encoded) == settings)
    }

    @Test func legacyPatchOnlyNamesChangedLeaves() throws {
        let settings = ServerSettingsSnapshot(providerDefinitions: ["codex": .object(["binaryPath": .string("custom")])])
        let patch = try NativeCustomModelSettings.patch(settings: settings, instanceID: "codex", driver: "codex", entries: [.string("new")])
        #expect(patch.json == .object(["providers": .object(["codex": .object(["customModels": .array([.string("new")])])])]))
        #expect(throws: CustomModelEditError.self) {
            try NativeCustomModelSettings.patch(settings: settings, instanceID: "missing", driver: "codex", entries: [])
        }
    }

    @Test func duplicateChoicesCannotBeSavedAndUnknownFieldsSurvive() throws {
        let model = NativeCustomModelDefinition.read(.object(["slug": .string("model"), "futureField": .bool(true)]))!
        var draft = NativeCustomModelDraft(definition: model)
        draft.name = "Friendly"
        #expect(try draft.definition().json["futureField"] == .bool(true))
        draft.options = [NativeCustomModelOption(optionID: "effort", label: "Reasoning", choices: [
            NativeCustomModelChoice(value: "high", label: "High"), NativeCustomModelChoice(value: " high ", label: "Duplicate")
        ])]
        #expect(throws: CustomModelEditError.self) { try draft.definition() }
        #expect(NativeCustomModelDefinition.readEntries([.string(" model "), .object(["slug": .string("model"), "name": .string("Duplicate")])]).count == 1)
    }
}
