import Foundation

// Ported from packages/contracts/src/voice.ts and the relay calls
// apps/mobile/src/features/voice/mobileVoiceApi.ts makes against it. The native
// client has no voice transport yet, so the screens in this folder talk to the
// protocol below and an adapter conforms to it once the RPCs land.

public enum OpenRouterIntegrationState: String, Sendable, Equatable, Codable {
    case notConfigured = "not_configured"
    case validating
    case connected
    case invalid
    case unavailable
}

public struct OpenRouterIntegrationStatus: Sendable, Equatable, Codable {
    public var configured: Bool
    /// A masked tail of the stored key. Full keys are never returned.
    public var credentialHint: String?
    public var state: OpenRouterIntegrationState
    /// ISO-8601 instant, echoed rather than reformatted on the wire.
    public var lastValidatedAt: String?
    public var errorCode: String?

    public init(
        configured: Bool = false,
        credentialHint: String? = nil,
        state: OpenRouterIntegrationState = .notConfigured,
        lastValidatedAt: String? = nil,
        errorCode: String? = nil
    ) {
        self.configured = configured
        self.credentialHint = credentialHint
        self.state = state
        self.lastValidatedAt = lastValidatedAt
        self.errorCode = errorCode
    }

    public var isConnected: Bool { state == .connected }
}

public struct OpenRouterModelOption: Identifiable, Sendable, Equatable, Codable {
    public let id: String
    public var name: String
    public var providerName: String
    /// A model the account cannot currently call still lists, so a selection
    /// made on another client stays visible instead of silently disappearing.
    public var available: Bool

    public init(id: String, name: String, providerName: String, available: Bool = true) {
        self.id = id
        self.name = name
        self.providerName = providerName
        self.available = available
    }

    public var subtitle: String {
        available ? providerName : "\(providerName) · Unavailable"
    }
}

public struct VoiceInputSettings: Sendable, Equatable, Codable {
    public static let maximumDictionaryEntries = 250
    public static let maximumDictionaryEntryLength = 80
    public static let defaultModel = "google/gemini-2.5-flash"

    public var model: String
    /// `nil` asks the transcriber to detect the spoken language.
    public var language: String?
    public var cleanupEnabled: Bool
    public var dictionary: [String]

    public init(
        model: String = VoiceInputSettings.defaultModel,
        language: String? = nil,
        cleanupEnabled: Bool = true,
        dictionary: [String] = []
    ) {
        self.model = model
        self.language = language
        self.cleanupEnabled = cleanupEnabled
        self.dictionary = dictionary
    }
}

/// Every field is optional: a patch only carries what the user just changed, so
/// two screens editing different fields cannot overwrite each other.
public struct VoiceInputSettingsPatch: Sendable, Equatable {
    /// `language` has three states on the wire — absent, explicit, and null for
    /// automatic detection — which an `Optional<String>` alone cannot express.
    public enum Language: Sendable, Equatable {
        case automatic
        case explicit(String)
    }

    public var model: String?
    public var language: Language?
    public var cleanupEnabled: Bool?
    public var dictionary: [String]?

    public init(
        model: String? = nil,
        language: Language? = nil,
        cleanupEnabled: Bool? = nil,
        dictionary: [String]? = nil
    ) {
        self.model = model
        self.language = language
        self.cleanupEnabled = cleanupEnabled
        self.dictionary = dictionary
    }
}

/// The voice/OpenRouter surface a client can opt into. Optional in the same way
/// as `FeatureDeviceManaging`: an environment without the relay capability keeps
/// working, its Voice Input screen just reports the integration as unavailable.
@MainActor
public protocol FeatureVoiceSettingsManaging: AnyObject {
    func openRouterIntegration() async throws -> OpenRouterIntegrationStatus
    func putOpenRouterCredential(apiKey: String) async throws -> OpenRouterIntegrationStatus
    func validateOpenRouterCredential() async throws -> OpenRouterIntegrationStatus
    func deleteOpenRouterCredential() async throws -> OpenRouterIntegrationStatus

    func voiceInputSettings() async throws -> VoiceInputSettings
    func patchVoiceInputSettings(
        _ patch: VoiceInputSettingsPatch
    ) async throws -> VoiceInputSettings

    /// Audio-capable models only. The catalog runs to dozens of entries, which
    /// is why the picker is its own searchable screen.
    func listOpenRouterAudioModels() async throws -> [OpenRouterModelOption]
}

