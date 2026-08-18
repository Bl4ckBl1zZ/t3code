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
