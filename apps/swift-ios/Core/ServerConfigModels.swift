import Foundation

public struct ServerProviderAuthSnapshot: Codable, Equatable, Sendable {
    public let status: String
    public let type: String?
    public let label: String?
    public let email: String?
}

public struct ServerProviderOptionChoice: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let description: String?
    public let isDefault: Bool?
}

public struct ServerSelectOptionDescriptor: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let description: String?
    public let options: [ServerProviderOptionChoice]
    public let currentValue: String?
    public let promptInjectedValues: [String]?
}

public struct ServerBooleanOptionDescriptor: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let description: String?
    public let currentValue: Bool?
}

public enum ServerProviderOptionDescriptor: Codable, Equatable, Sendable {
    case select(ServerSelectOptionDescriptor)
    case boolean(ServerBooleanOptionDescriptor)

    private enum CodingKeys: String, CodingKey { case type }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "select":
            self = .select(try ServerSelectOptionDescriptor(from: decoder))
        case "boolean":
            self = .boolean(try ServerBooleanOptionDescriptor(from: decoder))
        case let type:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown provider option type \(type)"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case let .select(value):
            try value.encode(to: encoder)
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("select", forKey: .type)
        case let .boolean(value):
            try value.encode(to: encoder)
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("boolean", forKey: .type)
        }
    }
}

public struct ServerModelCapabilities: Codable, Equatable, Sendable {
    public let optionDescriptors: [ServerProviderOptionDescriptor]?
}

public struct ServerProviderModelSnapshot: Codable, Identifiable, Equatable, Sendable {
    public var id: String { slug }

    public let slug: String
    public let name: String
    public let shortName: String?
    public let subProvider: String?
    public let isCustom: Bool
    public let isDefault: Bool?
    public let isLegacy: Bool?
    public let capabilities: ServerModelCapabilities?
}

public struct ServerProviderSlashCommandSnapshot: Codable, Equatable, Sendable {
    public struct Input: Codable, Equatable, Sendable {
        public let hint: String
    }

    public let name: String
    public let description: String?
    public let input: Input?
}

public struct ServerProviderSkillSnapshot: Codable, Equatable, Sendable {
    public let name: String
    public let description: String?
    public let path: String
    public let scope: String?
    public let enabled: Bool
    public let displayName: String?
    public let shortDescription: String?
}

public struct ServerProviderSnapshot: Codable, Identifiable, Equatable, Sendable {
    public var id: String { instanceId }

    public let instanceId: String
    public let driver: String
    public let displayName: String?
    public let accentColor: String?
    public let badgeLabel: String?
    public let showInteractionModeToggle: Bool?
    public let requiresNewThreadForModelChange: Bool?
    public let enabled: Bool
    public let installed: Bool
    public let version: String?
    public let status: String
    public let auth: ServerProviderAuthSnapshot
    public let checkedAt: String
    public let message: String?
    public let availability: String?
    public let unavailableReason: String?
    public let models: [ServerProviderModelSnapshot]
    public let slashCommands: [ServerProviderSlashCommandSnapshot]?
    public let skills: [ServerProviderSkillSnapshot]?
}

public enum ServerThreadEnvironmentMode: String, Codable, Equatable, Sendable {
    case local
    case worktree
}

/// Per-provider-instance model visibility and ordering, mirroring
/// `ProviderModelPreferences` in `packages/contracts`.
///
/// The server keeps sending the full provider catalog; this is what narrows it
/// to the models the user actually wants to see. Without it the native pickers
/// list every model the driver reports, ignoring the hides configured on
/// desktop or web.
public struct ProviderModelPreferencesSnapshot: Codable, Equatable, Sendable {
    public let hiddenModels: [String]
    /// Explicit user ordering; slugs absent from it keep their catalog order
    /// behind the ones listed here.
    public let modelOrder: [String]

    public init(hiddenModels: [String] = [], modelOrder: [String] = []) {
        self.hiddenModels = hiddenModels
        self.modelOrder = modelOrder
    }

