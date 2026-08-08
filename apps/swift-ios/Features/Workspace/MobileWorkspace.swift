import Foundation

// Ported from apps/mobile/src/lib/mobileWorkspace.ts.
//
// T3 Work (the Hermes assistant) and T3 Code (the coding providers) share one
// thread list, one composer and one server config, so nothing upstream of the
// client separates them. The split is decided here: a thread belongs to Work
// when its provider instance resolves to the `hermes` driver, and the Work
// switcher then hides project filters and starts a Hermes conversation instead
// of opening the project task sheet.

/// Declaration order is tab order: Code, Work, Chat.
public enum MobileWorkspace: String, CaseIterable, Sendable {
    case code
    case work
    /// Hermes conversations born on the Chat surface (`workInboxRole: "chat"`),
    /// kept apart from Work's task inbox.
    case chat
}

/// Driver kind per `(environment, provider instance)` pair, keyed by
/// ``MobileWorkspaceRouting/providerInstanceKey(environmentID:providerInstanceID:)``.
/// Instance ids are only unique inside one environment, so a bare instance id
/// cannot key this on a multi-environment client.
public typealias MobileWorkspaceProviderDrivers = [String: String]

/// One environment's slice of the server config, in the order environments were
/// connected. Hermes launch resolution takes the first environment that can host
/// the conversation, so an unordered dictionary would make the choice depend on
/// hashing rather than on connection order.
public struct MobileWorkspaceEnvironmentConfig: Equatable, Sendable {
    public let environmentID: String
    /// The server's dedicated T3 Work checkout. Absent until the server is set
    /// up for Work, which is what stops a Work launch from attaching itself to
    /// whatever project happens to be first. Supplied separately because
    /// `ServerConfigSnapshot` does not decode this field yet.
    public let t3WorkDirectory: String?
    public let providers: [ServerProviderSnapshot]

    public init(
        environmentID: String,
        t3WorkDirectory: String?,
        providers: [ServerProviderSnapshot]
    ) {
        self.environmentID = environmentID
        self.t3WorkDirectory = t3WorkDirectory
        self.providers = providers
    }
}

/// A project paired with the environment that owns it. Two environments can
/// expose the same workspace root, so routing has to match both.
public struct MobileWorkspaceProject: Equatable, Sendable {
    public let environmentID: String
    public let project: OrchestrationProject

    public init(environmentID: String, project: OrchestrationProject) {
        self.environmentID = environmentID
        self.project = project
    }
}

/// The thread fields the workspace split reads. Modelled apart from
/// `OrchestrationV2ThreadShell` because routing also runs over cached shells
/// that predate the current wire shape, and because the environment id lives
/// outside the wire type on a multi-environment client.
public struct MobileWorkspaceThread: Equatable, Sendable {
    public let environmentID: String
    public let archivedAt: String?
    /// `"subagent"` for a thread spawned by another thread.
    public let relationshipToParent: String?
    /// Fallback chain for the instance that owns the thread, widest first: not
    /// every source carries all three, and an older cached shell may only have
    /// the model selection.
    public let runtimeProviderInstanceID: String?
    public let providerInstanceID: String?
    public let modelSelection: ModelSelection
    /// `"main"` for the always-pinned Work thread.
    public let workInboxRole: String?
    public let hasPendingApprovals: Bool
    public let hasPendingUserInput: Bool

    public init(
        environmentID: String,
        archivedAt: String? = nil,
        relationshipToParent: String? = nil,
        runtimeProviderInstanceID: String? = nil,
        providerInstanceID: String? = nil,
        modelSelection: ModelSelection,
        workInboxRole: String? = nil,
        hasPendingApprovals: Bool = false,
        hasPendingUserInput: Bool = false
    ) {
        self.environmentID = environmentID
        self.archivedAt = archivedAt
        self.relationshipToParent = relationshipToParent
        self.runtimeProviderInstanceID = runtimeProviderInstanceID
        self.providerInstanceID = providerInstanceID
        self.modelSelection = modelSelection
        self.workInboxRole = workInboxRole
        self.hasPendingApprovals = hasPendingApprovals
        self.hasPendingUserInput = hasPendingUserInput
    }

    public init(environmentID: String, shell: OrchestrationV2ThreadShell) {
        // V2 collapsed the two pending flags into a single runtime request, so
        // they are re-derived here the way the React Native shell presenter
        // does: an auth refresh is the client's problem, not the user's, and so
        // counts as neither.
        let pendingKind = shell.pendingRuntimeRequest?.kind
        self.init(
            environmentID: environmentID,
            archivedAt: shell.archivedAt,
            relationshipToParent: shell.lineage.relationshipToParent,
            // A V2 shell reports one instance for both the thread and its live
            // runtime, so there is nothing finer to distinguish here.
            runtimeProviderInstanceID: shell.providerInstanceId,
            providerInstanceID: shell.providerInstanceId,
            modelSelection: shell.modelSelection,
            workInboxRole: shell.workInboxRole,
            hasPendingApprovals: pendingKind != nil
                && pendingKind != "user_input"
                && pendingKind != "auth_refresh",
            hasPendingUserInput: pendingKind == "user_input"
        )
    }
}

/// Sections of the T3 Work inbox, mirroring the web sidebar: main is the
/// always-pinned thread, `needsYou` is blocked-on-you work, and everything
/// else is ordinary active work.
public enum MobileWorkInboxSection: String, Equatable, Sendable {
    case main
    case needsYou = "needs-you"
    case active
}

public struct HermesConversationTarget: Equatable, Sendable {
    public let project: MobileWorkspaceProject
    public let modelSelection: ModelSelection

    public init(project: MobileWorkspaceProject, modelSelection: ModelSelection) {
        self.project = project
        self.modelSelection = modelSelection
    }
}

