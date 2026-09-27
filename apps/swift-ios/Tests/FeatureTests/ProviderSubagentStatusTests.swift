import Foundation
import Testing
@testable import T3Code

/// The bar that replaces the composer on a provider-native subagent thread.
/// Its status comes from the runless root turn the provider started, never
/// from a run of the thread, and a finished subagent says how long it took.
@Suite("Provider subagent status")
struct ProviderSubagentStatusTests {
    @Test func readsTheNewestRunlessRootTurn() {
        let status = ProviderSubagentStatus.resolve(
            nodes: [
                node("old", status: "completed"),
                node("run-owned", runId: "run-1", status: "failed"),
                node("tool", kind: "tool_call", status: "running"),
                node("latest", status: "running", startedAt: "2026-09-01T10:00:00.000Z"),
            ],
            parseDate: parse
        )
        #expect(status?.status == "running")
        #expect(status?.isLive == true)
        #expect(status?.summary == "Working")
        #expect(status?.startedAt == parse("2026-09-01T10:00:00.000Z"))
    }

    @Test func isNilUntilTheRootTurnArrives() {
        #expect(ProviderSubagentStatus.resolve(nodes: [node("run-owned", runId: "run-1", status: "running")], parseDate: parse) == nil)
    }

    @Test func aFinishedSubagentSaysHowLongItTook() {
        let completed = ProviderSubagentStatus(
            status: "completed",
            startedAt: Date(timeIntervalSince1970: 0),
            completedAt: Date(timeIntervalSince1970: 34.6)
        )
        #expect(completed.summary == "Completed in 34s")
        #expect(completed.isLive == false)

        let instant = ProviderSubagentStatus(status: "completed", startedAt: Date(timeIntervalSince1970: 0), completedAt: Date(timeIntervalSince1970: 0.2))
        #expect(instant.summary == "Completed in 1.0s")

        #expect(ProviderSubagentStatus(status: "rolled_back", startedAt: nil, completedAt: nil).summary == "Cancelled")
        #expect(ProviderSubagentStatus(status: "completed", startedAt: nil, completedAt: nil).summary == "Completed")
    }

    @Test func onlyAProviderSpawnedSubagentIsReadOnly() {
        var thread = FeatureThread(id: "child", projectID: "project", title: "Child", relationshipToParent: "subagent", creationSource: "provider")
        #expect(thread.isProviderNativeSubagentThread)
        thread.creationSource = "mcp"
        #expect(!thread.isProviderNativeSubagentThread)
        thread = FeatureThread(id: "fork", projectID: "project", title: "Fork", relationshipToParent: "fork", creationSource: "provider")
        #expect(!thread.isProviderNativeSubagentThread)
    }

    private func node(
        _ id: String,
        runId: String? = nil,
        kind: String = "root_turn",
        status: String,
        startedAt: String? = nil
    ) -> OrchestrationV2ExecutionNode {
        OrchestrationV2ExecutionNode(
            id: id,
            runId: runId,
            kind: kind,
            status: status,
            runtimeRequestId: nil,
            startedAt: startedAt,
            completedAt: nil
        )
    }

    private func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }
}
