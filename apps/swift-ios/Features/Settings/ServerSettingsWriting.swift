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
    func providerSetup(environmentID: String, instanceID: String, action: NativeProviderSetupAction) async throws
    func providerAuthEvents(environmentID: String, instanceID: String) async throws -> AsyncThrowingStream<NativeProviderAuthState, Error>
    func providerInstallEvents(environmentID: String, instanceID: String) async throws -> AsyncThrowingStream<NativeProviderInstallState, Error>
    func updateDesktopApp(environmentID: String, progress: @escaping @Sendable (String) async -> Void) async throws -> String
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

extension FeatureServerSettingsManaging {
    public func updateDesktopApp(environmentID: String, progress: @escaping @Sendable (String) async -> Void) async throws -> String {
        throw FeatureCapabilityUnavailable("Remote desktop updates")
    }
}

// MARK: - Model selections

extension FeatureSelection {
    /// A selection the server stores, in the shape the model picker binds to.
    /// Option values the picker cannot show are dropped rather than guessed.
    init(serverSelection value: ModelSelection) {
        self.init(
            providerID: value.instanceId,
            modelID: value.model,
            options: (value.options ?? []).compactMap { option in
                switch option.value {
                case let .string(raw): FeatureModelOptionSelection(id: option.id, value: .string(raw))
                case let .bool(raw): FeatureModelOptionSelection(id: option.id, value: .boolean(raw))
                default: nil
                }
            }
        )
    }
}

extension ModelSelection {
    /// The wire shape of a picker selection, for a settings write.
    init(featureSelection selection: FeatureSelection) {
        let options = selection.options.map { option in
            let value: JSONValue
            switch option.value {
            case let .string(raw): value = .string(raw)
            case let .boolean(raw): value = .bool(raw)
            }
            return ModelSelection.OptionSelection(id: option.id, value: value)
        }
        self.init(
            instanceId: selection.providerID,
            model: selection.modelID,
            options: options.isEmpty ? nil : options
        )
    }
}

// MARK: - Optimistic writes

extension ServerSettingsPatchInput {
    /// This patch with `later` laid over it: fields `later` sets win, fields it
    /// omits keep this patch's value, and per-key maps merge key by key.
    ///
    /// Settings pages keep the patches still in flight merged into one, and
    /// read it before the last loaded config. A control therefore shows the
    /// value it was just set to for the whole round trip, instead of snapping
    /// back to the old one — or to a fallback — until the reload lands.
    func merged(with later: ServerSettingsPatchInput) -> ServerSettingsPatchInput {
        func mergeMap<Value>(_ base: [String: Value]?, _ next: [String: Value]?) -> [String: Value]? {
            guard let next else { return base }
            return (base ?? [:]).merging(next) { _, newer in newer }
        }
        var result = self
        if let value = later.sidebarAutoSettleAfterDays { result.sidebarAutoSettleAfterDays = value }
        if let value = later.continueThreadsAfterServerUpdate { result.continueThreadsAfterServerUpdate = value }
        if let value = later.sidebarAutoSettleOnMerge { result.sidebarAutoSettleOnMerge = value }
        if let value = later.textGenerationModelSelection { result.textGenerationModelSelection = value }
        if let value = later.sourceControlWritingStyle {
            var style = result.sourceControlWritingStyle ?? SourceControlWritingStylePatch()
            if let mode = value.mode { style.mode = mode }
            if let instructions = value.customInstructions { style.customInstructions = instructions }
            if let follow = value.followChangeRequestTemplates { style.followChangeRequestTemplates = follow }
            result.sourceControlWritingStyle = style
        }
        if let value = later.newWorktreesStartFromOrigin { result.newWorktreesStartFromOrigin = value }
        if let value = later.defaultModelSelection { result.defaultModelSelection = value }
        if let value = later.defaultThreadEnvMode { result.defaultThreadEnvMode = value }
        if let value = later.defaultProjectScripts { result.defaultProjectScripts = value }
        result.projectScriptOverrides = mergeMap(projectScriptOverrides, later.projectScriptOverrides)
        if let value = later.defaultAutoPull { result.defaultAutoPull = value }
        result.projectAgentBrowserAccessOverrides = mergeMap(projectAgentBrowserAccessOverrides, later.projectAgentBrowserAccessOverrides)
        result.projectAutoPullOverrides = mergeMap(projectAutoPullOverrides, later.projectAutoPullOverrides)
        if let value = later.providerInstances { result.providerInstances = value }
        result.customModelsByDriver = mergeMap(customModelsByDriver, later.customModelsByDriver)
        if let value = later.environmentIcon { result.environmentIcon = value }
        result.usageLimitSources = mergeMap(usageLimitSources, later.usageLimitSources)
        result.usagePriceOverrides = mergeMap(usagePriceOverrides, later.usagePriceOverrides)
        if let value = later.enableHermes { result.enableHermes = value }
        if let value = later.enableAgentBrowserAccess { result.enableAgentBrowserAccess = value }
        if let value = later.claudeAutoCompactWindow { result.claudeAutoCompactWindow = value }
        result.hiddenModelsByProvider = mergeMap(hiddenModelsByProvider, later.hiddenModelsByProvider)
        return result
    }
}

