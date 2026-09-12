import Foundation
import Testing
@testable import T3Code

@Suite("Project action terminal routing")
struct ProjectScriptTerminalPlanTests {
    private func script(singleRun: Bool = true) -> ProjectScript {
        .init(id: "dev", name: "Dev", command: "pnpm dev", icon: "play", runOnWorktreeCreate: false, singleRun: singleRun)
    }
    private func session(_ id: String, busy: Bool, scriptID: String? = nil) throws -> TerminalSummary {
        var fields: [String: Any] = ["threadId": "thread", "terminalId": id, "cwd": "/workspace", "status": "running", "hasRunningSubprocess": busy, "label": "Shell", "updatedAt": "2026-09-12T12:00:00Z"]
        if let scriptID { fields["activeScriptId"] = scriptID }
        return try JSONDecoder().decode(TerminalSummary.self, from: JSONSerialization.data(withJSONObject: fields))
    }
    @Test func readsScriptAttributionFromTheContractFixture() throws {
        struct Fixture: Decodable { let summary: TerminalSummary }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/projectActionTerminal.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        #expect(fixture.summary.activeScriptId == "dev")
        #expect(ProjectScriptTerminalPlan.resolve(script: script(), sessions: [fixture.summary]) == .interrupt(terminalID: "term-2"))
    }
    @Test func stopsOnlyTheAttributedRunningScript() throws {
        let sessions = [try session("term-1", busy: true, scriptID: "test"), try session("term-2", busy: true, scriptID: "dev")]
        #expect(ProjectScriptTerminalPlan.resolve(script: script(), sessions: sessions) == .interrupt(terminalID: "term-2"))
    }
    @Test func interruptsPendingLaunchBeforeMetadataConfirmsIt() throws {
        #expect(ProjectScriptTerminalPlan.resolve(script: script(), sessions: [], pendingTerminalID: "term-3") == .interrupt(terminalID: "term-3"))
    }
    @Test func createsSeparateTerminalWhenEveryShellIsBusy() throws {
        let sessions = [try session("term-1", busy: true), try session("term-2", busy: true)]
        #expect(ProjectScriptTerminalPlan.resolve(script: script(), sessions: sessions) == .launch(terminalID: "term-3"))
    }
    @Test func reusesIdleShellWithoutInterruptingOtherActions() throws {
        let sessions = [try session("term-1", busy: true, scriptID: "test"), try session("term-2", busy: false)]
        #expect(ProjectScriptTerminalPlan.resolve(script: script(), sessions: sessions) == .launch(terminalID: "term-2"))
    }
    @Test func repeatableActionsDoNotBecomeStopButtons() throws {
        let sessions = [try session("term-1", busy: true, scriptID: "dev")]
        #expect(ProjectScriptTerminalPlan.resolve(script: script(singleRun: false), sessions: sessions, pendingTerminalID: "term-1") == .launch(terminalID: "term-2"))
    }
    @Test func staleAttributionDoesNotStopAnIdleShell() throws {
        #expect(ProjectScriptTerminalPlan.resolve(script: script(), sessions: [try session("term-1", busy: false, scriptID: "dev")]) == .launch(terminalID: "term-1"))
    }
}
