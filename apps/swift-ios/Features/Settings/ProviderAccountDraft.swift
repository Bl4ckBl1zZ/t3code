import Foundation

/// Generated from the same schema annotations used by the web account form.
struct NativeProviderSettingsDefinition: Decodable, Identifiable, Sendable {
    let driver: String
    let label: String
    let hasDefaultInstance: Bool
    let defaultInstance: JSONValue?
    let badgeLabel: String?
    let environmentFields: [EnvironmentField]
    let fields: [Field]
    var id: String { driver }
    struct Field: Decodable, Identifiable, Sendable {
        let key: String
        let control: String
        let label: String
        let description: String?
        let placeholder: String?
        let clearWhenEmpty: String
        let defaultBooleanValue: Bool?
        var options: [Choice]? = nil
        struct Choice: Decodable, Sendable { let value: String; let label: String }
        var id: String { key }
    }
    struct EnvironmentField: Decodable, Identifiable, Sendable {
        let name: String
        let label: String
        let description: String?
        let placeholder: String?
        let sensitive: Bool?
        var id: String { name }
    }
    static let catalog: [Self] = {
        guard let url = Bundle.main.url(forResource: "ProviderSettingsCatalog", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let definitions = try? JSONDecoder().decode([Self].self, from: data) else { return [] }
        return definitions
    }()
}

enum ProviderAccountEditError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case let .invalid(message) = self { message } else { nil } }
}

struct NativeProviderAccountDraft: Equatable {
    let driver: String
    let original: [String: JSONValue]?
    var instanceID: String
    var envelope: [String: JSONValue]

    init(driver: String, instanceID: String = "", original: [String: JSONValue]? = nil) {
        self.driver = driver
        self.instanceID = instanceID
        self.original = original
        self.envelope = original ?? ["driver": .string(driver), "enabled": .bool(true)]
    }
    var isNew: Bool { original == nil }
    var canRemove: Bool { !isNew && instanceID != driver }
    var name: String {
        get { envelope["displayName"]?.stringValue ?? "" }
        set { setOptionalText("displayName", newValue) }
    }
    var accent: String {
        get { envelope["accentColor"]?.stringValue ?? "" }
        set { setOptionalText("accentColor", newValue) }
    }
    var enabled: Bool {
        get {
            if case let .bool(value) = envelope["enabled"] { return value }
            if case let .bool(value) = envelope["config"]?["enabled"] { return value }
            return true
        }
        set { envelope["enabled"] = .bool(newValue) }
    }
    var config: [String: JSONValue] {
        if case let .object(value) = envelope["config"] { return value }
        return [:]
    }
    var environment: [JSONValue] {
        get { if case let .array(value) = envelope["environment"] { return value }; return [] }
        set { envelope["environment"] = newValue.isEmpty ? nil : .array(newValue) }
    }
    mutating func setOptionalText(_ key: String, _ text: String) {
        envelope[key] = .string(text)
    }
    mutating func setField(_ field: NativeProviderSettingsDefinition.Field, value: JSONValue) {
        var next = config
        let empty: Bool
        switch value {
        case .string(let text): empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .bool(let flag): empty = flag == (field.defaultBooleanValue ?? false)
        default: empty = false
        }
        next[field.key] = empty && field.clearWhenEmpty == "omit" ? nil : value
        envelope["config"] = next.isEmpty ? nil : .object(next)
    }
    mutating func updateVariable(_ index: Int, key: String, value: JSONValue) {
        var rows = environment
        guard rows.indices.contains(index), case var .object(row) = rows[index] else { return }
        // A redacted credential is tied to its name. It cannot be moved or
        // exposed as plaintext without supplying the replacement value.
        if row["valueRedacted"] == .bool(true), key == "name" || key == "sensitive" { return }
        row[key] = value
        if key == "value" { row["valueRedacted"] = .bool(false) }
        rows[index] = .object(row)
        environment = rows
    }
    mutating func addVariable(name: String = "", sensitive: Bool = false) {
        environment.append(.object(["name": .string(name), "value": .string(""), "sensitive": .bool(sensitive)]))
    }