    private enum CodingKeys: String, CodingKey {
        case hiddenModels
        case modelOrder
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hiddenModels = try container.decodeIfPresent([String].self, forKey: .hiddenModels) ?? []
        modelOrder = try container.decodeIfPresent([String].self, forKey: .modelOrder) ?? []
    }

    /// Drops hidden models and applies the user's ordering, mirroring
    /// `applyInstanceModelPreferences` in `apps/web/src/modelSelection.ts`.
    ///
    /// Custom models are deliberately never hidden: the web settings editor
    /// omits the hide toggle for them, so a slug the user typed by hand can
    /// only be removed by deleting it, not by a stale hide entry.
    public func apply(
        to models: [ServerProviderModelSnapshot]
    ) -> [ServerProviderModelSnapshot] {
        let hidden = Set(hiddenModels)
        let visible = models.filter { $0.isCustom || !hidden.contains($0.slug) }

        guard !modelOrder.isEmpty else { return visible }

        // Slugs the user ordered come first in that order; everything else
        // keeps its catalog position behind them. `enumerated` supplies the
        // tiebreak that makes this a stable sort.
        var rankBySlug: [String: Int] = [:]
        for (index, slug) in modelOrder.enumerated() where rankBySlug[slug] == nil {
            rankBySlug[slug] = index
        }
        return visible.enumerated()
            .sorted { lhs, rhs in
                let lhsRank = rankBySlug[lhs.element.slug] ?? Int.max
                let rhsRank = rankBySlug[rhs.element.slug] ?? Int.max
                if lhsRank != rhsRank { return lhsRank < rhsRank }
                return lhs.offset < rhs.offset
            }
            .map(\.element)
    }
}

/// New-thread preferences are server-authoritative, so every saved environment
/// can resolve these differently even though they share one mobile client.
public struct ServerSettingsSnapshot: Codable, Equatable, Sendable {
    /// The default window matching `DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS` in
    /// `packages/contracts`, applied when a server predates the setting.
    public static let defaultSidebarAutoSettleAfterDays: Double = 3
    /// Matches `sidebarAutoSettleOnMerge`'s decoding default in
    /// `packages/contracts`, applied when a server predates the setting.
    public static let defaultSidebarAutoSettleOnMerge = true
    /// Matches `enableAgentBrowserAccess`'s decoding default in
    /// `packages/contracts`. A server that predates the setting grants access,
    /// which is what it did before the setting existed.
    public static let defaultEnableAgentBrowserAccess = true

    public let defaultThreadEnvMode: ServerThreadEnvironmentMode
    public let newWorktreesStartFromOrigin: Bool
    /// Days of inactivity before a thread auto-settles; `nil` is the user's
    /// explicit "never". A server that never sends the key gets the default
    /// instead, so absence and "never" stay distinguishable.
    public let sidebarAutoSettleAfterDays: Double?
    /// Whether a merged change request settles its thread on its own. A closed
    /// one always does; only the merge half is configurable.
    public let sidebarAutoSettleOnMerge: Bool
    /// Keyed by provider instance id (the default instance for a driver uses
    /// the driver kind, so `"hermes"`, `"codex"`, `"claudeAgent"`, …). Empty
    /// against a server that predates the setting being server-authoritative.
    public let providerModelPreferences: [String: ProviderModelPreferencesSnapshot]
    /// Whether agents on this server may drive the preview browser. Withheld
    /// access drops the `preview` capability from the MCP credential a provider
    /// session is given, so it is the server's answer and not this device's.
    public let enableAgentBrowserAccess: Bool

    public init(
        defaultThreadEnvMode: ServerThreadEnvironmentMode = .local,
        newWorktreesStartFromOrigin: Bool = true,
        sidebarAutoSettleAfterDays: Double? = ServerSettingsSnapshot
            .defaultSidebarAutoSettleAfterDays,
        sidebarAutoSettleOnMerge: Bool = ServerSettingsSnapshot
            .defaultSidebarAutoSettleOnMerge,
        providerModelPreferences: [String: ProviderModelPreferencesSnapshot] = [:],
        enableAgentBrowserAccess: Bool = ServerSettingsSnapshot
            .defaultEnableAgentBrowserAccess
    ) {
        self.defaultThreadEnvMode = defaultThreadEnvMode
        self.newWorktreesStartFromOrigin = newWorktreesStartFromOrigin
        self.sidebarAutoSettleAfterDays = sidebarAutoSettleAfterDays
        self.sidebarAutoSettleOnMerge = sidebarAutoSettleOnMerge
        self.providerModelPreferences = providerModelPreferences
        self.enableAgentBrowserAccess = enableAgentBrowserAccess
    }

