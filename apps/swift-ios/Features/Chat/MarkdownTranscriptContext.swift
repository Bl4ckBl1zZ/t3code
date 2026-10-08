import Observation
import SwiftUI

/// What Markdown in a thread transcript can do beyond rendering: name the
/// thread's skills, run a shell block in the thread's terminal, and remember
/// which `<details>` sections the reader opened. Observable, because transcript
/// cells are configured once and must still follow the thread as its provider
/// skills load or its terminal permission resolves.
///
/// Nil everywhere else Markdown renders (pull requests, files, plan cards), so
/// those surfaces offer none of it.
@MainActor @Observable
final class MarkdownTranscriptContext {
    var skills: MarkdownSkillCatalog?
    /// Types a command into the thread's terminal and shows it. Nil when the
    /// thread has no workspace, the connection is offline, or it may only
    /// watch terminals.
    var runShellCommand: ((String) -> Void)?
    var isRunningShellCommand = false
    let detailsExpansion = MarkdownDetailsExpansion()
}

private struct MarkdownTranscriptContextKey: EnvironmentKey {
    static let defaultValue: MarkdownTranscriptContext? = nil
}

extension EnvironmentValues {
    var markdownTranscriptContext: MarkdownTranscriptContext? {
        get { self[MarkdownTranscriptContextKey.self] }
        set { self[MarkdownTranscriptContextKey.self] = newValue }
    }
}

/// Keeps a thread screen's `MarkdownTranscriptContext` current. A shell block
/// runs the way the web client's code-block button does: as an unnamed project
/// action, so it reuses an idle terminal or opens a new one in the thread's
/// workspace, then the terminal is presented with the command running.
struct MarkdownTranscriptContextModifier: ViewModifier {
    let context: MarkdownTranscriptContext
    let client: any FeatureClient
    let threadID: String
    let skills: [FeatureProviderSkill]
    /// The thread has a workspace and its environment is connected.
    let canRunCommands: Bool
    let onTerminalStarted: (String) -> Void

    /// Nil until the session answers; the button stays hidden rather than
    /// appearing for a connection that turns out to only watch terminals.
    @State private var terminalIsReadOnly: Bool?
    @State private var failure: String?

    func body(content: Content) -> some View {
        content
            .task(id: threadID) {
                terminalIsReadOnly = await client.terminalIsReadOnly(threadID: threadID)
            }
            .onChange(of: skills, initial: true) {
                context.skills = skills.isEmpty ? nil : MarkdownSkillCatalog(skills)
            }
            .onChange(of: canRunCommands && terminalIsReadOnly == false, initial: true) { _, enabled in
                context.runShellCommand = enabled ? run : nil
            }
            .alert(
                "Couldn’t Run Command",
                isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
            ) {
                Button("OK") { failure = nil }
            } message: {
                Text(failure ?? "")
            }
    }

    private func run(_ command: String) {
        guard !context.isRunningShellCommand else { return }
        context.isRunningShellCommand = true
        let script = ProjectScript(
            id: "chat-code-block",
            name: "Chat code block",
            command: command,
            icon: "play",
            runOnWorktreeCreate: false
        )
        Task {
            defer { context.isRunningShellCommand = false }
            do {
                if let terminalID = try await client.performProjectScript(threadID: threadID, script: script) {
                    onTerminalStarted(terminalID)
                }
            } catch is CancellationError {
            } catch {
                failure = error.localizedDescription
                PlatformHapticEngine.shared.play(.error)
            }
        }
    }
}
