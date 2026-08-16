import Foundation

// Ported from apps/mobile/src/lib/hermesChatCommands.ts.

/// A slash command a T3 Work conversation handles locally instead of sending to
/// Hermes. Mirrors the web composer: `/new` and `/reset` start a fresh-context
/// conversation, `/clear` wipes the visible timeline.
public enum HermesChatCommand: Sendable, Equatable {
    case freshChat
    case clearTimeline
}

public enum HermesChatCommands {
    public static func isFreshChatCommand(text: String, isHermesConversation: Bool) -> Bool {
        isCommand(text, isHermesConversation: isHermesConversation, names: ["/new", "/reset"])
    }

    public static func isClearChatCommand(text: String, isHermesConversation: Bool) -> Bool {
        isCommand(text, isHermesConversation: isHermesConversation, names: ["/clear"])
    }

    /// Single entry point for the composer: which local command, if any, this
    /// text is.
    public static func resolve(text: String, isHermesConversation: Bool) -> HermesChatCommand? {
        if isFreshChatCommand(text: text, isHermesConversation: isHermesConversation) {
            return .freshChat
        }
        if isClearChatCommand(text: text, isHermesConversation: isHermesConversation) {
            return .clearTimeline
        }
        return nil
    }

    /// Only the bare command is intercepted — `/new plan the week` is a real
    /// message, and swallowing the trailing text would silently discard it.
    /// The TypeScript side spells this as an anchored case-insensitive regex,
    /// which on a trimmed string is exactly this equality check.
    private static func isCommand(
        _ text: String,
        isHermesConversation: Bool,
        names: Set<String>
    ) -> Bool {
        guard isHermesConversation else { return false }
        return names.contains(
            text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        )
    }
}
