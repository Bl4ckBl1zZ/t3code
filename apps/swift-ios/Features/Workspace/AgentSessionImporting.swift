import Foundation

@MainActor
protocol FeatureAgentSessionImporting: AnyObject {
    func scanAgentSessions(environmentID: String) async throws -> AgentSessionScanResult
    func importAgentSessions(environmentID: String, candidate: AgentSessionProjectCandidate, proposedProjectID: String) async throws -> AgentSessionImportResult
}

@MainActor
protocol FeatureAgentSetupTerminal: AnyObject {
    var command: String { get }
    var id: String { get }
    func start() async throws -> AsyncThrowingStream<TerminalEvent, Error>
    func write(_ data: String) async throws
    func resize(columns: Int, rows: Int) async throws
    func clear() async throws
    func close() async
}

@MainActor
protocol FeatureAgentSetupTerminalProviding: AnyObject {
    func refreshSetupProviders(environmentID: String) async throws -> [ServerProviderSnapshot]
    func makeAgentSetupTerminal(environmentID: String, providerInstanceID: String) async throws -> any FeatureAgentSetupTerminal
}
