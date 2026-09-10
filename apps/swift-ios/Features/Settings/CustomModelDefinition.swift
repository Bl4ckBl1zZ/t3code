import Foundation

struct NativeCustomModelDefinition: Identifiable, Equatable {
    var id: String { slug }
    var slug: String
    var name: String
    var capabilities: ServerModelCapabilities?
    var original: JSONValue?

    static func read(_ value: JSONValue) -> Self? {
        let slug = (value.stringValue ?? value["slug"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !slug.isEmpty else { return nil }
        let label = value["name"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        return Self(slug: slug, name: label?.isEmpty == false ? label! : slug,
                    capabilities: try? value["capabilities"]?.decode(ServerModelCapabilities.self), original: value)
    }

    static func readEntries(_ values: [JSONValue]) -> [Self] {
        var seen = Set<String>()
        return values.compactMap { value in
            guard let entry = read(value), seen.insert(entry.slug).inserted else { return nil }
            return entry
        }
    }

    var json: JSONValue {
        var fields: [String: JSONValue] = [:]
        if case let .object(existing) = original { fields = existing }
        fields["slug"] = .string(slug)
        fields["name"] = name == slug ? nil : .string(name)
        fields["capabilities"] = capabilities?.optionDescriptors?.isEmpty == false ? try? .encode(capabilities) : nil
        return fields.count == 1 ? .string(slug) : .object(fields)
    }
}

/// Only the edited account's custom-model array changes. Unknown envelopes and entries survive.
enum NativeCustomModelSettings {
    static func entries(settings: ServerSettingsSnapshot, instanceID: String, driver: String) -> [JSONValue] {
        if case let .array(entries) = settings.providerInstances[instanceID]?["config"]?["customModels"] { return entries }
        if instanceID == driver, case let .array(entries) = settings.providerDefinitions[driver]?["customModels"] { return entries }
        return []
    }

    static func patch(settings: ServerSettingsSnapshot, instanceID: String, driver: String,
                      entries: [JSONValue]) throws -> ServerSettingsPatchInput {
        if let instance = settings.providerInstances[instanceID] {
            guard case var .object(envelope) = instance else { throw CustomModelEditError.invalidAccount }
            var config: [String: JSONValue] = [:]
            if let value = envelope["config"], value != .null {
                guard case let .object(existing) = value else { throw CustomModelEditError.invalidAccount }
                config = existing
            }
            config["customModels"] = .array(entries)
            envelope["config"] = .object(config)
            var instances = settings.providerInstances
            instances[instanceID] = .object(envelope)
            return ServerSettingsPatchInput(providerInstances: instances)
        }
        guard instanceID == driver, settings.providerDefinitions[driver] != nil else { throw CustomModelEditError.invalidAccount }
        return ServerSettingsPatchInput(customModelsByDriver: [driver: entries])
    }
}

enum CustomModelEditError: LocalizedError {
    case invalidAccount, duplicate, invalidDraft(String)
    var errorDescription: String? {
        switch self {
        case .invalidAccount: "This account's settings are unavailable. Refresh its configuration before editing."
        case .duplicate: "That model ID already exists."
        case .invalidDraft(let message): message
        }
    }
}

struct NativeCustomModelChoice: Identifiable, Equatable {
    var id = UUID()
    var value = ""
    var label = ""
    var isDefault = false
    var description: String?
}

struct NativeCustomModelOption: Identifiable, Equatable {
    var id = UUID()
    var kind = "select"
    var optionID = ""
    var label = ""
    var choices: [NativeCustomModelChoice] = []
    var currentBooleanValue: Bool?
    var description: String?
}

struct NativeCustomModelDraft: Equatable {
    var slug = ""
    var name = ""
    var options: [NativeCustomModelOption] = []
    var original: JSONValue?

    init(definition: NativeCustomModelDefinition? = nil) {
        guard let definition else { return }
        slug = definition.slug
        name = definition.name == definition.slug ? "" : definition.name
        original = definition.original
        options = Self.options(from: definition.capabilities)
    }

    static func options(from capabilities: ServerModelCapabilities?, driver: String? = nil) -> [NativeCustomModelOption] {
        (capabilities?.optionDescriptors ?? []).compactMap { descriptor in
            switch descriptor {
            case .boolean(let value):
                return NativeCustomModelOption(kind: "boolean", optionID: value.id, label: value.label,
                                               currentBooleanValue: value.currentValue, description: value.description)
            case .select(let value):
                if driver == "claudeAgent" && value.id == "contextWindow" { return nil }
                let choices = value.options.filter { !(value.promptInjectedValues ?? []).contains($0.id) }
                let selected = choices.first { $0.id == value.currentValue } ?? choices.first { $0.isDefault == true }
                return NativeCustomModelOption(optionID: value.id, label: value.label,
                    choices: choices.map { NativeCustomModelChoice(value: $0.id, label: $0.label, isDefault: $0.id == selected?.id, description: $0.description) },
                    description: value.description)
            }
        }
    }

    static func presets(driver: String) -> [NativeCustomModelOption] {
        func choices(_ values: [(String, String)], defaultValue: String) -> [NativeCustomModelChoice] {
            values.map { NativeCustomModelChoice(value: $0.0, label: $0.1, isDefault: $0.0 == defaultValue) }
        }
        let effort = choices([("low", "Low"), ("medium", "Medium"), ("high", "High"), ("xhigh", "Extra High")], defaultValue: "medium")
        let fast = NativeCustomModelOption(kind: "boolean", optionID: "fastMode", label: "Fast Mode")
        let thinking = NativeCustomModelOption(kind: "boolean", optionID: "thinking", label: "Thinking")
        switch driver {
        case "codex": return [
            NativeCustomModelOption(optionID: "reasoningEffort", label: "Reasoning", choices: effort),
            NativeCustomModelOption(optionID: "serviceTier", label: "Speed", choices: choices([("default", "Standard"), ("fast", "Fast")], defaultValue: "default"))
        ]
        case "claudeAgent": return [
            NativeCustomModelOption(optionID: "effort", label: "Reasoning", choices: choices([("low", "Low"), ("medium", "Medium"), ("high", "High"), ("xhigh", "Extra High"), ("max", "Max")], defaultValue: "high")), fast, thinking
        ]
        case "cursor": return [NativeCustomModelOption(optionID: "reasoning", label: "Reasoning", choices: effort), fast, thinking]
        case "grok": return [NativeCustomModelOption(optionID: "reasoningEffort", label: "Reasoning", choices: effort)]
        case "opencode": return [NativeCustomModelOption(optionID: "variant", label: "Reasoning", choices: effort),
            NativeCustomModelOption(optionID: "agent", label: "Agent", choices: choices([("build", "Build"), ("plan", "Plan")], defaultValue: "build"))]
        default: return []
        }
    }

    func definition() throws -> NativeCustomModelDefinition {
        let slug = slug.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !slug.isEmpty, slug.utf16.count <= 256 else { throw CustomModelEditError.invalidDraft("Enter a model ID of 1–256 characters.") }
        var ids = Set<String>()
        let descriptors: [ServerProviderOptionDescriptor] = try options.enumerated().map { index, option in
            let id = option.optionID.trimmingCharacters(in: .whitespacesAndNewlines)
            let label = option.label.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, !label.isEmpty, ids.insert(id).inserted else { throw CustomModelEditError.invalidDraft("Option \(index + 1) needs a unique ID and a label.") }
            if option.kind == "boolean" {
                return .boolean(ServerBooleanOptionDescriptor(id: id, label: label, description: option.description, currentValue: option.currentBooleanValue))
            }
            guard !option.choices.isEmpty else { throw CustomModelEditError.invalidDraft("Option \(index + 1) needs at least one choice.") }
            var choiceIDs = Set<String>()
            let choices: [ServerProviderOptionChoice] = try option.choices.map { choice in
                let value = choice.value.trimmingCharacters(in: .whitespacesAndNewlines)
                let choiceLabel = choice.label.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !value.isEmpty, choiceIDs.insert(value).inserted else { throw CustomModelEditError.invalidDraft("Choice values must be non-empty and unique within each option.") }
                return ServerProviderOptionChoice(id: value, label: choiceLabel.isEmpty ? value : choiceLabel, description: choice.description, isDefault: choice.isDefault ? true : nil)
            }
            guard choices.filter({ $0.isDefault == true }).count <= 1 else { throw CustomModelEditError.invalidDraft("Choose only one default per option.") }
            return .select(ServerSelectOptionDescriptor(id: id, label: label, description: option.description, options: choices,
                currentValue: choices.first { $0.isDefault == true }?.id, promptInjectedValues: nil))
        }
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return NativeCustomModelDefinition(slug: slug, name: name.isEmpty ? slug : name,
            capabilities: descriptors.isEmpty ? nil : ServerModelCapabilities(optionDescriptors: descriptors), original: original)
    }
}
