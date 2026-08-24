import Foundation

/// The `/feedback` composer command, which hands the thread to the provider
/// rather than to the agent.
///
/// Codex advertises `feedback` as an ordinary provider slash command, so it
/// already reaches the composer menu on its own. Without this the text would be
/// sent to the agent as a message — the command has to be recognised before the
/// send path, exactly as the web client recognises it.
///
/// Mirrors `parseCodexFeedbackCommand` in
/// `packages/client-runtime/src/state/threadFeedback.ts`.
enum ProviderFeedbackCommand {
    /// The command's name on the wire, and the name the provider advertises.
    static let name = "feedback"

    /// A recognised `/feedback`. The reason is what the reader typed after the
    /// command, and is absent when they typed nothing — Codex accepts a report
    /// with no note, so "no reason" is still the command.
    struct Parsed: Equatable {
        let reason: String?
    }

    /// Parses `text` as this command, or nil when it is an ordinary message.
    static func parse(_ text: String) -> Parsed? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = "/\(name)"
        let lowered = trimmed.lowercased()
        // A bare command, or the command followed by whitespace. Anything else
        // — `/feedbackloop`, `/feedback-ci` — is a different word.
        guard lowered == prefix || lowered.dropFirst(prefix.count).first?.isWhitespace == true,
              lowered.hasPrefix(prefix) else {
            return nil
        }
        let reason = trimmed
            .dropFirst(prefix.count)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Parsed(reason: reason.isEmpty ? nil : reason)
    }

    /// Whether this thread's provider offers feedback uploads. A thread running
    /// anything else keeps `/feedback` as ordinary text, because there is
    /// nowhere to send it.
    static func isSupported(by slashCommands: [FeatureProviderSlashCommand]) -> Bool {
        slashCommands.contains { $0.name.lowercased() == name }
    }
}
