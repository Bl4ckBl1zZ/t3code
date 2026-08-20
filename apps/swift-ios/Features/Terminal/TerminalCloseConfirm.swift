import Foundation

// Ported from apps/web/src/lib/terminalCloseConfirm.ts and the label helpers in
// packages/shared/src/terminalLabels.ts.
//
// Stopping a terminal kills the running process and drops its scrollback, and
// the phone offers it as a single tap in a menu with no undo. The copy is shared
// with web deliberately: the same destructive action should read the same on
// both clients.

public enum TerminalCloseConfirm {
    /// `term-3` / `terminal-3` read as "Terminal 3"; anything else is already a
    /// name the user chose, so it is left alone.
    public static func label(terminalID: String) -> String {
        let lowered = terminalID.lowercased()
        for prefix in ["term-", "terminal-"] where lowered.hasPrefix(prefix) {
            let suffix = terminalID.dropFirst(prefix.count)
            if !suffix.isEmpty, suffix.allSatisfy(\.isASCII), suffix.allSatisfy(\.isNumber) {
                return "Terminal \(suffix)"
            }
        }
        return terminalID
    }

    /// Prefers the server's own label for the session, falling back to the id.
    public static func label(terminalID: String, sessionTitle: String?) -> String {
        let trimmed = sessionTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmed, !trimmed.isEmpty {
            return trimmed
        }
        return label(terminalID: terminalID)
    }

    public static func title(label: String) -> String {
        "Close terminal “\(label)”?"
    }

    public static let message = "This stops the running process and clears its history."

    public static let confirmActionTitle = "Close"
}