/// Stand-in for clients that do not implement the capability. Reads report the
/// integration as unavailable rather than throwing, so the screens render their
/// disconnected state instead of an error; writes throw, because a silently
/// dropped write would look like a save that stuck.
@MainActor
final class EmptyFeatureVoiceSettingsManager: FeatureVoiceSettingsManaging {
    static let shared = EmptyFeatureVoiceSettingsManager()

    private init() {}

    func openRouterIntegration() async throws -> OpenRouterIntegrationStatus {
        OpenRouterIntegrationStatus(state: .unavailable)
    }

    func putOpenRouterCredential(apiKey _: String) async throws -> OpenRouterIntegrationStatus {
        throw FeatureCapabilityUnavailable("Voice Input")
    }

    func validateOpenRouterCredential() async throws -> OpenRouterIntegrationStatus {
        throw FeatureCapabilityUnavailable("Voice Input")
    }

    func deleteOpenRouterCredential() async throws -> OpenRouterIntegrationStatus {
        throw FeatureCapabilityUnavailable("Voice Input")
    }

    func voiceInputSettings() async throws -> VoiceInputSettings {
        VoiceInputSettings()
    }

    func patchVoiceInputSettings(
        _: VoiceInputSettingsPatch
    ) async throws -> VoiceInputSettings {
        throw FeatureCapabilityUnavailable("Voice Input")
    }

    func listOpenRouterAudioModels() async throws -> [OpenRouterModelOption] {
        []
    }
}

// MARK: - Presentation

public enum VoiceIntegrationLabels {
    /// Ported from `label()` in SettingsIntegrationsRouteScreen.tsx. `isLoaded`
    /// distinguishes "still asking" from "asked and got nothing", which is the
    /// only way a failed status request is visible to the reader.
    public static func connection(
        _ status: OpenRouterIntegrationStatus?,
        isLoaded: Bool
    ) -> String {
        guard isLoaded else { return "Checking" }
        guard let status else { return "Unavailable" }
        switch status.state {
        case .connected: return "Connected"
        case .validating: return "Validating"
        case .invalid: return "Error"
        case .notConfigured, .unavailable:
            return status.configured ? "Unavailable" : "Not configured"
        }
    }

    /// `nil` for an absent or unparseable instant so the caller drops the line
    /// entirely rather than printing a placeholder date.
    public static func validatedAt(_ isoDate: String?, locale: Locale = .autoupdatingCurrent) -> String? {
        guard let isoDate, let date = parse(isoDate) else { return nil }
        return date.formatted(
            Date.FormatStyle(date: .abbreviated, time: .shortened, locale: locale)
        )
    }

    private static func parse(_ value: String) -> Date? {
        fractionalFormatter.date(from: value) ?? plainFormatter.date(from: value)
    }

    private static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plainFormatter = ISO8601DateFormatter()
}

/// The personal dictionary is edited as free text and stored as entries, so the
/// two directions have to agree or a no-op edit would look like a change.
public enum VoiceInputDictionary {
    public static func entries(from text: String) -> [String] {
        let lines = text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return Array(lines.prefix(VoiceInputSettings.maximumDictionaryEntries))
    }

    public static func text(for entries: [String]) -> String {
        entries.joined(separator: "\n")
    }

    /// True when committing `text` would actually change the stored entries.
    /// Compared entry-wise rather than as raw text so blank lines and trailing
    /// spaces do not trigger a pointless write.
    public static func changes(_ text: String, from entries: [String]) -> Bool {
        self.entries(from: text) != entries
    }
}

public enum VoiceModelCatalog {
    /// Ported from the `filtered` memo in SettingsVoiceModelRouteScreen.tsx: an
    /// empty needle keeps the catalog order the server chose.
    public static func filter(
        _ models: [OpenRouterModelOption],
        query: String
    ) -> [OpenRouterModelOption] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return models }
        return models.filter { model in
            model.name.lowercased().contains(needle)
                || model.id.lowercased().contains(needle)
                || model.providerName.lowercased().contains(needle)
        }
    }

    /// The label the Voice Input screen shows for the chosen model. A model the
    /// catalog no longer lists still reads as its raw id rather than as blank.
    public static func displayName(
        for modelID: String,
        in models: [OpenRouterModelOption]
    ) -> String {
        models.first { $0.id == modelID }?.name ?? modelID
    }
}
