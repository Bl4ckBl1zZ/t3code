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
    public let handoffScriptSupported: Bool
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
        handoffScriptSupported: Bool = true,
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
        self.handoffScriptSupported = handoffScriptSupported
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

    /// Adds "Copy handoff script" directly above Delete, the slot every React
    /// Native row menu puts it in. Anchoring on Delete rather than on "last"
    /// keeps the destructive item at the bottom as the menu grows.
    public static func withHandoffScriptAction(
        _ actions: [ThreadRowMenuAction]
    ) -> [ThreadRowMenuAction] {
        let action = ThreadRowMenuAction(
            id: copyHandoffScriptActionID,
            title: "Copy handoff script",
            symbol: "doc.on.doc"
        )
        guard let deleteIndex = actions.firstIndex(where: { $0.id == deleteActionID }) else {
            return actions + [action]
        }
        var merged = actions
        merged.insert(action, at: deleteIndex)
        return merged
    }

    /// The Home row's long-press menu.
    ///
    /// Lifecycle first, then the two server-side actions, then Delete. Snooze
    /// opens the shared preset submenu (``SnoozePresets``), mirroring the web
    /// sidebar and the React Native rows; `now` anchors the preset wake times
    /// and their labels.
    public static func homeRowActions(
        _ context: ThreadRowMenuContext,
        now: Date = .now
    ) -> [ThreadRowMenuAction] {
        var actions: [ThreadRowMenuAction] = [
            ThreadRowMenuAction(id: renameActionID, title: "Rename", symbol: "pencil"),
        ]

        if context.isArchived {
            actions.append(
                ThreadRowMenuAction(
                    id: restoreActionID,
                    title: "Restore",
                    symbol: "arrow.uturn.backward"
                )
            )
        } else {
            actions.append(
                ThreadRowMenuAction(id: archiveActionID, title: "Archive", symbol: "archivebox")
            )
            if context.canTogglePin {
                actions.append(
                    context.isPinned
                        ? ThreadRowMenuAction(
                            id: unpinActionID, title: "Unpin", symbol: "pin.slash"
                        )
                        : ThreadRowMenuAction(id: pinActionID, title: "Pin", symbol: "pin")
                )
            }
            if context.offersParking {
                actions.append(
                    context.isSettled
                        ? ThreadRowMenuAction(
                            id: unsettleActionID, title: "Reopen", symbol: "arrow.counterclockwise"
                        )
                        : ThreadRowMenuAction(id: settleActionID, title: "Settle", symbol: "checkmark")
                )
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

        actions.append(
            ThreadRowMenuAction(
                id: deleteActionID,
                title: "Delete",
                symbol: "trash",
                destructive: true
            )
        )

        // Both insert above Delete, so handoff lands first and regeneration
        // second — the order the React Native menus produce.
        if context.handoffScriptSupported {
            actions = withHandoffScriptAction(actions)
        }
        return ThreadRowMenu.withTitleRegenerationAction(
            actions,
            supported: context.titleRegenerationSupported,
            regenerating: context.isRegeneratingTitle
        )
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
