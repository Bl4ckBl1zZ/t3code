import XCTest
@testable import T3Code

final class ProviderWorkspaceScanTests: XCTestCase {
    private func fixture() throws -> ServerProviderSnapshot {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/providerWorkspaceSnapshots.json")
        return try JSONDecoder().decode(ServerProviderSnapshot.self, from: Data(contentsOf: url))
    }

    func testWorkspaceSnapshotsDecodeThePendingFlag() throws {
        let provider = try fixture()
        let complete = try XCTUnwrap(provider.workspaceSnapshots?.first { $0.cwd == "/work/app" })
        let pending = try XCTUnwrap(provider.workspaceSnapshots?.first { $0.cwd == "/work/app-feature" })
        XCTAssertNil(complete.slashCommandsPending)
        XCTAssertEqual(complete.slashCommands.first?.input?.hint, "env")
        XCTAssertEqual(complete.skills.first?.scope, "project")
        XCTAssertEqual(pending.slashCommandsPending, true)
        XCTAssertEqual(pending.slashCommands.map(\.name), ["deploy"])
    }

    func testScansUnscannedAndPendingWorkspacesOfAnInstalledInstance() throws {
        let provider = try fixture()
        XCTAssertFalse(ProviderWorkspaceScan.needsScan(provider, cwd: "/work/app"))
        XCTAssertTrue(ProviderWorkspaceScan.needsScan(provider, cwd: "/work/app-feature"))
        XCTAssertTrue(ProviderWorkspaceScan.needsScan(provider, cwd: "/work/other"))
        XCTAssertFalse(ProviderWorkspaceScan.needsScan(nil, cwd: "/work/other"))
    }

    func testDoesNotScanAMissingOrDisabledInstance() throws {
        var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(fixture())) as! [String: Any]
        json["installed"] = false
        let missing = try JSONDecoder().decode(ServerProviderSnapshot.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertFalse(ProviderWorkspaceScan.needsScan(missing, cwd: "/work/other"))
        XCTAssertFalse(ProviderWorkspaceScan.shouldRetry(after: missing, cwd: "/work/app-feature"))
        json["installed"] = true
        json["enabled"] = false
        let disabled = try JSONDecoder().decode(ServerProviderSnapshot.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertFalse(ProviderWorkspaceScan.needsScan(disabled, cwd: "/work/other"))
    }

    func testRetriesOnlyAPendingScan() throws {
        let provider = try fixture()
        XCTAssertTrue(ProviderWorkspaceScan.shouldRetry(after: provider, cwd: "/work/app-feature"))
        XCTAssertFalse(ProviderWorkspaceScan.shouldRetry(after: provider, cwd: "/work/app"))
        // A scan that stored nothing (no workspace discovery, an older server)
        // waits for the composer to open again.
        XCTAssertFalse(ProviderWorkspaceScan.shouldRetry(after: provider, cwd: "/work/other"))
    }

    func testComposerUsesAPendingEntryButKeepsAskingForIt() {
        var provider = FeatureProvider(
            id: "claude-work",
            name: "Claude",
            slashCommands: [FeatureProviderSlashCommand(name: "compact", description: nil, inputHint: nil)]
        )
        provider.workspaceSnapshots = [
            FeatureProviderWorkspace(
                cwd: "/work/app-feature",
                slashCommands: [FeatureProviderSlashCommand(name: "deploy", description: nil, inputHint: nil)],
                skills: [],
                slashCommandsPending: true
            ),
            FeatureProviderWorkspace(cwd: "/work/app", slashCommands: [], skills: []),
        ]
        XCTAssertEqual(provider.inWorkspace("/work/app-feature").slashCommands?.map(\.name), ["deploy"])
        XCTAssertFalse(provider.hasCompleteWorkspace("/work/app-feature"))
        XCTAssertTrue(provider.hasCompleteWorkspace("/work/app"))
        XCTAssertFalse(provider.hasCompleteWorkspace("/work/other"))
        // Unscanned workspaces fall back to the machine lists.
        XCTAssertEqual(provider.inWorkspace("/work/other").slashCommands?.map(\.name), ["compact"])
    }
}