    private enum CodingKeys: String, CodingKey {
        case defaultThreadEnvMode
        case newWorktreesStartFromOrigin
        case sidebarAutoSettleAfterDays
        case sidebarAutoSettleOnMerge
        case providerModelPreferences
        case enableAgentBrowserAccess
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        defaultThreadEnvMode = try container.decode(
            ServerThreadEnvironmentMode.self,
            forKey: .defaultThreadEnvMode
        )
        newWorktreesStartFromOrigin = try container.decode(
            Bool.self,
            forKey: .newWorktreesStartFromOrigin
        )
        sidebarAutoSettleAfterDays = container.contains(.sidebarAutoSettleAfterDays)
            ? try container.decodeIfPresent(Double.self, forKey: .sidebarAutoSettleAfterDays)
            : Self.defaultSidebarAutoSettleAfterDays
        sidebarAutoSettleOnMerge = try container.decodeIfPresent(
            Bool.self,
            forKey: .sidebarAutoSettleOnMerge
        ) ?? Self.defaultSidebarAutoSettleOnMerge
        providerModelPreferences = try container.decodeIfPresent(
            [String: ProviderModelPreferencesSnapshot].self,
            forKey: .providerModelPreferences
        ) ?? [:]
        enableAgentBrowserAccess = try container.decodeIfPresent(
            Bool.self,
            forKey: .enableAgentBrowserAccess
        ) ?? Self.defaultEnableAgentBrowserAccess
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(defaultThreadEnvMode, forKey: .defaultThreadEnvMode)
        try container.encode(newWorktreesStartFromOrigin, forKey: .newWorktreesStartFromOrigin)
        // Encoded as explicit null so "never" survives a round trip instead of
        // decoding back as the absent-key default.
        try container.encode(sidebarAutoSettleAfterDays, forKey: .sidebarAutoSettleAfterDays)
        try container.encode(sidebarAutoSettleOnMerge, forKey: .sidebarAutoSettleOnMerge)
        try container.encode(providerModelPreferences, forKey: .providerModelPreferences)
        try container.encode(enableAgentBrowserAccess, forKey: .enableAgentBrowserAccess)
    }
}

/// A sparse write to server-authoritative settings, matching
/// `ServerSettingsPatch` in `packages/contracts`.
///
/// Every field is optional and only the ones that were set are encoded: the
/// server deep-merges the patch, so sending a whole snapshot would overwrite
/// whatever another client changed in between. Add a field here — and one line
/// to `json` — as each new server setting reaches this client.
public struct ServerSettingsPatchInput: Equatable, Sendable {
    public var enableAgentBrowserAccess: Bool?

    public init(enableAgentBrowserAccess: Bool? = nil) {
        self.enableAgentBrowserAccess = enableAgentBrowserAccess
    }

    public var json: JSONValue {
        var fields: [String: JSONValue] = [:]
        if let enableAgentBrowserAccess {
            fields["enableAgentBrowserAccess"] = .bool(enableAgentBrowserAccess)
        }
        return .object(fields)
    }

    /// Nothing to send. Callers skip the round trip rather than asking the
    /// server to merge an empty object.
    public var isEmpty: Bool {
        json == .object([:])
    }
}

