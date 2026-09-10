import Foundation

/// An isolated setup PTY; never borrows a conversation's terminal or changes its runtime.
@MainActor
final class NativeAgentSetupTerminal: FeatureAgentSetupTerminal {
    let id = "onboarding-" + UUID().uuidString
    let command: String
    private let client: T3Client
    private let cwd: String
    private let providerInstanceID: String
    private let threadID = "onboarding-agent-setup"
    private var closed = false
    private var started = false

    init(client: T3Client, cwd: String, providerInstanceID: String, command: String) {
        self.client = client; self.cwd = cwd; self.providerInstanceID = providerInstanceID; self.command = command
    }
    func start() async throws -> AsyncThrowingStream<TerminalEvent, Error> {
        guard !closed, !started else { throw CancellationError() }
        started = true
        _ = try await client.openTerminal(threadID: threadID, terminalID: id, cwd: cwd, providerInstanceID: providerInstanceID)
        guard !closed, !Task.isCancelled else { await close(); throw CancellationError() }
        // No newline: the user reviews and presses Enter in the terminal.
        try await client.writeTerminal(threadID: threadID, terminalID: id, data: command)
        guard !closed, !Task.isCancelled else { await close(); throw CancellationError() }
        return try await client.attachTerminal(threadID: threadID, terminalID: id)
    }
    func write(_ data: String) async throws { guard !closed else { throw CancellationError() }; try await client.writeTerminal(threadID: threadID, terminalID: id, data: data) }
    func resize(columns: Int, rows: Int) async throws { guard !closed else { return }; try await client.resizeTerminal(threadID: threadID, terminalID: id, columns: columns, rows: rows) }
    func clear() async throws { try await client.clearTerminal(threadID: threadID, terminalID: id) }
    func close() async {
        closed = true
        try? await client.closeTerminal(threadID: threadID, terminalID: id, deleteHistory: true)
    }
}
