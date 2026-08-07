import Foundation

// Ported from apps/mobile/src/features/threads/threadRowMenu.ts.
//
// The menu is assembled as data rather than as `UIMenu` children so the one
// decision worth testing — whether the action appears at all, and where — is
// separable from UIKit. The view layer maps a row onto `UIAction`.

public struct ThreadRowMenuAction: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    /// SF Symbol name.
    public let symbol: String?
    public let disabled: Bool
    public let destructive: Bool

    public init(
        id: String,
        title: String,
        symbol: String? = nil,
        disabled: Bool = false,
        destructive: Bool = false
    ) {
        self.id = id
        self.title = title
        self.symbol = symbol
        self.disabled = disabled
        self.destructive = destructive
    }
}

public enum ThreadRowMenu {
    /// Long-press menu event id for the AI title regeneration action.
    public static let regenerateTitleActionID = "regenerate-title"

    /// Delete is the anchor rather than "last": a menu may grow trailing items,
    /// and the destructive one has to stay at the bottom.
    private static let deleteActionID = "delete"

    /// Adds "Regenerate title" to a thread row's long-press menu, mirroring the
    /// web sidebar. The action is omitted entirely on servers without the
    /// `threadTitleRegeneration` capability (version skew: the command would be
    /// rejected), and disabled while the server-side marker says a regeneration
    /// is already in flight.
    ///
    /// It sits directly above Delete so the destructive item stays last.
    public static func withTitleRegenerationAction(
        _ actions: [ThreadRowMenuAction],
        supported: Bool,
        regenerating: Bool
    ) -> [ThreadRowMenuAction] {
        guard supported else { return actions }
        let action = ThreadRowMenuAction(
            id: regenerateTitleActionID,
            title: regenerating ? "Regenerating…" : "Regenerate title",
            symbol: "sparkles",
            disabled: regenerating
        )
        guard let deleteIndex = actions.firstIndex(where: { $0.id == deleteActionID }) else {
            return actions + [action]
        }
        var merged = actions
        merged.insert(action, at: deleteIndex)
        return merged
    }
}
