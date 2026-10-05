import XCTest

@testable import T3Code

/// Ports the `resolveSubagentMetadata` and `subagentDetailPreview` cases from
/// packages/client-runtime/src/state/subagentDisplay.test.ts, plus the account
/// badge rule from apps/web/src/providerInstances.ts.
final class SubagentMetadataTests: XCTestCase {
    private func model(
        slug: String,
        name: String,
        shortName: String? = nil,
        subProvider: String? = nil,
        aliases: [String]? = nil,
        isCustom: Bool = false
    ) -> ServerProviderModelSnapshot {
        ServerProviderModelSnapshot(
            aliases: aliases,
            slug: slug,
            name: name,
            shortName: shortName,
            subProvider: subProvider,
            isCustom: isCustom,
            isDefault: nil,
            isLegacy: nil,
            capabilities: nil
        )
    }

    func testResolvesCatalogNamesThroughAliasesAndDropsTheSubProviderQualifier() {
        let haiku = model(
            slug: "claude-haiku-4-5",
            name: "Claude Haiku 4.5",
            shortName: "Haiku 4.5",
            aliases: ["claude-haiku-4-5-20251001"]
        )
        XCTAssertEqual(
            ThreadLifecycle.resolveSubagentMetadata(
                model: "claude-haiku-4-5-20251001",
                provider: ("claudeAgent", [haiku])
            ).modelLabel,
            "Haiku 4.5"
        )
        let custom = model(
            slug: "my-model",
            name: "Cloud+ / My custom model",
            subProvider: "Cloud+",
            isCustom: true
        )
        XCTAssertEqual(
            ThreadLifecycle.resolveSubagentMetadata(
                model: "my-model",
                provider: ("acpRegistry", [custom])
            ).modelLabel,
            "My custom model"
        )
    }

    func testKeepsUnknownModelsAndNeverInventsOne() {
        XCTAssertEqual(ThreadLifecycle.resolveSubagentMetadata(model: " custom/model ").modelLabel, "custom/model")
        XCTAssertEqual(
            ThreadLifecycle.resolveSubagentMetadata(model: nil, provider: ("codex", [])).modelLabel,
            "Not reported"
        )
        XCTAssertEqual(ThreadLifecycle.resolveSubagentMetadata(model: " ").modelLabel, "Not reported")
        // Uncatalogued slugs still read as names where the family is known.
        XCTAssertEqual(ThreadLifecycle.resolveSubagentMetadata(model: "claude-opus-4-6").modelLabel, "Claude Opus 4.6")
        XCTAssertEqual(ThreadLifecycle.resolveSubagentMetadata(model: "gpt-5.4-mini").modelLabel, "GPT-5.4-Mini")
    }

    private let parentThread = ThreadLifecycle.SubagentWorkspaceThread(projectID: "parent")
    private let parentProject = ThreadLifecycle.SubagentWorkspaceProject(
        id: "parent", title: "Parent", workspaceRoot: "/repo"
    )

    func testShowsAnotherProjectAndItsBranch() {
        let workspace = ThreadLifecycle.resolveSubagentMetadata(
            model: nil,
            parentThread: parentThread,
            childThread: .init(projectID: "child", branch: "fix/agents", worktreePath: "/worktrees/agents"),
            parentProject: parentProject,
            childProject: .init(id: "child", title: "Other project", workspaceRoot: "/other")
        ).workspace
        XCTAssertEqual(workspace, [
            .init(label: "Project", value: "Other project"),
            .init(label: "Branch", value: "fix/agents"),
        ])
    }

    func testLabelsADetachedWorktreeOrAnotherWorkspaceWithoutABranch() {
        XCTAssertEqual(
            ThreadLifecycle.resolveSubagentMetadata(
                model: nil,
                parentThread: parentThread,
                childThread: .init(projectID: "parent", worktreePath: "/worktrees/agents"),
                parentProject: parentProject
            ).workspace,
            [.init(label: "Worktree", value: "agents")]
        )
        XCTAssertEqual(
            ThreadLifecycle.resolveSubagentMetadata(
                model: nil,
                parentThread: parentThread,
                parentProject: parentProject,
                childProject: .init(id: "parent", title: "Same project", workspaceRoot: "/other")
            ).workspace,
            [.init(label: "Workspace", value: "other")]
        )
    }

    func testHidesRedundantWorkspaceFacts() {
        XCTAssertEqual(
            ThreadLifecycle.resolveSubagentMetadata(
                model: nil,
                parentThread: parentThread,
                childThread: .init(projectID: "parent", branch: "main", worktreePath: "/repo"),
                parentProject: parentProject,
                childProject: parentProject
            ).workspace,
            []
        )
        XCTAssertEqual(
            ThreadLifecycle.resolveSubagentMetadata(
                model: nil, parentThread: parentThread, parentProject: parentProject
            ).workspace,
            []
        )
    }

    func testNamesTheAccountOnlyWhenOneProviderHasSeveral() {
        XCTAssertFalse(ProviderAccountBadge.shows(driver: "codex", accentColor: nil, amongDrivers: ["codex", "claudeAgent"]))
        XCTAssertTrue(ProviderAccountBadge.shows(driver: "codex", accentColor: nil, amongDrivers: ["codex", "codex"]))
        // A configured accent is the user asking to tell this instance apart.
        XCTAssertTrue(ProviderAccountBadge.shows(driver: "codex", accentColor: "#22c55e", amongDrivers: ["codex"]))
        XCTAssertFalse(ProviderAccountBadge.shows(driver: "codex", accentColor: "green", amongDrivers: ["codex"]))
        XCTAssertNil(ProviderAccountBadge.normalizedAccent("#12345"))
        XCTAssertEqual(ProviderAccountBadge.normalizedAccent(" #A1b2C3 "), "#A1b2C3")
    }

    func testDetailLeadsWithProgressWhileLiveAndResultOnceSettled() {
        XCTAssertEqual(
            ThreadLifecycle.subagentDetailPreview(status: .running, progress: "Reading", result: "Done"),
            "Reading"
        )
        XCTAssertEqual(
            ThreadLifecycle.subagentDetailPreview(status: .completed, progress: "Reading", result: "Done\n\nall  good"),
            "Done all good"
        )
        XCTAssertNil(ThreadLifecycle.subagentDetailPreview(status: .completed, progress: " ", result: nil))
        let long = String(repeating: "word ", count: 100)
        let preview = try? XCTUnwrap(ThreadLifecycle.subagentDetailPreview(status: .running, progress: long, result: nil))
        XCTAssertEqual(preview?.count, 280)
        XCTAssertEqual(preview?.hasSuffix("word…"), true)
    }
}
