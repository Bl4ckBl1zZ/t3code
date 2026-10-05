import XCTest

@testable import T3Code

/// "No project": a machine offers it when it is connected and its server names
/// a Scratch folder, and the Scratch project is that machine's project at
/// the folder.
final class NewTaskScratchProjectTests: XCTestCase {
    private func config(_ environmentID: String, scratch: String?) -> MobileWorkspaceEnvironmentConfig {
        var config = MobileWorkspaceEnvironmentConfig(environmentID: environmentID, t3WorkDirectory: nil, providers: [])
        config.scratchWorkspaceRoot = scratch
        return config
    }

    func testOffersNoProjectOnConnectedMachinesWithAScratchFolder() {
        let snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(id: "home", name: "Home", endpoint: "https://home.example", isActive: true, connectionState: .connected),
                .init(id: "old", name: "Old", endpoint: "https://old.example", connectionState: .connected),
                .init(id: "away", name: "Away", endpoint: "https://away.example", connectionState: .disconnected),
            ]
        )
        let configs = [
            config("home", scratch: "/data/scratch"),
            config("old", scratch: nil),
            config("away", scratch: "/away/scratch"),
        ]
        XCTAssertEqual(
            DailyUXCreationContext.scratchEnvironments(in: snapshot, serverConfigs: configs).map(\.id),
            ["home"]
        )
    }

    func testRecognizesTheScratchProjectByMachineAndFolder() {
        let configs = [config("home", scratch: "/data/scratch/")]
        let scratch = FeatureProject(id: "s", environmentID: "home", name: "Scratch", path: "/data/scratch")
        let twin = FeatureProject(id: "t", environmentID: "other", name: "Scratch", path: "/data/scratch")
        let app = FeatureProject(id: "a", environmentID: "home", name: "App", path: "/code/app")
        XCTAssertTrue(DailyUXCreationContext.isScratchProject(scratch, serverConfigs: configs))
        XCTAssertFalse(DailyUXCreationContext.isScratchProject(twin, serverConfigs: configs))
        XCTAssertFalse(DailyUXCreationContext.isScratchProject(app, serverConfigs: configs))
        XCTAssertFalse(DailyUXCreationContext.isScratchProject(scratch, serverConfigs: []))
    }

    func testDecodesTheScratchFolderAndTheEnsureScratchReply() throws {
        let config = try JSONDecoder().decode(
            ServerConfigSnapshot.self,
            from: Data(#"{"providers":[],"scratchWorkspaceRoot":"/data/scratch"}"#.utf8)
        )
        XCTAssertEqual(config.scratchWorkspaceRoot, "/data/scratch")
        let older = try JSONDecoder().decode(ServerConfigSnapshot.self, from: Data(#"{"providers":[]}"#.utf8))
        XCTAssertNil(older.scratchWorkspaceRoot)

        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("CoreTests/Fixtures/scratchProject.json")
        let result = try JSONDecoder().decode(ProjectEnsureScratchResult.self, from: Data(contentsOf: url))
        XCTAssertEqual(result.projectId, "project-scratch")
    }
}
