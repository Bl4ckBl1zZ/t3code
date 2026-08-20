import Foundation

// Ported from apps/mobile/src/features/home/useThreadListActions.ts
// (`useCopyThreadHandoffScript` and `useRegenerateThreadTitle`) and the row
// menus those two hang off in
// apps/mobile/src/features/threads/thread-list-v2-items.tsx.
//
// Both actions are slow, server-side and non-idempotent-looking: a handoff
// script is an AI summary that can take seconds, and a title regeneration arms a
// server-side marker rather than returning a title. A second tap on either while
// the first is still out would queue a duplicate the user never sees, so the
// guard against that is part of the action, not the view.

// MARK: - Menu

/// The row facts the long-press menu reads. Modelled as one value so the menu
/// stays a pure function of the row, testable without UIKit.
public struct ThreadRowMenuContext: Equatable, Sendable {
    public let isArchived: Bool
    public let canTogglePin: Bool
    public let isPinned: Bool
    public let isSettled: Bool
    public let isSnoozed: Bool
    /// False while the thread is queued or waiting on the user: snoozing would
    /// hide a row that is asking for something.
    public let canSnooze: Bool
    /// Whether this surface has the parking shelves at all. Chat does not: a
    /// conversation is either there or deleted, so Settle and Snooze never
    /// appear on its rows.
    public let offersParking: Bool
    /// Whether this thread can be settled at all: the environment must report
    /// the capability, and the Work Main thread never parks. As with title
    /// regeneration, an unsupported action is omitted rather than offered and
    /// refused by the server.
    public let settlementSupported: Bool
    /// The Snooze counterpart of ``settlementSupported``.
    public let snoozeSupported: Bool
    public let handoffScriptSupported: Bool
    /// Whether the row has a workspace path to copy. Absent on a thread whose
    /// worktree has not been provisioned, so the entry is omitted rather than
    /// offered and then reporting nothing to copy.
    public let hasWorktreePath: Bool
    /// The ``hasWorktreePath`` counterpart for the branch entry.
    public let hasBranch: Bool
    /// Version skew: older servers reject `regenerateTitle` outright, so the
    /// action is omitted rather than offered and refused.
    public let titleRegenerationSupported: Bool
    public let isRegeneratingTitle: Bool

    public init(
        isArchived: Bool = false,
        canTogglePin: Bool = true,
        isPinned: Bool = false,
        isSettled: Bool = false,
        isSnoozed: Bool = false,
        canSnooze: Bool = true,
        offersParking: Bool = true,
        settlementSupported: Bool = true,
        snoozeSupported: Bool = true,
        handoffScriptSupported: Bool = true,
        hasWorktreePath: Bool = true,
        hasBranch: Bool = true,
        titleRegenerationSupported: Bool = false,
        isRegeneratingTitle: Bool = false
    ) {
        self.isArchived = isArchived
        self.canTogglePin = canTogglePin
        self.isPinned = isPinned
        self.isSettled = isSettled
        self.isSnoozed = isSnoozed
        self.canSnooze = canSnooze
        self.offersParking = offersParking
        self.settlementSupported = settlementSupported
        self.snoozeSupported = snoozeSupported
        self.handoffScriptSupported = handoffScriptSupported
        self.hasWorktreePath = hasWorktreePath
        self.hasBranch = hasBranch
        self.titleRegenerationSupported = titleRegenerationSupported
        self.isRegeneratingTitle = isRegeneratingTitle
    }
}

public enum ThreadRowMenuActions {
    public static let renameActionID = "rename"
    public static let archiveActionID = "archive"
    public static let restoreActionID = "restore"
    public static let pinActionID = "pin"
    public static let unpinActionID = "unpin"
    public static let settleActionID = "settle"
    public static let unsettleActionID = "unsettle"
    public static let snoozeActionID = "snooze"
    public static let unsnoozeActionID = "unsnooze"
    public static let copyHandoffScriptActionID = "copy-handoff-script"
    public static let deleteActionID = "delete"

    public static let copyActionID = "copy"
    public static let copyPathActionID = "copy-path"
    public static let copyBranchActionID = "copy-branch"
    public static let copyThreadIDActionID = "copy-thread-id"

