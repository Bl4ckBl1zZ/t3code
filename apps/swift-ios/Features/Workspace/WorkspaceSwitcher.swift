import Foundation

// Ported from apps/mobile/src/features/home/HomeHeader.tsx (the T3 Work / T3
// Code switcher), HomeRouteScreen.tsx (what choosing one actually changes) and
// apps/mobile/src/features/threads/sidebar-native-header-items.ts. On iOS the
// switcher is Home's tab bar.
//
// The switcher decides nothing about which threads belong where: that is
// `MobileWorkspaceRouting`'s job and it is already ported. What lives here is
// what each tab is called, the filters the choice suppresses — Work threads all
// sit on one hidden backing project, so a project filter there would only ever
// read "All projects" — and where the compose affordance goes, which is a
// different destination per workspace rather than a different argument.

/// Where the compose affordance goes for the current workspace.
///
/// T3 Code opens the new-task sheet against a real project. T3 Work has no
/// project to open the sheet against — it launches a Hermes conversation on the
/// server's private backing project — and that launch can be unavailable, which
/// is a message rather than a silent no-op.
public enum WorkspaceNewTaskIntent: Equatable, Sendable {
    case newTask(projectID: String?)
    case hermesConversation(HermesConversationTarget)
    case hermesUnavailable(title: String, message: String)
}

public enum WorkspaceSwitcher {
    // MARK: - Persistence

    /// `@AppStorage` key for the remembered workspace.
    public static let storageKey = "swift-ios.workspace"

    /// Anything other than an explicit `work` reads as Code, mirroring
    /// `useMobileWorkspace`: a first launch, a cleared store and a value written
    /// by a future build all have to land somewhere, and Code is the surface
    /// that works without Hermes being configured at all.
    public static func stored(_ rawValue: String?) -> MobileWorkspace {
        rawValue.flatMap(MobileWorkspace.init(rawValue:)) ?? .code
    }

    // MARK: - Labels

    /// The tab title: "Code", "Work", "Chat".
    public static func shortTitle(_ workspace: MobileWorkspace) -> String {
        switch workspace {
        case .work: "Work"
        case .code: "Code"
        case .chat: "Chat"
        }
    }

    // MARK: - What the choice suppresses

    /// Every Work thread lives on the one hidden backing project, so a project
    /// filter there can only ever say "All projects".
    public static func showsProjectFilter(_ workspace: MobileWorkspace) -> Bool {
        workspace == .code
    }

    /// The remembered Code selection is kept, not cleared, while Work is
    /// showing: switching back should land where the user left off.
    public static func projectFilter(
        _ workspace: MobileWorkspace,
        selectedProjectID: String?
    ) -> String? {
        showsProjectFilter(workspace) ? selectedProjectID : nil
    }

    // MARK: - Routing over the Home snapshot

    /// `MobileWorkspaceThread.archivedAt` is only ever read for presence, and a
    /// Home snapshot row flattens the archive timestamp to a flag. A marker is
    /// the honest translation; fabricating a timestamp would invent a fact.
    private static let archivedMarker = "archived"

    /// Driver per `(environment, provider instance)` for the Home snapshot,
    /// which is what the workspace split reads.
    ///
    /// The native client already resolves each provider's driver, so this needs
    /// no server-config round trip. Environments the catalogue does not cover
    /// fall through to `isHermesProviderInstance`'s legacy-id rule rather than
    /// being guessed at.
    public static func providerDrivers(
        in snapshot: FeatureSnapshot
    ) -> MobileWorkspaceProviderDrivers {
        var drivers: MobileWorkspaceProviderDrivers = [:]
        for (environmentID, providers) in snapshot.providersByEnvironment ?? [:] {
            for provider in providers {
                drivers[
                    MobileWorkspaceRouting.providerInstanceKey(
                        environmentID: environmentID,
                        providerInstanceID: provider.id
                    )
                ] = provider.driver
            }
        }
        // Single-environment clients (and snapshots from before the catalogue
        // was split per environment) only carry the active environment's
        // providers. Attribute those to the same environment the rows resolve
        // to, or they would never match a key.
        let defaultEnvironmentID = fallbackEnvironmentID(in: snapshot)
        for provider in snapshot.providers {
            let key = MobileWorkspaceRouting.providerInstanceKey(
                environmentID: defaultEnvironmentID,
                providerInstanceID: provider.id
            )
            if drivers[key] == nil { drivers[key] = provider.driver }
        }
        return drivers
    }

    /// The environment a row without an explicit id belongs to. Kept in one
    /// place so ``providerDrivers(in:)`` and ``workspaceThread(_:environmentID:workInboxRole:relationshipToParent:)``
    /// cannot disagree about which key a legacy snapshot writes under.
    public static func fallbackEnvironmentID(in snapshot: FeatureSnapshot) -> String {
        snapshot.environments.first(where: \.isActive)?.id
            ?? snapshot.environments.first?.id
            ?? ""
    }

