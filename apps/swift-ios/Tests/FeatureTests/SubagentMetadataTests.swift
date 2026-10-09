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

    // MARK: Traits

    /// Ports the `resolveSubagentModelTraits` cases from
    /// apps/web/src/components/chat/threadModelBadge.test.ts.
    private let serviceTier = FeatureModelOptionDescriptor(
        id: "serviceTier",
        label: "Service Tier",
        kind: .select,
        choices: [
            .init(id: "default", label: "Standard", isDefault: true),
            .init(id: "priority", label: "Fast"),
            .init(id: "ultrafast", label: "Ultrafast"),
            .init(id: "flex", label: "Flex"),
        ],
        defaultValue: .string("priority")
    )
    private let fastMode = FeatureModelOptionDescriptor(
        id: "fastMode", label: "Fast Mode", kind: .boolean, defaultValue: .boolean(true)
    )
    private let reasoning = FeatureModelOptionDescriptor(
        id: "reasoningEffort",
        label: "Reasoning",
        kind: .select,
        choices: [.init(id: "medium", label: "Medium", isDefault: true), .init(id: "high", label: "High")],
        defaultValue: .string("medium")
    )

    private func provider(_ driver: String, _ descriptors: [FeatureModelOptionDescriptor]) -> FeatureProvider {
        FeatureProvider(
            id: "codex",
            name: "Codex",
            driver: driver,
            models: [FeatureModel(id: "gpt-5.4", name: "My GPT", options: [reasoning] + descriptors)]
        )
    }

    private func traits(
        origin: String = "app_owned",
        model: String? = "gpt-5.4",
        selection: FeatureSelection? = FeatureSelection(providerID: "codex", modelID: "gpt-5.4"),
        provider: FeatureProvider?
    ) -> SubagentModelTraits? {
        ThreadLifecycle.resolveSubagentModelTraits(
            origin: origin,
            model: model,
            providerInstanceID: "codex",
            childSelection: selection,
            provider: provider
        )
    }

    func testNamesTheEffortAndOnlyASavedSpeedOfAT3OwnedSubagent() {
        let cases: [(String, FeatureModelOptionDescriptor, FeatureModelOptionValue?, SubagentModelTraits.Speed?)] = [
            ("codex", serviceTier, .string("default"), nil),
            ("codex", serviceTier, .string("priority"), .fast),
            ("codex", serviceTier, .string("ultrafast"), .ultrafast),
            ("codex", serviceTier, .string("flex"), nil),
            ("codex", serviceTier, .string("unknown"), nil),
            ("codex", serviceTier, .boolean(true), nil),
            // The descriptor defaults to Fast, but a default is not a choice.
            ("codex", serviceTier, nil, nil),
            ("claudeAgent", fastMode, .boolean(true), .fast),
            ("claudeAgent", fastMode, .boolean(false), nil),
            ("cursor", fastMode, .string("true"), nil),
            // Only Codex reports speed as a service tier.
            ("cursor", serviceTier, .string("priority"), nil),
        ]
        for (driver, descriptor, value, expected) in cases {
            let options = [FeatureModelOptionSelection(id: "reasoningEffort", value: .string("high"))]
                + (value.map { [FeatureModelOptionSelection(id: descriptor.id, value: $0)] } ?? [])
            XCTAssertEqual(
                traits(
                    selection: FeatureSelection(providerID: "codex", modelID: "gpt-5.4", options: options),
                    provider: provider(driver, [descriptor])
                ),
                SubagentModelTraits(effort: "High", speed: expected),
                "\(driver) \(descriptor.id)=\(String(describing: value))"
            )
        }
    }

    func testResolvesASubagentModelReportedByDisplayName() {
        XCTAssertEqual(
            traits(
                model: "my gpt",
                selection: FeatureSelection(
                    providerID: "codex",
                    modelID: "gpt-5.4",
                    options: [.init(id: "fastMode", value: .boolean(true))]
                ),
                provider: provider("claudeAgent", [fastMode])
            ),
            // Unsaved effort falls back to the model's default, as the chip does.
            SubagentModelTraits(effort: "Medium", speed: .fast)
        )
    }

    func testClaimsNothingForASelectionTheSubagentDoesNotRunOn() {
        let options: [FeatureModelOptionSelection] = [
            .init(id: "reasoningEffort", value: .string("high")),
            .init(id: "serviceTier", value: .string("priority")),
        ]
        let entry = provider("codex", [serviceTier])
        let selection = FeatureSelection(providerID: "codex", modelID: "gpt-5.4", options: options)
        XCTAssertNotNil(traits(selection: selection, provider: entry))
        XCTAssertNil(traits(origin: "provider_native", selection: selection, provider: entry))
        XCTAssertNil(traits(model: nil, selection: selection, provider: entry))
        XCTAssertNil(traits(model: " ", selection: selection, provider: entry))
        XCTAssertNil(traits(model: "gpt-5.5", selection: selection, provider: entry))
        XCTAssertNil(traits(
            selection: FeatureSelection(providerID: "other", modelID: "gpt-5.4", options: options),
            provider: entry
        ))
        XCTAssertNil(traits(
            selection: FeatureSelection(providerID: "codex", modelID: "gpt-5.5", options: options),
            provider: entry
        ))
        XCTAssertNil(traits(selection: nil, provider: entry))
    }

    func testUsesTheSelectionTheProviderReportedForAnySubagentAfterItCompletes() throws {
        let entry = provider("codex", [serviceTier])
        let reported = FeatureSelection(
            providerID: "codex",
            modelID: "gpt-5.4",
            options: [
                .init(id: "reasoningEffort", value: .string("high")),
                .init(id: "serviceTier", value: .string("ultrafast")),
            ]
        )
        // A provider-native child mirrors the parent; a stale child selection loses.
        let stale = FeatureSelection(
            providerID: "codex",
            modelID: "gpt-5.4",
            options: [.init(id: "reasoningEffort", value: .string("medium"))]
        )
        for origin in ["provider_native", "app_owned"] {
            XCTAssertEqual(
                ThreadLifecycle.resolveSubagentModelTraits(
                    origin: origin,
                    model: "gpt-5.4",
                    providerInstanceID: "codex",
                    reportedSelection: reported,
                    childSelection: stale,
                    provider: entry
                ),
                SubagentModelTraits(effort: "High", speed: .ultrafast),
                origin
            )
        }
        // A reported selection on another model still does not describe this agent.
        XCTAssertNil(ThreadLifecycle.resolveSubagentModelTraits(
            origin: "provider_native",
            model: "gpt-5.4",
            providerInstanceID: "codex",
            reportedSelection: FeatureSelection(providerID: "codex", modelID: "gpt-5.5", options: reported.options),
            childSelection: nil,
            provider: entry
        ))

        // The wire field is optional, so older servers still decode.
        let base = #""id":"sub-1","threadId":"t","childThreadId":null,"title":null,"origin":"provider_native","status":"completed","progress":null,"result":null,"workflow":null,"usage":null,"model":"gpt-5.4""#
        let legacy = try JSONDecoder().decode(
            OrchestrationV2Subagent.self,
            from: Data("{\(base)}".utf8)
        )
        XCTAssertNil(legacy.modelSelection)
        let current = try JSONDecoder().decode(
            OrchestrationV2Subagent.self,
            from: Data(#"{\#(base),"modelSelection":{"instanceId":"codex","model":"gpt-5.4","options":[{"id":"reasoningEffort","value":"high"}]}}"#.utf8)
        )
        XCTAssertEqual(current.modelSelection?.instanceId, "codex")
        XCTAssertEqual(current.modelSelection?.options?.first?.value, .string("high"))
    }

    func testKeepsTheMatchButNoTraitsOnceTheProviderInstanceIsGone() {
        XCTAssertEqual(
            traits(
                selection: FeatureSelection(
                    providerID: "codex",
                    modelID: "gpt-5.4",
                    options: [.init(id: "reasoningEffort", value: .string("high"))]
                ),
                provider: nil
            ),
            SubagentModelTraits()
        )
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
