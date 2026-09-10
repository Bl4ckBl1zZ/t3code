import Foundation
import Testing
@testable import T3Code

@Suite("Agent session contracts")
struct AgentSessionContractTests {
    private struct Fixture: Decodable { let scan: AgentSessionScanResult; let imported: AgentSessionImportResult; let capabilities: EnvironmentDescriptor.Capabilities }
    private func fixture() throws -> Fixture {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/agentSessions.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }
    @Test func decodesTheRealWireSchema() throws {
        let value = try fixture()
        #expect(value.scan.truncated == true)
        #expect(value.scan.candidates[0].sources == ["codex", "claudeAgent"])
        #expect(value.scan.candidates[0].git?.repository == "team/app")
        #expect(value.scan.candidates[1].projectId == "project-notes")
        #expect(value.imported.importedCount == 3)
        #expect(value.imported.skippedCount == 1)
        #expect(value.capabilities.agentSessionImport == true)
        #expect(value.capabilities.providerTerminalEnvironment == true)
        let legacy = try JSONDecoder().decode(EnvironmentDescriptor.Capabilities.self, from: Data("{}".utf8))
        #expect(legacy.agentSessionImport == nil)
        #expect(legacy.providerTerminalEnvironment == nil)
    }
    @Test func defaultsToRecentRepositoriesAndPreservesOlderServersWithoutGitMetadata() throws {
        let candidates = try fixture().scan.candidates
        let now = try #require(AgentSessionProjectCandidate.activityDate("2026-09-10T13:00:00Z"))
        #expect(candidates.map { $0.selectedByDefault(now: now) } == [true, false, true])
        #expect(candidates[1].reportsGitIdentity)
        #expect(!candidates[2].reportsGitIdentity)
    }
    @Test func oldAndFutureActivityIsNeverPreselected() throws {
        let candidate = try fixture().scan.candidates[0]
        let before = try #require(AgentSessionProjectCandidate.activityDate("2026-09-01T13:00:00Z"))
        #expect(!candidate.selectedByDefault(now: before))
        #expect(!candidate.selectedByDefault(now: before.addingTimeInterval(50 * 86_400)))
    }
}

@Suite("Agent setup commands")
struct AgentSetupCommandTests {
    @Test func selectsInstallersForTheServerPlatform() {
        #expect(AgentSetupCommand.resolve(driver: "codex", installed: false, binaryPath: nil, platform: "windows") == "irm https://chatgpt.com/codex/install.ps1 | iex")
        #expect(AgentSetupCommand.resolve(driver: "claudeAgent", installed: false, binaryPath: nil, platform: "darwin") == "curl -fsSL https://claude.ai/install.sh | bash")
        #expect(AgentSetupCommand.resolve(driver: "hermes", installed: false, binaryPath: nil, platform: "darwin") == nil)
    }
    @Test func quotesTheChosenAccountBinaryWithoutSubmittingIt() {
        #expect(AgentSetupCommand.resolve(driver: "codex", installed: true, binaryPath: "C:\\Agent Files\\codex.exe", platform: "windows") == "& 'C:\\Agent Files\\codex.exe' login")
        #expect(AgentSetupCommand.resolve(driver: "claudeAgent", installed: true, binaryPath: "~/Agent Files/claude", platform: "darwin") == "~/'Agent Files/claude' auth login")
        #expect(AgentSetupCommand.resolve(driver: "codex", installed: true, binaryPath: "/tools/it's codex", platform: "linux") == "'/tools/it'\"'\"'s codex' login")
    }
}