    /// The copy targets, gathered under one submenu.
    ///
    /// Four flat "Copy …" rows crowded a menu that already carries lifecycle and
    /// naming, and none of them is the thing a long press is usually after. The
    /// child ids are the same ones the row dispatches on, so nesting them costs
    /// the caller nothing. Entries with nothing to copy are omitted rather than
    /// offered and then reporting an empty pasteboard.
    static func copySubmenu(_ context: ThreadRowMenuContext) -> ThreadRowMenuAction {
        var children: [ThreadRowMenuAction] = []
        if context.hasWorktreePath {
            children.append(
                ThreadRowMenuAction(id: copyPathActionID, title: "Path", symbol: "folder")
            )
        }
        if context.hasBranch {
            children.append(
                ThreadRowMenuAction(
                    id: copyBranchActionID,
                    title: "Branch",
                    symbol: "arrow.triangle.branch"
                )
            )
        }
        if context.handoffScriptSupported {
            children.append(
                ThreadRowMenuAction(
                    id: copyHandoffScriptActionID,
                    title: "Handoff script",
                    symbol: "doc.text"
                )
            )
        }
        // The thread id is always copyable, so the submenu is never empty and
        // this branch never collapses the whole section away.
        children.append(
            ThreadRowMenuAction(id: copyThreadIDActionID, title: "Thread ID", symbol: "number")
        )
        return ThreadRowMenuAction(
            id: copyActionID,
            title: "Copy",
            symbol: "doc.on.doc",
            separatorBefore: true,
            children: children
        )
    }

    /// The Home row's long-press menu.
    ///
    /// Four sections, matching the web sidebar: what the thread is doing
    /// (pin, settle, snooze), what it is called (rename, regenerate), what you
    /// can take away from it (the copy submenu), and what removes it. Snooze
    /// opens the shared preset submenu (``SnoozePresets``); `now` anchors the
    /// preset wake times and their labels.
    public static func homeRowActions(
        _ context: ThreadRowMenuContext,
        now: Date = .now
    ) -> [ThreadRowMenuAction] {
        var actions: [ThreadRowMenuAction] = []

        if !context.isArchived {
            if context.canTogglePin {
                actions.append(
                    context.isPinned
                        ? ThreadRowMenuAction(
                            id: unpinActionID, title: "Unpin", symbol: "pin.slash"
                        )
                        : ThreadRowMenuAction(id: pinActionID, title: "Pin", symbol: "pin")
                )
            }
            if context.offersParking, context.settlementSupported {
                actions.append(
                    context.isSettled
                        ? ThreadRowMenuAction(
                            id: unsettleActionID, title: "Reopen", symbol: "arrow.counterclockwise"
                        )
                        : ThreadRowMenuAction(
                            id: settleActionID, title: "Settle", symbol: "checkmark"
                        )
                )
            }
            if context.offersParking, context.snoozeSupported {
                actions.append(
                    context.isSnoozed
                        ? ThreadRowMenuAction(id: unsnoozeActionID, title: "Unsnooze", symbol: "bell")
                        : ThreadRowMenuAction(
                            id: snoozeActionID,
                            title: "Snooze",
                            symbol: "clock",
                            disabled: !context.canSnooze,
                            children: SnoozePresets.resolve(now: now).map { preset in
                                ThreadRowMenuAction(
                                    id: SnoozePresets.actionID(for: preset),
                                    title: preset.label,
                                    subtitle: preset.whenLabel
                                )
                            }
                        )
                )
            }
        }

        // Naming. `separatorBefore` on Rename is inert when the lifecycle
        // section above it is empty, which is exactly the archived row.
        actions.append(
            ThreadRowMenuAction(
                id: renameActionID,
                title: "Rename",
                symbol: "pencil",
                separatorBefore: true
            )
        )
        actions = ThreadRowMenu.withTitleRegenerationAction(
            actions,
            supported: context.titleRegenerationSupported,
            regenerating: context.isRegeneratingTitle,
            after: renameActionID
        )

        actions.append(copySubmenu(context))

        actions.append(
            context.isArchived
                ? ThreadRowMenuAction(
                    id: restoreActionID,
                    title: "Restore",
                    symbol: "arrow.uturn.backward",
                    separatorBefore: true
                )
                : ThreadRowMenuAction(
                    id: archiveActionID,
                    title: "Archive",
                    symbol: "archivebox",
                    separatorBefore: true
                )
        )
        actions.append(
            ThreadRowMenuAction(
                id: deleteActionID,
                title: "Delete",
                symbol: "trash",
                destructive: true
            )
        )
        return actions
    }
}

// MARK: - Copy targets

/// A copy entry's payload. Resolved as data so the pasteboard write stays in the
/// view and the "what does this row actually copy" decision stays testable.
public enum ThreadCopyTarget: String, Sendable, Equatable, CaseIterable {
    case path
    case branch
    case threadID

    public init?(actionID: String) {
        switch actionID {
        case ThreadRowMenuActions.copyPathActionID: self = .path
        case ThreadRowMenuActions.copyBranchActionID: self = .branch
        case ThreadRowMenuActions.copyThreadIDActionID: self = .threadID
        default: return nil
        }
    }
}