    static func resolve(instanceID: String, driver: String, instances: [String: JSONValue],
                        legacy: [String: JSONValue], definition: NativeProviderSettingsDefinition?) throws -> [String: JSONValue] {
        if let value = instances[instanceID] {
            guard case let .object(envelope) = value, envelope["driver"] == .string(driver) else {
                throw ProviderAccountEditError.invalid("This account changed provider. Reopen its settings.")
            }
            return envelope
        }
        guard instanceID == driver, definition?.hasDefaultInstance == true else {
            throw ProviderAccountEditError.invalid("This account was removed. Reopen the account list.")
        }
        if let config = legacy[driver] { return ["driver": .string(driver), "config": config] }
        if case let .object(value) = definition?.defaultInstance { return value }
        throw ProviderAccountEditError.invalid("The server has not supplied settings for this account.")
    }

    /// Rebase only edited leaves on the latest server answer. Detect edits to
    /// the same field instead of overwriting another client's changes.
    func merging(into instances: [String: JSONValue], latest: [String: JSONValue]?) throws -> [String: JSONValue] {
        guard instanceID.range(of: "^[A-Za-z][A-Za-z0-9_-]{0,63}$", options: .regularExpression) != nil else {
            throw ProviderAccountEditError.invalid("Use an account ID of 1–64 letters, numbers, underscores or hyphens, starting with a letter.")
        }
        let normalizedAccent = accent.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalizedAccent.isEmpty, normalizedAccent.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) == nil {
            throw ProviderAccountEditError.invalid("Use a six-digit hex color such as #4F7AFF, or leave it empty.")
        }
        var names = Set<String>()
        for row in environment {
            let name = row["name"]?.stringValue ?? ""
            guard name.range(of: "^[A-Za-z_][A-Za-z0-9_]{0,127}$", options: .regularExpression) != nil, names.insert(name).inserted else {
                throw ProviderAccountEditError.invalid("Environment variable names must be unique and contain only letters, numbers and underscores, starting with a letter or underscore.")
            }
        }
        var edited = envelope
        for key in ["displayName", "accentColor"] {
            if let text = edited[key]?.stringValue {
                let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
                edited[key] = normalized.isEmpty ? nil : .string(normalized)
            }
        }
        var result = instances
        if isNew {
            guard instances[instanceID] == nil, latest == nil else { throw ProviderAccountEditError.invalid("That account ID already exists.") }
            result[instanceID] = .object(edited)
            return result
        }
        guard let original, let latest, latest["driver"] == .string(driver) else {
            throw ProviderAccountEditError.invalid("This account is no longer available. Reopen its settings.")
        }
        var merged = latest
        for key in Set(original.keys).union(edited.keys) where key != "config" && original[key] != edited[key] {
            guard latest[key] == original[key] || latest[key] == edited[key] else { throw conflict(key) }
            merged[key] = edited[key]
        }
        if original["config"] != envelope["config"] {
            guard original["config"] == nil || original["config"] == .null || isObject(original["config"]) else { throw conflict("configuration") }
            guard latest["config"] == nil || latest["config"] == .null || isObject(latest["config"]) else { throw conflict("configuration") }
            let before = object(original["config"]), after = config
            var current = object(latest["config"])
            for key in Set(before.keys).union(after.keys) where before[key] != after[key] {
                guard current[key] == before[key] || current[key] == after[key] else { throw conflict(key) }
                current[key] = after[key]
            }
            merged["config"] = current.isEmpty ? nil : .object(current)
        }
        result[instanceID] = .object(merged)
        return result
    }
    private func conflict(_ field: String) -> ProviderAccountEditError {
        .invalid("\(field) changed on another client. Reopen these settings before saving.")
    }
    private func object(_ value: JSONValue?) -> [String: JSONValue] { if case let .object(value) = value { value } else { [:] } }
    private func isObject(_ value: JSONValue?) -> Bool { if case .object = value { true } else { false } }
}