/// The state behind a page that edits one server's settings: the last config
/// the server sent, and the writes still on their way to it.
///
/// A reload never clears `config`. Blanking it made every control fall back to
/// its default for the length of the round trip — merged-settlement on,
/// inactive-settlement off, the stepper gone — and snap back afterwards.
struct ServerSettingsPageState: Equatable {
    /// The server `config` came from.
    private(set) var environmentID: String?
    private(set) var config: ServerConfigSnapshot?
    /// Writes sent but not yet reflected in `config`, merged in send order.
    private(set) var pending = ServerSettingsPatchInput()
    private(set) var isLoading = false
    private var writesInFlight = 0

    var settings: ServerSettingsSnapshot? { config?.settings }
    var capabilities: EnvironmentDescriptor.Capabilities? { config?.environment?.capabilities }
    var isWriting: Bool { writesInFlight > 0 }

    /// Starts a load. Switching servers is the one time the old config goes,
    /// because it belongs to another machine; reloading the same server keeps
    /// it on screen until the answer lands.
    mutating func beginLoad(environmentID: String) {
        if environmentID != self.environmentID {
            self = ServerSettingsPageState()
            self.environmentID = environmentID
        }
        isLoading = true
    }

    mutating func finishLoad(_ config: ServerConfigSnapshot) {
        self.config = config
        isLoading = false
        // Once every write has landed the server's answer is the truth, and
        // an overlay left behind would mask a value it clamped or rejected.
        if writesInFlight == 0 { pending = ServerSettingsPatchInput() }
    }

    /// Ends a load that produced no config: failed, cancelled or superseded.
    mutating func endLoad() { isLoading = false }

    mutating func beginWrite(_ patch: ServerSettingsPatchInput) {
        writesInFlight += 1
        pending = pending.merged(with: patch)
    }

    /// Returns true when this was the last write in flight, which is when the
    /// page should reload to settle on the server's answer.
    mutating func finishWrite(succeeded: Bool) -> Bool {
        writesInFlight = max(0, writesInFlight - 1)
        // A failed write drops every optimistic value, so the controls go back
        // to what the server last confirmed rather than keep a lie on screen.
        if !succeeded { pending = ServerSettingsPatchInput() }
        return writesInFlight == 0
    }
}

extension FeatureServerSettingsManaging {
    public func providerSetup(environmentID: String, instanceID: String, action: NativeProviderSetupAction) async throws { throw FeatureCapabilityUnavailable("Provider setup") }
    public func providerAuthEvents(environmentID: String, instanceID: String) async throws -> AsyncThrowingStream<NativeProviderAuthState, Error> { throw FeatureCapabilityUnavailable("Provider setup") }
    public func providerInstallEvents(environmentID: String, instanceID: String) async throws -> AsyncThrowingStream<NativeProviderInstallState, Error> { throw FeatureCapabilityUnavailable("Provider setup") }
}