public enum ThreadCopy {
    /// The string a copy target puts on the pasteboard, or nil when the thread
    /// carries nothing for it. The menu omits those entries, so nil here means
    /// the row changed between the menu opening and the tap.
    public static func value(for target: ThreadCopyTarget, on thread: FeatureThread) -> String? {
        let raw: String?
        switch target {
        case .path: raw = thread.worktreePath
        case .branch: raw = thread.branch
        // The wire id is what a server-side lookup expects; `id` is only the
        // local identity when the two differ.
        case .threadID: raw = thread.wireID ?? thread.id
        }
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
            !trimmed.isEmpty
        else { return nil }
        return trimmed
    }

    public static func confirmation(for target: ThreadCopyTarget) -> ThreadListActionAlert {
        switch target {
        case .path:
            return ThreadListActionAlert(
                title: "Path copied",
                message: "The thread's workspace path is on the clipboard."
            )
        case .branch:
            return ThreadListActionAlert(
                title: "Branch copied",
                message: "The thread's branch name is on the clipboard."
            )
        case .threadID:
            return ThreadListActionAlert(
                title: "Thread ID copied",
                message: "The thread's identifier is on the clipboard."
            )
        }
    }
}

// MARK: - Execution

/// A message the action asks the view to show. Carried as data so the failure
/// wording is testable and cannot drift between the two clients.
public struct ThreadListActionAlert: Equatable, Sendable {
    public let title: String
    public let message: String

    public init(title: String, message: String) {
        self.title = title
        self.message = message
    }
}

public enum ThreadListActionOutcome: Equatable, Sendable {
    /// The same thread already has this action out. Deliberately silent: the
    /// user pressed twice, and a second alert would be noise.
    case alreadyRunning
    /// The server cannot do this. Distinct from ``failed(_:)`` so a caller can
    /// hide the affordance next time rather than retrying.
    case unsupported(ThreadListActionAlert)
    case failed(ThreadListActionAlert)
    /// The caller puts `script` on the pasteboard and shows `alert`. Keeping the
    /// pasteboard write out here is what lets the whole path be tested.
    case handoffScript(script: String, alert: ThreadListActionAlert)
    /// The server accepted the request. The new title streams in over the shell
    /// subscription, so there is nothing further to await.
    case titleRegenerationRequested
}

/// Serialises the two slow row actions per thread.
///
/// The in-flight key is the thread's own id, which the native client already
/// scopes by environment — so two environments' threads cannot collide the way
/// bare wire ids would.
@MainActor
public final class ThreadListActions {
    public private(set) var inFlightThreadIDs: Set<String> = []

    public init() {}

    public func isRunning(threadID: String) -> Bool {
        inFlightThreadIDs.contains(threadID)
    }

    /// Generates a prompt-ready handoff document for the thread on the server.
    ///
    /// Generation is an AI summary and can take a while; repeat requests for the
    /// same thread are ignored while one is in flight.
    public func copyHandoffScript(
        threadID: String,
        generate: () async throws -> String
    ) async -> ThreadListActionOutcome {
        guard inFlightThreadIDs.insert(threadID).inserted else { return .alreadyRunning }
        defer { inFlightThreadIDs.remove(threadID) }

        do {
            let script = try await generate()
            return .handoffScript(
                script: script,
                alert: ThreadListActionAlert(
                    title: "Handoff script copied",
                    message: "Paste it into a new agent session to continue this thread."
                )
            )
        } catch {
            return .failed(
                ThreadListActionAlert(
                    title: "Could not create handoff script",
                    message: Self.failureMessage(
                        error,
                        fallback: "The handoff script could not be generated."
                    )
                )
            )
        }
    }

    /// Asks the server to rewrite the thread's title from its transcript.
    ///
    /// The capability is checked before the in-flight key is taken: an
    /// unsupported environment never had a request out, so it must not block the
    /// next one.
    public func regenerateTitle(
        threadID: String,
        supported: Bool,
        regenerate: () async throws -> Void
    ) async -> ThreadListActionOutcome {
        guard supported else {
            return .unsupported(
                ThreadListActionAlert(
                    title: "Could not regenerate title",
                    message: """
                        This environment's server does not support title regeneration yet. \
                        Update the server to use it.
                        """
                )
            )
        }
        guard inFlightThreadIDs.insert(threadID).inserted else { return .alreadyRunning }
        defer { inFlightThreadIDs.remove(threadID) }

        do {
            try await regenerate()
            return .titleRegenerationRequested
        } catch {
            return .failed(
                ThreadListActionAlert(
                    title: "Could not regenerate title",
                    message: Self.failureMessage(
                        error,
                        fallback: "The thread title could not be regenerated."
                    )
                )
            )
        }
    }

    /// A server error worth quoting beats a generic sentence; a blank or
    /// placeholder description does not.
    private static func failureMessage(_ error: any Error, fallback: String) -> String {
        let described = error.localizedDescription
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return described.isEmpty ? fallback : described
    }
}
