import Foundation
import XCTest

@testable import T3Code

/// Ports apps/mobile/src/lib/modelOptions.test.ts. Configs are built by decoding
/// wire JSON rather than by memberwise init, so the fixtures stay as close to
/// the TypeScript ones as the decoder allows.
final class ModelOptionsTests: XCTestCase {
    private func config(providers: String) throws -> ServerConfigSnapshot {
        try JSONDecoder.t3.decode(
            ServerConfigSnapshot.self,
            from: Data(#"{"providers": \#(providers)}"#.utf8)
        )
    }

    private static let codexHeader = """
    "instanceId": "codex",
    "driver": "codex",
    "displayName": "Codex",
    "enabled": true,
    "installed": true,
    "status": "ready",
    "auth": { "status": "authenticated" },
    "checkedAt": "2026-08-02T12:00:00.000Z"
    """

    // MARK: - Menu shape

    func testLegacyModelsFoldIntoASeparateProviderScopedMenu() throws {
        let config = try config(
            providers: """
            [{
              \(Self.codexHeader),
              "models": [
                { "slug": "gpt-5.6-sol", "name": "GPT-5.6 Sol", "isCustom": false },
                { "slug": "gpt-5.4", "name": "GPT-5.4", "isCustom": false, "isLegacy": true }
              ]
            }]
            """
        )

        let actions = ModelOptions.menuActions(
            for: ModelOptions.grouped(
                ModelOptions.build(config: config, fallbackSelection: nil)
            ),
            selected: nil
        )

        XCTAssertEqual(actions.map(\.id), ["provider:codex", "legacy-models:codex"])
        XCTAssertEqual(actions.map(\.title), ["Codex", "Codex legacy models"])
        XCTAssertEqual(actions.first?.subactions.map(\.id), ["model:codex:gpt-5.6-sol"])
        XCTAssertEqual(actions.first?.subactions.map(\.title), ["GPT-5.6 Sol"])
        XCTAssertEqual(actions.last?.subactions.map(\.id), ["model:codex:gpt-5.4"])
    }

    func testProviderMenuIsOmittedWhenEveryModelIsLegacy() throws {
        let config = try config(
            providers: """
            [{
              \(Self.codexHeader),
              "models": [
                { "slug": "gpt-5.4", "name": "GPT-5.4", "isCustom": false, "isLegacy": true }
              ]
            }]
            """
        )

        let actions = ModelOptions.menuActions(
            for: ModelOptions.grouped(
                ModelOptions.build(config: config, fallbackSelection: nil)
            ),
            selected: nil
        )

        XCTAssertEqual(actions.map(\.id), ["legacy-models:codex"])
        XCTAssertEqual(actions.first?.title, "Codex legacy models")
        XCTAssertEqual(actions.first?.subactions.map(\.id), ["model:codex:gpt-5.4"])
    }

    func testSelectedModelIsMarkedAndEchoedOnItsProviderRow() throws {
        let config = try config(
            providers: """
            [{
              \(Self.codexHeader),
              "models": [
                { "slug": "gpt-5.6-sol", "name": "GPT-5.6 Sol", "isCustom": false },
                { "slug": "gpt-5.4", "name": "GPT-5.4", "isCustom": false, "isLegacy": true }
              ]
            }]
            """
        )
        let selected = ModelSelection(instanceId: "codex", model: "gpt-5.4")

        let actions = ModelOptions.menuActions(
            for: ModelOptions.grouped(
                ModelOptions.build(config: config, fallbackSelection: nil)
            ),
            selected: selected
        )

        // A legacy pick belongs on the legacy shelf, never on the current row.
        XCTAssertNil(actions.first?.subtitle)
        XCTAssertEqual(actions.last?.subtitle, "GPT-5.4")
        XCTAssertEqual(actions.first?.subactions.map(\.isSelected), [false])
        XCTAssertEqual(actions.last?.subactions.map(\.isSelected), [true])
    }

    // MARK: - Selection normalization

    func testFallbackSelectionIsNormalizedAgainstCurrentCapabilities() throws {
        let config = try config(
            providers: """
            [{
              \(Self.codexHeader),
              "models": [{
                "slug": "gpt-test",
                "name": "GPT Test",
                "isCustom": false,
                "capabilities": {
                  "optionDescriptors": [{
                    "id": "serviceTier",
                    "label": "Service Tier",
                    "type": "select",
                    "options": [
                      { "id": "default", "label": "Standard", "isDefault": true },
                      { "id": "priority", "label": "Fast" }
                    ],
                    "currentValue": "default"
                  }]
                }
              }]
            }]
            """
        )

        let option = ModelOptions.build(
            config: config,
            fallbackSelection: ModelSelection(
                instanceId: "codex",
                model: "gpt-test",
                // A stale option the model no longer advertises.
                options: [.init(id: "fastMode", value: .bool(true))]
            )
        ).first

        guard case let .select(descriptor)? = option?.capabilities?.optionDescriptors?.first else {
            return XCTFail("expected the select descriptor to survive on the option")
        }
        XCTAssertEqual(descriptor.id, "serviceTier")
        XCTAssertEqual(option?.selection.options?.map(\.id), ["serviceTier"])
        XCTAssertEqual(option?.selection.options?.first?.value, JSONValue.string("default"))
    }

    func testSettingAnOptionReplacesItsStoredValueInPlace() {
        let selection = ModelSelection(
            instanceId: "codex",
            model: "gpt-test",
            options: [
                .init(id: "reasoningEffort", value: .string("medium")),
                .init(id: "fastMode", value: .bool(false)),
            ]
        )

        let effort = ModelOptions.setting(.string("high"), forOption: "reasoningEffort", on: selection)
        XCTAssertEqual(effort.options?.map(\.id), ["reasoningEffort", "fastMode"])
        XCTAssertEqual(effort.options?.first?.value, JSONValue.string("high"))

        let added = ModelOptions.setting(.string("1m"), forOption: "contextWindow", on: effort)
        XCTAssertEqual(added.options?.map(\.id), ["reasoningEffort", "fastMode", "contextWindow"])
        XCTAssertEqual(added.instanceId, "codex")
        XCTAssertEqual(added.model, "gpt-test")
    }

    func testFallbackSelectionForAMissingModelIsListedUnderItsBareIdentifiers() throws {
        let config = try config(
            providers: """
            [{
              \(Self.codexHeader),
              "models": [{ "slug": "gpt-5.6-sol", "name": "GPT-5.6 Sol", "isCustom": false }]
            }]
            """
        )

        let options = ModelOptions.build(
            config: config,
            fallbackSelection: ModelSelection(instanceId: "retired", model: "gpt-old")
        )

        XCTAssertEqual(options.map(\.key), ["codex:gpt-5.6-sol", "retired:gpt-old"])
        XCTAssertEqual(options.last?.label, "gpt-old")
        XCTAssertEqual(options.last?.providerLabel, "retired")
        XCTAssertNil(options.last?.capabilities)
    }

    func testFallbackSelectionKeepsItsCatalogPositionWhenTheModelIsAlreadyListed() throws {
        let config = try config(
            providers: """
            [{
              \(Self.codexHeader),
              "models": [
                { "slug": "gpt-5.6-sol", "name": "GPT-5.6 Sol", "isCustom": false },
                { "slug": "gpt-5.4", "name": "GPT-5.4", "isCustom": false }
              ]
            }]
            """
        )

        let options = ModelOptions.build(
            config: config,
            fallbackSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        )

        XCTAssertEqual(options.map(\.key), ["codex:gpt-5.6-sol", "codex:gpt-5.4"])
        // Merged into the catalog entry, not appended as a bare duplicate.
        XCTAssertEqual(options.first?.label, "GPT-5.6 Sol")
    }

    // MARK: - resolveSelectableModelSelection

    func testStoredSelectionsAreRejectedWhenTheirProviderIsNotUsable() throws {
        let config = try config(
            providers: """
            [{
              "instanceId": "codex",
              "driver": "codex",
              "enabled": true,
              "installed": true,
              "status": "ready",
              "auth": { "status": "authenticated" },
              "checkedAt": "2026-08-02T12:00:00.000Z",
              "models": []
            }, {
              "instanceId": "claudeAgent",
              "driver": "claudeAgent",
              "enabled": false,
              "installed": true,
              "status": "ready",
              "auth": { "status": "authenticated" },
              "checkedAt": "2026-08-02T12:00:00.000Z",
              "models": []
            }]
            """
        )

        let usable = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        let disabled = ModelSelection(instanceId: "claudeAgent", model: "claude-sonnet-5")
        let removed = ModelSelection(instanceId: "codex_personal", model: "gpt-5.6-sol")

        XCTAssertEqual(ModelOptions.selectable(usable, in: config), usable)
        XCTAssertNil(ModelOptions.selectable(disabled, in: config))
        XCTAssertNil(ModelOptions.selectable(removed, in: config))
        // No config (environment offline) — nothing to validate against.
        XCTAssertEqual(ModelOptions.selectable(disabled, in: nil), disabled)
    }
}

/// Mirrors the "model visibility preferences" block in
/// apps/mobile/src/lib/modelOptions.test.ts.
final class ProviderModelPreferencesTests: XCTestCase {
    private func config(hidden: String, order: String) throws -> ServerConfigSnapshot {
        try JSONDecoder.t3.decode(
            ServerConfigSnapshot.self,
            from: Data(
                #"""
                {
                  "settings": {
                    "defaultThreadEnvMode": "local",
                    "newWorktreesStartFromOrigin": true,
                    "providerModelPreferences": {
                      "opencode": { "hiddenModels": \#(hidden), "modelOrder": \#(order) }
                    }
                  },
                  "providers": [{
                    "instanceId": "opencode",
                    "driver": "opencode",
                    "displayName": "OpenCode",
                    "enabled": true,
                    "installed": true,
                    "status": "ready",
                    "auth": { "status": "authenticated" },
                    "checkedAt": "2026-08-02T12:00:00.000Z",
                    "models": [
                      { "slug": "alpha", "name": "Alpha", "isCustom": false },
                      { "slug": "beta", "name": "Beta", "isCustom": false },
                      { "slug": "mine", "name": "Mine", "isCustom": true }
                    ]
                  }]
                }
                """#.utf8
            )
        )
    }

    func testHidesModelsTheUserHidOnAnotherClient() throws {
        let config = try config(hidden: #"["beta"]"#, order: "[]")
        XCTAssertEqual(
            ModelOptions.build(config: config, fallbackSelection: nil).map(\.key),
            ["opencode:alpha", "opencode:mine"]
        )
    }

    func testNeverHidesACustomModel() throws {
        let config = try config(hidden: #"["mine"]"#, order: "[]")
        XCTAssertTrue(
            ModelOptions.build(config: config, fallbackSelection: nil).map(\.key)
                .contains("opencode:mine")
        )
    }

    func testAppliesOrderingAndLeavesUnorderedModelsBehindIt() throws {
        let config = try config(hidden: "[]", order: #"["mine", "beta"]"#)
        XCTAssertEqual(
            ModelOptions.build(config: config, fallbackSelection: nil).map(\.key),
            ["opencode:mine", "opencode:beta", "opencode:alpha"]
        )
    }

    func testAServerWithoutThePreferenceLeavesTheCatalogIntact() throws {
        let config = try JSONDecoder.t3.decode(
            ServerConfigSnapshot.self,
            from: Data(
                #"""
                {
                  "providers": [{
                    "instanceId": "opencode",
                    "driver": "opencode",
                    "enabled": true,
                    "installed": true,
                    "status": "ready",
                    "auth": { "status": "authenticated" },
                    "checkedAt": "2026-08-02T12:00:00.000Z",
                    "models": [{ "slug": "alpha", "name": "Alpha", "isCustom": false }]
                  }]
                }
                """#.utf8
            )
        )
        XCTAssertEqual(
            ModelOptions.build(config: config, fallbackSelection: nil).map(\.key),
            ["opencode:alpha"]
        )
    }
}