public enum MobileWorkspaceRouting {
    /// NUL joins the halves so no environment id can run into a provider
    /// instance id and forge another pair's key.
    public static func providerInstanceKey(
        environmentID: String,
        providerInstanceID: String
    ) -> String {
        "\(environmentID)\u{0}\(providerInstanceID)"
    }

    public static func providerDriverMap(
        serverConfigs: [MobileWorkspaceEnvironmentConfig]
    ) -> MobileWorkspaceProviderDrivers {
        var drivers: MobileWorkspaceProviderDrivers = [:]
        for config in serverConfigs {
            for provider in config.providers {
                drivers[
                    providerInstanceKey(
                        environmentID: config.environmentID,
                        providerInstanceID: provider.instanceId
                    )
                ] = provider.driver
            }
        }
        return drivers
    }

    public static func isHermesProviderInstance(
        environmentID: String,
        providerInstanceID: String,
        providerDrivers: MobileWorkspaceProviderDrivers
    ) -> Bool {
        let driver = providerDrivers[
            providerInstanceKey(
                environmentID: environmentID,
                providerInstanceID: providerInstanceID
            )
        ]
        // Cached shells can arrive before server config. The canonical legacy
        // instance id is a safe fallback; custom instance ids wait for metadata.
        return driver == "hermes" || (driver == nil && providerInstanceID == "hermes")
    }

    public static func isHermesThread(
        _ thread: MobileWorkspaceThread,
        providerDrivers: MobileWorkspaceProviderDrivers
    ) -> Bool {
        let providerInstanceID = thread.runtimeProviderInstanceID
            ?? thread.providerInstanceID
            ?? thread.modelSelection.instanceId
        return isHermesProviderInstance(
            environmentID: thread.environmentID,
            providerInstanceID: providerInstanceID,
            providerDrivers: providerDrivers
        )
    }

    public static func isWorkspaceThread(
        _ thread: MobileWorkspaceThread,
        workspace: MobileWorkspace,
        providerDrivers: MobileWorkspaceProviderDrivers
    ) -> Bool {
        if thread.archivedAt != nil || thread.relationshipToParent == "subagent" {
            return false
        }
        let isHermes = isHermesThread(thread, providerDrivers: providerDrivers)
        switch workspace {
        case .code:
            return !isHermes
        case .work:
            // Work keeps its whole inbox — including Main — minus the
            // conversations that were born as Chat.
            return isHermes && thread.workInboxRole != "chat"
        case .chat:
            return isHermes && thread.workInboxRole == "chat"
        }
    }

    public static func workInboxSection(_ thread: MobileWorkspaceThread) -> MobileWorkInboxSection {
        if thread.workInboxRole == "main" { return .main }
        if thread.hasPendingApprovals || thread.hasPendingUserInput { return .needsYou }
        return .active
    }

    /// Main is pinned by definition and cannot be unpinned, and parked or
    /// finished work is not inbox work — so neither offers the pin affordance.
    public static func canPinWorkThread(
        thread: MobileWorkspaceThread,
        providerDrivers: MobileWorkspaceProviderDrivers,
        isSnoozed: Bool,
        isSettled: Bool
    ) -> Bool {
        thread.workInboxRole != "main"
            && thread.archivedAt == nil
            && thread.relationshipToParent != "subagent"
            && isHermesThread(thread, providerDrivers: providerDrivers)
            && !isSnoozed
            && !isSettled
    }

    /// A T3 Work conversation routes through a backing project that exists only
    /// to own the thread: the Work composer hides the Workspace pill and the
    /// launch path sends `prepareWorkspace: false`, so there is no way to pick a
    /// base branch and the server rejects a worktree strategy outright.
    /// Honouring a server-configured `worktree` default there would leave the
    /// composer's send gate permanently disabled, so Work always resolves to the
    /// current checkout.
    public static func resolveDraftWorkspaceMode(
        isWorkConversation: Bool,
        requestedMode: FeatureWorkspaceMode
    ) -> FeatureWorkspaceMode {
        isWorkConversation ? .local : requestedMode
    }

    /// Resolves the existing project shell used only to route a Hermes launch.
    /// Work UI never exposes this backing project, and `prepareWorkspace: false`
    /// prevents project/worktree setup from leaking into the conversation.
    public static func resolveHermesConversationTarget(
        projects: [MobileWorkspaceProject],
        serverConfigs: [MobileWorkspaceEnvironmentConfig],
        requiredEnvironmentID: String?
    ) -> HermesConversationTarget? {
        for config in serverConfigs {
            if let requiredEnvironmentID, config.environmentID != requiredEnvironmentID {
                continue
            }
            guard let workDirectory = config.t3WorkDirectory,
                  let project = projects.first(where: { candidate in
                      candidate.environmentID == config.environmentID
                          && candidate.project.workspaceRoot == workDirectory
                  })
            else { continue }

            for provider in config.providers where canLaunchHermes(provider) {
                guard let model = provider.models.first(where: { $0.slug == "default" })
                    ?? provider.models.first(where: { $0.isDefault == true })
                    ?? provider.models.first
                else { continue }
                return HermesConversationTarget(
                    project: project,
                    modelSelection: ModelSelection(
                        instanceId: provider.instanceId,
                        model: model.slug
                    )
                )
            }
        }
        return nil
    }

    /// An absent `availability` means available — the rule legacy servers (which
    /// omit the field) and current ones (which set it) agree on.
    private static func canLaunchHermes(_ provider: ServerProviderSnapshot) -> Bool {
        provider.driver == "hermes"
            && provider.enabled
            && provider.installed
            && provider.status == "ready"
            && provider.availability != "unavailable"
    }
}