/// Narrow decode view of the much larger `ServerConfig` RPC result.
public struct ServerConfigSnapshot: Codable, Equatable, Sendable {
    public let providers: [ServerProviderSnapshot]
    public let settings: ServerSettingsSnapshot?
    /// The server's dedicated non-project workspace for projectless T3 Work
    /// conversations. Matching it against a project's `workspaceRoot` is what
    /// stops a Work launch attaching to an arbitrary project, so its absence
    /// has to be distinguishable from an empty path.
    public let t3WorkDirectory: String?
    /// Whether thread subscriptions honour `snapshotMaxVisibleItems` windowing.
    /// This fork's replacement for upstream's keyset `threadSnapshotPagination`.
    public let threadSnapshotWindow: Bool?
    /// Whether thread subscriptions can emit a catch-up completion marker.
    public let threadResumeCompletionMarker: Bool?
    /// Whether shell subscriptions can emit a catch-up completion marker.
    public let shellResumeCompletionMarker: Bool?

    public init(
        providers: [ServerProviderSnapshot],
        settings: ServerSettingsSnapshot? = nil,
        t3WorkDirectory: String? = nil,
        threadSnapshotWindow: Bool? = nil,
        threadResumeCompletionMarker: Bool? = nil,
        shellResumeCompletionMarker: Bool? = nil
    ) {
        self.providers = providers
        self.settings = settings
        self.t3WorkDirectory = t3WorkDirectory
        self.threadSnapshotWindow = threadSnapshotWindow
        self.threadResumeCompletionMarker = threadResumeCompletionMarker
        self.shellResumeCompletionMarker = shellResumeCompletionMarker
    }

    private enum CodingKeys: String, CodingKey {
        case providers, settings, t3WorkDirectory
        case threadSnapshotWindow, threadResumeCompletionMarker, shellResumeCompletionMarker
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        providers = try container.decode(
            [LossyDecodableElement<ServerProviderSnapshot>].self,
            forKey: .providers
        ).compactMap(\.value)
        settings = try container.decodeIfPresent(ServerSettingsSnapshot.self, forKey: .settings)
        t3WorkDirectory = try container.decodeIfPresent(String.self, forKey: .t3WorkDirectory)
        threadSnapshotWindow = try container.decodeIfPresent(
            Bool.self,
            forKey: .threadSnapshotWindow
        )
        threadResumeCompletionMarker = try container.decodeIfPresent(
            Bool.self,
            forKey: .threadResumeCompletionMarker
        )
        shellResumeCompletionMarker = try container.decodeIfPresent(
            Bool.self,
            forKey: .shellResumeCompletionMarker
        )
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(providers, forKey: .providers)
        try container.encodeIfPresent(settings, forKey: .settings)
        try container.encodeIfPresent(t3WorkDirectory, forKey: .t3WorkDirectory)
        try container.encodeIfPresent(threadSnapshotWindow, forKey: .threadSnapshotWindow)
        try container.encodeIfPresent(
            threadResumeCompletionMarker,
            forKey: .threadResumeCompletionMarker
        )
        try container.encodeIfPresent(
            shellResumeCompletionMarker,
            forKey: .shellResumeCompletionMarker
        )
    }
}

private struct LossyDecodableElement<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: any Decoder) throws {
        value = try? Value(from: decoder)
    }
}

public enum ServerConfigStreamEvent: Decodable, Sendable {
    case snapshot(ServerConfigSnapshot)
    case providerStatuses([ServerProviderSnapshot])
    case settingsUpdated(ServerSettingsSnapshot)
    case unrelated(type: String)

    private enum CodingKeys: String, CodingKey { case type, config, payload }
    private struct ProviderPayload: Decodable {
        let providers: [ServerProviderSnapshot]

        private enum CodingKeys: String, CodingKey { case providers }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            providers = try container.decode(
                [LossyDecodableElement<ServerProviderSnapshot>].self,
                forKey: .providers
            ).compactMap(\.value)
        }
    }
    private struct SettingsPayload: Decodable { let settings: ServerSettingsSnapshot }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "snapshot":
            self = .snapshot(
                try container.decode(ServerConfigSnapshot.self, forKey: .config)
            )
        case "providerStatuses":
            self = .providerStatuses(
                try container.decode(ProviderPayload.self, forKey: .payload).providers
            )
        case "settingsUpdated":
            self = .settingsUpdated(
                try container.decode(SettingsPayload.self, forKey: .payload).settings
            )
        default:
            self = .unrelated(type: type)
        }
    }
}
