import Foundation

// The write half of server-authoritative settings.
//
// Reading them needs nothing here: `FeatureEnvironmentPreferences` already
// carries them into the snapshot from the server-config subscription, so a row
// bound to that stays honest when another client changes the same setting.
// Writing is what this client had no path for, and this is it.

/// The settings a client can write back to a paired server.
///
/// Optional in the same way as `FeatureDeviceManaging` and
/// `FeatureVoiceSettingsManaging`: a client that cannot reach a server keeps
/// working, its rows just refuse the write instead of going missing.
@MainActor
public protocol FeatureServerSettingsManaging: AnyObject {
    func providerUpdateEvents(environmentID: String) async throws -> AsyncThrowingStream<[ServerProviderSnapshot], Error>
    func updateProvider(environmentID: String, driver: String, instanceID: String) async throws -> [ServerProviderSnapshot]
    func refreshProviderUpdates(environmentID: String) async throws -> [ServerProviderSnapshot]
    func sharedSettingsMismatches(environmentID: String) async throws -> [FeatureSharedSettingsMismatch]
    func applySharedSettings(environmentID: String) async throws
    func providerModelConfiguration(environmentID: String) async throws -> ServerConfigSnapshot
    /// Applies a sparse patch and returns the settings the server settled on.
    ///
    /// Returning the server's own answer rather than assuming the write took
    /// is what lets a row correct itself when the server clamps or rejects a
    /// value.
    @discardableResult
    func updateServerSettings(
        environmentID: String,
        patch: ServerSettingsPatchInput
    ) async throws -> FeatureEnvironmentPreferences
}

/// Stand-in for clients that do not implement the capability. Writes throw,
/// because a silently dropped write would look like a save that stuck.
@MainActor
final class EmptyFeatureServerSettingsManager: FeatureServerSettingsManaging {
    static let shared = EmptyFeatureServerSettingsManager()

    private init() {}

    @discardableResult
    func updateServerSettings(
        environmentID _: String,
        patch _: ServerSettingsPatchInput
    ) async throws -> FeatureEnvironmentPreferences {
        throw FeatureCapabilityUnavailable("Server settings")
    }
}


extension FeatureServerSettingsManaging {
    public func providerModelConfiguration(environmentID: String) async throws -> ServerConfigSnapshot {
        throw FeatureCapabilityUnavailable("Provider model settings")
    }
}

public struct FeatureSharedSettingsMismatch: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
}

extension FeatureServerSettingsManaging {
    public func sharedSettingsMismatches(environmentID: String) async throws -> [FeatureSharedSettingsMismatch] { [] }
    public func applySharedSettings(environmentID: String) async throws { throw FeatureCapabilityUnavailable("Shared preferences") }
}

extension FeatureServerSettingsManaging {
    public func updateProvider(environmentID: String, driver: String, instanceID: String) async throws -> [ServerProviderSnapshot] {
        throw FeatureCapabilityUnavailable("Provider updates")
    }
    public func refreshProviderUpdates(environmentID: String) async throws -> [ServerProviderSnapshot] {
        throw FeatureCapabilityUnavailable("Provider update checks")
    }
}

extension FeatureServerSettingsManaging {
    public func providerUpdateEvents(environmentID: String) async throws -> AsyncThrowingStream<[ServerProviderSnapshot], Error> {
        AsyncThrowingStream { $0.finish() }
    }
}