    /// Bridges a Home row onto the routing model.
    ///
    /// `workInboxRole` and `relationshipToParent` are parameters rather than
    /// reads off `FeatureThread`, which carries neither: passing them in keeps
    /// the two facts visible at the call site instead of silently defaulting a
    /// pinned Main thread into Active.
    public static func workspaceThread(
        _ thread: FeatureThread,
        environmentID: String? = nil,
        workInboxRole: String? = nil,
        relationshipToParent: String? = nil
    ) -> MobileWorkspaceThread {
        MobileWorkspaceThread(
            environmentID: environmentID ?? thread.environmentID ?? "",
            archivedAt: thread.isArchived ? archivedMarker : nil,
            relationshipToParent: relationshipToParent,
            runtimeProviderInstanceID: nil,
            providerInstanceID: thread.providerID,
            // The Home row keeps the instance and model apart; the routing model
            // reads them back as one selection, which is the last fallback when
            // no instance id survived the snapshot.
            modelSelection: ModelSelection(
                instanceId: thread.providerID ?? "",
                model: thread.modelID ?? ""
            ),
            workInboxRole: workInboxRole,
            hasPendingApprovals: thread.state == .waitingForApproval,
            hasPendingUserInput: thread.state == .waitingForInput
        )
    }

    public static func isWorkThread(
        _ thread: FeatureThread,
        environmentID: String? = nil,
        providerDrivers: MobileWorkspaceProviderDrivers
    ) -> Bool {
        MobileWorkspaceRouting.isHermesThread(
            workspaceThread(thread, environmentID: environmentID),
            providerDrivers: providerDrivers
        )
    }

    /// The tab a thread lives in: Code for anything not on Hermes, then Chat or
    /// Work by the conversation's inbox role. Unlike ``threads(_:in:providerDrivers:fallbackEnvironmentID:relationshipToParent:)``
    /// this also answers for archived threads, so a link to one lands on the
    /// tab whose Archived shelf holds it.
    public static func workspace(
        of thread: FeatureThread,
        providerDrivers: MobileWorkspaceProviderDrivers,
        fallbackEnvironmentID: String
    ) -> MobileWorkspace {
        guard isWorkThread(
            thread,
            environmentID: thread.environmentID ?? fallbackEnvironmentID,
            providerDrivers: providerDrivers
        ) else { return .code }
        return thread.workInboxRole == "chat" ? .chat : .work
    }

    /// The rows one workspace shows, in the order they were handed in.
    ///
    /// Archived and subagent rows are dropped by `isWorkspaceThread`, so the
    /// Archive shelf keeps filtering the snapshot itself rather than running
    /// through here.
    public static func threads(
        _ threads: [FeatureThread],
        in workspace: MobileWorkspace,
        providerDrivers: MobileWorkspaceProviderDrivers,
        fallbackEnvironmentID: String = "",
        relationshipToParent: (FeatureThread) -> String? = \.relationshipToParent
    ) -> [FeatureThread] {
        threads.filter { thread in
            MobileWorkspaceRouting.isWorkspaceThread(
                workspaceThread(
                    thread,
                    environmentID: thread.environmentID ?? fallbackEnvironmentID,
                    // Chat vs Work is decided by the inbox role, so it has to
                    // survive the bridging.
                    workInboxRole: thread.workInboxRole,
                    relationshipToParent: relationshipToParent(thread)
                ),
                workspace: workspace,
                providerDrivers: providerDrivers
            )
        }
    }

    // MARK: - Compose

    public static let hermesUnavailableTitle = "Hermes is not ready"
    public static let hermesUnavailableMessage =
        "Enable and configure Hermes on a connected environment before starting a Work conversation."

    /// Where "new task" goes.
    ///
    /// Work resolves its own target so the caller never picks a project for it:
    /// attaching a Work conversation to whatever project happens to be selected
    /// is exactly what `resolveHermesConversationTarget` exists to prevent.
    public static func newTaskIntent(
        workspace: MobileWorkspace,
        selectedProjectID: String?,
        projects: [MobileWorkspaceProject],
        serverConfigs: [MobileWorkspaceEnvironmentConfig],
        requiredEnvironmentID: String?
    ) -> WorkspaceNewTaskIntent {
        // Chat and Work both live on Hermes; only Code opens the project task
        // sheet.
        guard workspace != .code else {
            return .newTask(projectID: selectedProjectID)
        }
        guard let target = MobileWorkspaceRouting.resolveHermesConversationTarget(
            projects: projects,
            serverConfigs: serverConfigs,
            requiredEnvironmentID: requiredEnvironmentID
        ) else {
            return .hermesUnavailable(
                title: hermesUnavailableTitle,
                message: hermesUnavailableMessage
            )
        }
        return .hermesConversation(target)
    }
}
