import Foundation

/// Environment permissions, mirrored from `packages/contracts/src/auth.ts`.
///
/// Servers split the two broad scopes into per-feature permissions. A server
/// that knows the split reports a session's exact grant as `permissions` and
/// keeps `scopes` in the vocabulary older clients decode. It never widens a
/// stored grant, so a device paired before the split keeps only the broad
/// scopes until it pairs again.
public enum AuthScope {
    public static let orchestrationRead = "orchestration:read"
    public static let orchestrationOperate = "orchestration:operate"
    public static let terminalOperate = "terminal:operate"
    public static let accessRead = "access:read"
    public static let accessWrite = "access:write"
    public static let settingsWrite = "settings:write"
    public static let providersManage = "providers:manage"
    public static let environmentMaintain = "environment:maintain"
    public static let previewOperate = "preview:operate"
    public static let diagnosticsRead = "diagnostics:read"
    public static let terminalRead = "terminal:read"
    public static let sourceControlWrite = "source-control:write"
    public static let filesystemRead = "filesystem:read"
    public static let filesystemWrite = "filesystem:write"

    /// The vocabulary from before the split.
    static let legacy: Set<String> = [
        orchestrationRead, orchestrationOperate, terminalOperate, "review:write",
        accessRead, accessWrite, "relay:read", "relay:write",
    ]

    /// The broad scope each split-off permission used to be part of. Only a
    /// server that reports no `permissions` is judged by it: such a server
    /// still enforces the parent.
    static let legacyParents: [String: String] = [
        filesystemRead: orchestrationRead,
        diagnosticsRead: orchestrationRead,
        settingsWrite: orchestrationOperate,
        providersManage: orchestrationOperate,
        environmentMaintain: orchestrationOperate,
        previewOperate: orchestrationOperate,
        sourceControlWrite: orchestrationOperate,
        filesystemWrite: orchestrationOperate,
        terminalRead: terminalOperate,
    ]

    /// Every scope this build knows. Others in a `permissions` list are
    /// ignored, as the contract's forward-compatible array drops them.
    static let known = legacy.union(legacyParents.keys)

    /// What a `server.updateSettings` patch needs, by its top-level keys:
    /// provider configuration needs `providers:manage`, anything else
    /// `settings:write`, and a mixed patch both.
    public static func required(forSettingsPatch patch: JSONValue) -> [String] {
        let providerKeys: Set<String> = ["providers", "providerInstances", "usageLimitSources"]
        guard case let .object(fields) = patch else { return [settingsWrite] }
        let changesProviders = fields.keys.contains(where: providerKeys.contains)
        let changesSettings = fields.keys.contains { !providerKeys.contains($0) }
        return (changesSettings || !changesProviders ? [settingsWrite] : [])
            + (changesProviders ? [providersManage] : [])
    }
}

public extension AuthSessionState {
    /// Whether this session may use `scope`: the exact `permissions` when the
    /// server reports them, otherwise `scopes` with each split-off permission
    /// granted by the broad scope an older server still checks.
    func grants(_ scope: String) -> Bool {
        guard authenticated else { return false }
        if let permissions { return permissions.contains(scope) }
        if scopes?.contains(scope) == true { return true }
        if auth?.serverUpdateScope != nil { return false }
        guard let parent = AuthScope.legacyParents[scope] else { return false }
        return scopes?.contains(parent) == true
    }

    /// A connection that may watch terminals (`terminal.observe`) but not type
    /// into, start, resize or close them. Only a server that reports
    /// `permissions` is judged: those are the servers with `terminal.observe`,
    /// and older ones keep attaching as before.
    var observesTerminalsOnly: Bool {
        permissions != nil && grants(AuthScope.terminalRead) && !grants(AuthScope.terminalOperate)
    }

    /// A grant from before the split, on a server that has split: only broad
    /// scopes, which no longer include the features moved to their own
    /// permissions. Pairing again issues the current grant.
    var hasLegacyPermissions: Bool {
        guard authenticated, let permissions else { return false }
        let known = permissions.filter(AuthScope.known.contains)
        return known.allSatisfy(AuthScope.legacy.contains)
            && AuthScope.legacyParents.values.contains(where: known.contains)
    }
}

/// A feature this connection's permissions do not include, for a permission
/// the split introduced: pairing again with a standard link grants it.
public struct AuthPermissionRequired: LocalizedError, Equatable, Sendable {
    private static let purposes = [
        AuthScope.filesystemRead: "browse and preview files",
        AuthScope.filesystemWrite: "save files",
        AuthScope.sourceControlWrite: "use Git and pull request actions",
        AuthScope.settingsWrite: "change server settings",
        AuthScope.providersManage: "set up and update providers",
        AuthScope.environmentMaintain: "update the server",
        AuthScope.diagnosticsRead: "see usage",
        AuthScope.terminalRead: "see terminals",
        AuthScope.previewOperate: "control previews",
    ]

    public let permission: String

    /// Nil for scopes that predate the split, where pairing again with a
    /// standard link may not help.
    public init?(_ permission: String) {
        guard Self.purposes[permission] != nil else { return nil }
        self.permission = permission
    }

    public var errorDescription: String? {
        let purpose = Self.purposes[permission] ?? "use this feature"
        return "Pair this device again to \(purpose). This connection's permissions don't include it."
    }
}
