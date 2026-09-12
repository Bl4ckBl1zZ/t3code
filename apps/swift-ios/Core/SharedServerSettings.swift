import Foundation

public struct SourceControlWritingStyle: Codable, Equatable, Sendable {
    public var mode: String
    public var customInstructions: String
    public var followChangeRequestTemplates: Bool
    public init(mode: String = "repo_conventions", customInstructions: String = "", followChangeRequestTemplates: Bool = true) {
        self.mode = mode; self.customInstructions = customInstructions
        self.followChangeRequestTemplates = followChangeRequestTemplates
    }
    var json: JSONValue { .object([
        "mode": .string(mode), "customInstructions": .string(customInstructions),
        "followChangeRequestTemplates": .bool(followChangeRequestTemplates),
    ]) }
}

public struct SourceControlWritingStylePatch: Equatable, Sendable {
    public var mode: String?
    public var customInstructions: String?
    public var followChangeRequestTemplates: Bool?
    public init(mode: String? = nil, customInstructions: String? = nil, followChangeRequestTemplates: Bool? = nil) {
        self.mode = mode; self.customInstructions = customInstructions
        self.followChangeRequestTemplates = followChangeRequestTemplates
    }
    init(_ value: SourceControlWritingStyle) {
        self.init(mode: value.mode, customInstructions: value.customInstructions, followChangeRequestTemplates: value.followChangeRequestTemplates)
    }
    var json: JSONValue {
        var fields: [String: JSONValue] = [:]
        if let mode { fields["mode"] = .string(mode) }
        if let customInstructions { fields["customInstructions"] = .string(customInstructions) }
        if let followChangeRequestTemplates { fields["followChangeRequestTemplates"] = .bool(followChangeRequestTemplates) }
        return .object(fields)
    }
}

extension ModelSelection {
    var settingsJSON: JSONValue {
        var fields: [String: JSONValue] = ["instanceId": .string(instanceId), "model": .string(model)]
        if let options { fields["options"] = .array(options.map { .object(["id": .string($0.id), "value": $0.value]) }) }
        return .object(fields)
    }
}

/// Matches client-runtime's shared preference whitelist. Account, project and machine config stay local.
enum SharedServerSettings {
    static func pick(_ settings: ServerSettingsSnapshot, restartSupported: Bool) -> ServerSettingsPatchInput {
        .init(sidebarAutoSettleAfterDays: .some(settings.sidebarAutoSettleAfterDays),
              continueThreadsAfterServerUpdate: restartSupported ? settings.continueThreadsAfterServerUpdate : nil,
              sidebarAutoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
              textGenerationModelSelection: settings.textGenerationModelSelection,
              sourceControlWritingStyle: settings.sourceControlWritingStyle.map { SourceControlWritingStylePatch($0) },
              newWorktreesStartFromOrigin: settings.newWorktreesStartFromOrigin)
    }
    static func split(_ patch: ServerSettingsPatchInput) -> (shared: ServerSettingsPatchInput, local: ServerSettingsPatchInput) {
        let shared = ServerSettingsPatchInput(
            sidebarAutoSettleAfterDays: patch.sidebarAutoSettleAfterDays,
            continueThreadsAfterServerUpdate: patch.continueThreadsAfterServerUpdate,
            sidebarAutoSettleOnMerge: patch.sidebarAutoSettleOnMerge,
            textGenerationModelSelection: patch.textGenerationModelSelection,
            sourceControlWritingStyle: patch.sourceControlWritingStyle,
            newWorktreesStartFromOrigin: patch.newWorktreesStartFromOrigin)
        var local = patch
        local.sidebarAutoSettleAfterDays = nil; local.continueThreadsAfterServerUpdate = nil
        local.sidebarAutoSettleOnMerge = nil; local.textGenerationModelSelection = nil
        local.sourceControlWritingStyle = nil; local.newWorktreesStartFromOrigin = nil
        return (shared, local)
    }
    static func filter(_ patch: ServerSettingsPatchInput, restartSupported: Bool,
                       target: ServerSettingsSnapshot, source: ServerSettingsSnapshot?, targetIsSource: Bool = false) -> ServerSettingsPatchInput {
        var result = patch
        if !restartSupported { result.continueThreadsAfterServerUpdate = nil }
        if !targetIsSource, let selection = patch.textGenerationModelSelection {
            func provider(_ settings: ServerSettingsSnapshot?, _ instance: String) -> (driver: String, enabled: Bool)? {
                guard let settings else { return nil }
                if case let .object(config)? = settings.providerInstances[instance] {
                    let driver: String
                    if case let .string(value)? = config["driver"] { driver = value } else { driver = instance }
                    return (driver, config["enabled"] != .bool(false))
                }
                if case let .object(config)? = settings.providerDefinitions[instance], config["enabled"] == .bool(true) {
                    return (instance, true)
                }
                return nil
            }
            let from = provider(source, selection.instanceId)
            let to = provider(target, selection.instanceId)
            if to?.enabled != true || from?.driver != to?.driver { result.textGenerationModelSelection = nil }
        }
        return result
    }
    static func differs(source: ServerSettingsSnapshot, sourceRestart: Bool,
                        target: ServerSettingsSnapshot, targetRestart: Bool) -> Bool {
        let expected = filter(pick(source, restartSupported: sourceRestart), restartSupported: targetRestart, target: target, source: source)
        var actual = pick(target, restartSupported: sourceRestart && targetRestart)
        if expected.textGenerationModelSelection == nil { actual.textGenerationModelSelection = nil }
        if expected.sourceControlWritingStyle == nil { actual.sourceControlWritingStyle = nil }
        return expected != actual
    }
    static func isEmpty(_ patch: ServerSettingsPatchInput) -> Bool {
        if case let .object(fields) = patch.json { return fields.isEmpty }
        return true
    }
}
