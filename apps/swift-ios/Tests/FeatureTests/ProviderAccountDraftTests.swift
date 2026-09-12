import Foundation
import Testing
@testable import T3Code

struct ProviderAccountDraftTests {
    private let savedSecret: JSONValue = .object(["name": .string("API_KEY"), "value": .string(""), "sensitive": .bool(true), "valueRedacted": .bool(true)])
    private func field(_ key: String, control: String = "text", clear: String = "omit", defaultBoolean: Bool? = nil) -> NativeProviderSettingsDefinition.Field {
        .init(key: key, control: control, label: key, description: nil, placeholder: nil, clearWhenEmpty: clear, defaultBooleanValue: defaultBoolean)
    }
    @Test func untouchedCredentialsAndUnknownFieldsSurviveAnAccountRename() throws {
        let original: [String: JSONValue] = ["driver": .string("codex"), "environment": .array([savedSecret]), "future": .object(["nested": .number(42)]), "config": .object(["customModels": .array([.string("custom")])])]
        var draft = NativeProviderAccountDraft(driver: "codex", instanceID: "personal", original: original)
        draft.name = "Personal account"
        let other: JSONValue = .object(["driver": .string("cursor")])
        let result = try draft.merging(into: ["personal": .object(original), "other": other], latest: original)
        #expect(result["personal"]?["environment"] == .array([savedSecret]))
        #expect(result["personal"]?["future"] == original["future"])
        #expect(result["personal"]?["config"] == original["config"])
        #expect(result["other"] == other)
    }
    @Test func differentConfigurationEditsMergeWithTheLatestServerAnswer() throws {
        let original: [String: JSONValue] = ["driver": .string("codex"), "config": .object(["binaryPath": .string("old"), "launchArgs": .string("old args")])]
        var draft = NativeProviderAccountDraft(driver: "codex", instanceID: "codex", original: original)
        draft.setField(field("binaryPath"), value: .string("new"))
        var latest = original
        latest["config"] = .object(["binaryPath": .string("old"), "launchArgs": .string("other client"), "future": .bool(true)])
        let result = try draft.merging(into: [:], latest: latest)["codex"]
        #expect(result?["config"]?["binaryPath"] == .string("new"))
        #expect(result?["config"]?["launchArgs"] == .string("other client"))
        #expect(result?["config"]?["future"] == .bool(true))
    }
    @Test func concurrentEditsToTheSameFieldAreRejected() {
        let original: [String: JSONValue] = ["driver": .string("codex"), "displayName": .string("Before")]
        var draft = NativeProviderAccountDraft(driver: "codex", instanceID: "codex", original: original)
        draft.name = "My change"
        var latest = original; latest["displayName"] = .string("Their change")
        #expect(throws: ProviderAccountEditError.self) { try draft.merging(into: [:], latest: latest) }
    }
    @Test func sameConfigurationFieldConflictAndOpaqueConfigurationAreRejected() {
        let original: [String: JSONValue] = ["driver": .string("codex"), "config": .object(["binaryPath": .string("before")])]
        var draft = NativeProviderAccountDraft(driver: "codex", instanceID: "codex", original: original)
        draft.setField(field("binaryPath"), value: .string("mine"))
        var latest = original; latest["config"] = .object(["binaryPath": .string("theirs")])
        #expect(throws: ProviderAccountEditError.self) { try draft.merging(into: [:], latest: latest) }
        latest["config"] = .string("opaque provider payload")
        #expect(throws: ProviderAccountEditError.self) { try draft.merging(into: [:], latest: latest) }
    }
    @Test func secretReplacementIsExplicitAndRequiredBeforeRenaming() {
        var draft = NativeProviderAccountDraft(driver: "cursor")
        draft.environment = [savedSecret]
        draft.updateVariable(0, key: "name", value: .string("RENAMED"))
        draft.updateVariable(0, key: "sensitive", value: .bool(false))
        #expect(draft.environment == [savedSecret])
        draft.updateVariable(0, key: "value", value: .string("replacement"))
        #expect(draft.environment[0]["valueRedacted"] == .bool(false))
        draft.updateVariable(0, key: "name", value: .string("RENAMED"))
        #expect(draft.environment[0]["name"] == .string("RENAMED"))
        #expect(draft.environment[0]["sensitive"] == .bool(true))
    }
    @Test func clearingASecretPublishesAnExplicitEmptyValue() {
        var draft = NativeProviderAccountDraft(driver: "cursor")
        draft.environment = [savedSecret]
        draft.updateVariable(0, key: "value", value: .string(""))
        #expect(draft.environment[0]["value"] == .string(""))
        #expect(draft.environment[0]["valueRedacted"] == .bool(false))
    }
    @Test func fieldDefaultsOmitOrPersistExactlyAsTheSchemaSpecifies() {
        var draft = NativeProviderAccountDraft(driver: "openclaw")
        draft.setField(field("binaryPath"), value: .string("   "))
        #expect(draft.config["binaryPath"] == nil)
        draft.setField(field("url", clear: "persist"), value: .string(""))
        #expect(draft.config["url"] == .string(""))
        draft.setField(field("resetSession", control: "switch", clear: "persist"), value: .bool(false))
        #expect(draft.config["resetSession"] == .bool(false))
        draft.setField(field("option", control: "switch", defaultBoolean: true), value: .bool(true))
        #expect(draft.config["option"] == nil)
    }
    @Test func accountIDsDuplicatesAndColorsAreValidated() throws {
        var draft = NativeProviderAccountDraft(driver: "codex", instanceID: "1invalid")
        #expect(throws: ProviderAccountEditError.self) { try draft.merging(into: [:], latest: nil) }
        draft.instanceID = "valid_account-2"
        #expect(throws: ProviderAccountEditError.self) { try draft.merging(into: [draft.instanceID: .object([:])], latest: nil) }
        draft.accent = "red"
        #expect(throws: ProviderAccountEditError.self) { try draft.merging(into: [:], latest: nil) }
        draft.accent = "#Ab123f"
        #expect(try draft.merging(into: [:], latest: nil)[draft.instanceID]?["accentColor"] == .string("#Ab123f"))
    }
    @Test func duplicateAndInvalidEnvironmentNamesAreRejected() {
        var draft = NativeProviderAccountDraft(driver: "codex", instanceID: "personal")
        draft.addVariable(name: "TOKEN"); draft.addVariable(name: "TOKEN")
        #expect(throws: ProviderAccountEditError.self) { try draft.merging(into: [:], latest: nil) }
        draft.environment = []; draft.addVariable(name: "BAD-NAME")
        #expect(throws: ProviderAccountEditError.self) { try draft.merging(into: [:], latest: nil) }
    }
    @Test func builtInIdentityIsStableAndExplicitEnabledOverridesLegacy() {
        var draft = NativeProviderAccountDraft(driver: "codex", instanceID: "codex", original: ["driver": .string("codex"), "config": .object(["enabled": .bool(false)])])
        #expect(!draft.enabled)
        #expect(!draft.canRemove)
        draft.enabled = true
        #expect(draft.enabled)
        #expect(draft.envelope["enabled"] == .bool(true))
    }
    @Test func removedAndChangedProviderAccountsCannotBeResurrected() {
        let original: [String: JSONValue] = ["driver": .string("codex")]
        let draft = NativeProviderAccountDraft(driver: "codex", instanceID: "personal", original: original)
        #expect(throws: ProviderAccountEditError.self) { try draft.merging(into: [:], latest: nil) }
        #expect(throws: ProviderAccountEditError.self) { try draft.merging(into: [:], latest: ["driver": .string("cursor")]) }
        #expect(throws: ProviderAccountEditError.self) { try NativeProviderAccountDraft.resolve(instanceID: "personal", driver: "codex", instances: [:], legacy: [:], definition: nil) }
    }
    @Test func namesKeepSpacesDuringEditingAndNormalizeOnlyOnSave() throws {
        var draft = NativeProviderAccountDraft(driver: "codex", instanceID: "personal")
        draft.name = "Personal "
        #expect(draft.name == "Personal ")
        draft.name += "account  "
        #expect(try draft.merging(into: [:], latest: nil)["personal"]?["displayName"] == .string("Personal account"))
    }

    @Test func generatedCatalogueDecodesIntoNativeFormFields() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("Resources/ProviderSettingsCatalog.json"))
        let definitions = try JSONDecoder().decode([NativeProviderSettingsDefinition].self, from: data)
        let codex = try #require(definitions.first { $0.driver == "codex" })
        #expect(codex.fields.contains { $0.key == "binaryPath" && $0.control == "text" })
        #expect(!codex.fields.contains { $0.key == "customModels" })
        let cursor = try #require(definitions.first { $0.driver == "cursor" })
        #expect(cursor.environmentFields.contains { $0.name == "CURSOR_API_KEY" && $0.sensitive == true })
        let hermes = try #require(definitions.first { $0.driver == "hermes" })
        #expect(hermes.defaultInstance?["enabled"] == .bool(false))
        #expect(definitions.first { $0.driver == "acpRegistry" }?.hasDefaultInstance == false)
    }

}
