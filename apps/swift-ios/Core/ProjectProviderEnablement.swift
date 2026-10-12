import Foundation

/// One project's override of a provider instance (`ProjectProviderInstanceOverride`
/// in `packages/contracts/src/settings.ts`). Only `enabled` is overridable.
public struct ProjectProviderInstanceOverride: Codable, Equatable, Sendable {
    public var enabled: Bool?

    public init(enabled: Bool? = nil) {
        self.enabled = enabled
    }
}

/// Ports of the per-project provider switch helpers in
/// `packages/shared/src/serverSettings.ts`: a project's own switch wins in
/// either direction, otherwise the machine's enablement applies.
extension ServerSettingsSnapshot {
    /// A project's own switch for an instance; nil inherits the machine.
    /// `projectProviderInstanceOverride` upstream.
    public func projectProviderInstanceOverride(projectID: String?, instanceID: String) -> Bool? {
        guard let projectID else { return nil }
        return projectProviderInstanceOverrides[projectID]?[instanceID]?.enabled
    }

    /// The machine-wide enablement settings give an instance:
    /// `isModelSelectionProviderEnabled` upstream. A configured instance reads
    /// its envelope and config flags; an unconfigured one is enabled only when
    /// it is a built-in driver's default instance the legacy `providers` block
    /// turns on, so a deleted instance's stale snapshot reads as off.
    public func isProviderInstanceEnabledOnMachine(_ instanceID: String) -> Bool {
        if case let .object(instance)? = providerInstances[instanceID] {
            return Self.resolveProviderInstanceEnabled(instance)
        }
        if case let .object(legacy)? = providerDefinitions[instanceID] {
            return legacy["enabled"] == .bool(true)
        }
        return false
    }

    /// Effective enablement for an instance within a project; nil (no project
    /// in scope) reads the machine. `resolveProjectProviderInstanceEnabled` upstream.
    public func resolveProjectProviderInstanceEnabled(projectID: String?, instanceID: String) -> Bool {
        projectProviderInstanceOverride(projectID: projectID, instanceID: instanceID)
            ?? isProviderInstanceEnabledOnMachine(instanceID)
    }

    /// `resolveProviderInstanceEnabled` in `packages/contracts`: an explicit
    /// false on the envelope or the config wins; otherwise envelope, config,
    /// then the driver's default.
    static func resolveProviderInstanceEnabled(_ instance: [String: JSONValue]) -> Bool {
        func flag(_ value: JSONValue?) -> Bool? {
            if case let .bool(enabled)? = value { return enabled }
            return nil
        }
        let envelope = flag(instance["enabled"])
        let configEnabled = flag(instance["config"]?["enabled"])
        if envelope == false || configEnabled == false { return false }
        let driver = instance["driver"]?.stringValue ?? ""
        return envelope ?? configEnabled ?? defaultEnabledForDriver(driver)
    }

    /// `defaultEnabledForDriver` in `packages/contracts`: the decoding default of
    /// each built-in driver's `enabled`. Unknown (fork) drivers default to on.
    static func defaultEnabledForDriver(_ driver: String) -> Bool {
        !["cursor", "grok", "antigravity", "muse", "pi", "opencode"].contains(driver)
    }
}

extension ServerConfigSnapshot {
    /// The provider instances this server has turned off for one project
    /// (wire id), or nil when nothing needs scoping: the server predates the
    /// `projectProviderInstanceOverrides` capability, settings are unknown, or
    /// no project overrides anything. Without overrides the project resolves to
    /// the machine, which the provider snapshots already reflect.
    public func providerInstancesOff(inProject projectID: String) -> Set<String>? {
        guard environment?.capabilities.projectProviderInstanceOverrides == true,
              let settings, !settings.projectProviderInstanceOverrides.isEmpty else { return nil }
        return Set(providers.map(\.instanceId).filter {
            !settings.resolveProjectProviderInstanceEnabled(projectID: projectID, instanceID: $0)
        })
    }
}

/// The server refuses a turn on an instance the thread's project turned off
/// with `ThreadManagementProviderInstanceDisabledError`, whose message names
/// the instance and the raw project id. This rewords it for people.
public enum ProviderInstanceDisabledFailure {
    static let message =
        "This provider is turned off for this project. Pick another model, or turn the provider on in the project's settings on the host."

    /// The reworded message, or nil when `raw` is some other error.
    public static func userMessage(for raw: String) -> String? {
        raw.hasPrefix("Provider instance \"") && raw.contains("\" is disabled for project ")
            ? message
            : nil
    }
}
