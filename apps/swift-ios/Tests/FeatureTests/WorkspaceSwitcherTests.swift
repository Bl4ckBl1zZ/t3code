import XCTest

@testable import T3Code

/// Ports the workspace-switcher behaviour of
/// apps/mobile/src/features/home/HomeHeader.tsx and HomeRouteScreen.tsx.
///
/// The switcher is the only thing standing between two products that share one
/// thread list, one composer and one server config, so what it hides and where
/// it sends "new task" is the whole feature.
final class WorkspaceSwitcherTests: XCTestCase {
    private let localEnvironmentID = "environment:local"
    private let otherEnvironmentID = "environment:other"

    // MARK: - Fixtures

    private func thread(
        id: String = "thread-1",
        environmentID: String? = "environment:local",
        providerID: String? = "hermes",
        state: FeatureThreadState = .idle,
        isArchived: Bool = false
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            projectID: "project-1",
            environmentID: environmentID,
            title: id,
            state: state,
            providerID: providerID,
            modelID: "default",
            isArchived: isArchived
        )
    }

    private func provider(id: String, driver: String) -> FeatureProvider {
        FeatureProvider(id: id, name: id, driver: driver)
    }

    private func serverModel(slug: String) -> ServerProviderModelSnapshot {
        ServerProviderModelSnapshot(
            slug: slug,
            name: slug,
            shortName: nil,
            subProvider: nil,
            isCustom: false,
            isDefault: nil,
            isLegacy: nil,
            capabilities: nil
        )
    }

    private func serverProvider(
        instanceID: String = "hermes",
        driver: String = "hermes"
    ) -> ServerProviderSnapshot {
        ServerProviderSnapshot(
            instanceId: instanceID,
            driver: driver,
            displayName: nil,
            accentColor: nil,
            badgeLabel: nil,
            showInteractionModeToggle: nil,
            requiresNewThreadForModelChange: nil,
            enabled: true,
            installed: true,
            version: nil,
            status: "ready",
            auth: ServerProviderAuthSnapshot(
                status: "authenticated",
                type: nil,
                label: nil,
                email: nil
            ),
            checkedAt: V2Fixture.timestamp,
            message: nil,
            availability: nil,
            unavailableReason: nil,
            models: [serverModel(slug: "default")],
            slashCommands: nil,
            skills: nil
        )
    }

    // MARK: - Menu

    func testMenuOffersBothWorkspacesWithWorkFirstAndOnlyTheCurrentOneChecked() {
        let items = WorkspaceSwitcher.menuItems(current: .code)

        XCTAssertEqual(items.map(\.id), ["workspace:work", "workspace:code"])
        XCTAssertEqual(items.map(\.title), ["T3 Work", "T3 Code"])
        XCTAssertEqual(
            items.map(\.subtitle),
            ["Create, learn, and explore", "Build, debug, and ship"]
        )
        XCTAssertEqual(items.map(\.isOn), [false, true])
    }

    func testMenuActionIDsRoundTrip() {
        for workspace in MobileWorkspace.allCases {
            XCTAssertEqual(
                WorkspaceSwitcher.workspace(
                    forMenuActionID: WorkspaceSwitcher.menuActionID(for: workspace)
                ),
                workspace
            )
        }
        XCTAssertNil(WorkspaceSwitcher.workspace(forMenuActionID: "workspace:something-else"))
    }

    func testAccessibilityLabelNamesTheControlAndItsCurrentValue() {
        XCTAssertEqual(
            WorkspaceSwitcher.accessibilityLabel(current: .work),
            "Switch workspace. Current workspace: T3 Work"
        )
    }

    // MARK: - Persistence

    func testEverythingOtherThanAnExplicitWorkReadsAsCode() {
        // A first launch, a cleared store and a value written by a newer build
        // all have to land somewhere, and Code works without Hermes configured.
        XCTAssertEqual(WorkspaceSwitcher.stored("work"), .work)
        XCTAssertEqual(WorkspaceSwitcher.stored("code"), .code)
        XCTAssertEqual(WorkspaceSwitcher.stored(nil), .code)
        XCTAssertEqual(WorkspaceSwitcher.stored(""), .code)
        XCTAssertEqual(WorkspaceSwitcher.stored("inbox"), .code)
    }

    // MARK: - Suppressed filters

    func testWorkHidesTheProjectFilterWithoutForgettingTheCodeSelection() {
        XCTAssertFalse(WorkspaceSwitcher.showsProjectFilter(.work))
        XCTAssertTrue(WorkspaceSwitcher.showsProjectFilter(.code))
        XCTAssertNil(WorkspaceSwitcher.projectFilter(.work, selectedProjectID: "project-1"))
        XCTAssertEqual(
            WorkspaceSwitcher.projectFilter(.code, selectedProjectID: "project-1"),
            "project-1"
        )
    }

    func testFilterIconFillsOnlyWhenAScopeFilterIsSet() {
        XCTAssertFalse(
            WorkspaceSwitcher.hasCustomListOptions(
                selectedEnvironmentID: nil,
                selectedProjectID: nil
            )
        )
        XCTAssertTrue(
            WorkspaceSwitcher.hasCustomListOptions(
                selectedEnvironmentID: "environment:local",
                selectedProjectID: nil
            )
        )
        XCTAssertEqual(
            WorkspaceSwitcher.filterSymbol(hasCustomListOptions: true),
            "line.3.horizontal.decrease.circle.fill"
        )
        XCTAssertEqual(
            WorkspaceSwitcher.filterSymbol(hasCustomListOptions: false),
            "line.3.horizontal.decrease.circle"
        )
    }

    // MARK: - Routing over the Home snapshot

    func testDriverMapKeysTheHomeCatalogueByEnvironment() {
        let snapshot = FeatureSnapshot(
            environments: [
                FeatureEnvironment(
                    id: localEnvironmentID,
                    name: "Local",
                    endpoint: "ws://local",
                    isActive: true
                ),
                FeatureEnvironment(
                    id: otherEnvironmentID,
                    name: "Other",
                    endpoint: "ws://other"
                ),
            ],
            providers: [provider(id: "hermes-primary", driver: "hermes")],
            providersByEnvironment: [
                otherEnvironmentID: [provider(id: "hermes-primary", driver: "codex")],
            ]
        )

        let drivers = WorkspaceSwitcher.providerDrivers(in: snapshot)

        // The same instance id means different things in two environments, so
        // the key has to carry both halves.
        XCTAssertEqual(
            drivers[
                MobileWorkspaceRouting.providerInstanceKey(
                    environmentID: localEnvironmentID,
                    providerInstanceID: "hermes-primary"
                )
            ],
            "hermes"
        )
        XCTAssertEqual(
            drivers[
                MobileWorkspaceRouting.providerInstanceKey(
                    environmentID: otherEnvironmentID,
                    providerInstanceID: "hermes-primary"
                )
            ],
            "codex"
        )
    }

    func testDriverMapAttributesALegacySnapshotsCatalogueToTheActiveEnvironment() {
        let snapshot = FeatureSnapshot(
            environments: [
                FeatureEnvironment(
                    id: localEnvironmentID,
                    name: "Local",
                    endpoint: "ws://local",
                    isActive: true
                ),
            ],
            providers: [provider(id: "hermes-primary", driver: "hermes")]
        )

        XCTAssertTrue(
            WorkspaceSwitcher.isWorkThread(
                thread(providerID: "hermes-primary"),
                providerDrivers: WorkspaceSwitcher.providerDrivers(in: snapshot)
            )
        )
    }

    func testSplitsTheHomeListBetweenWorkAndCodeAndDropsArchivedRows() {
        let snapshot = FeatureSnapshot(
            environments: [
                FeatureEnvironment(
                    id: localEnvironmentID,
                    name: "Local",
                    endpoint: "ws://local",
                    isActive: true
                ),
            ],
            providers: [
                provider(id: "hermes-primary", driver: "hermes"),
                provider(id: "codex", driver: "codex"),
            ]
        )
        let drivers = WorkspaceSwitcher.providerDrivers(in: snapshot)
        let rows = [
            thread(id: "work", providerID: "hermes-primary"),
            thread(id: "code", providerID: "codex"),
            thread(id: "archived-work", providerID: "hermes-primary", isArchived: true),
        ]

        XCTAssertEqual(
            WorkspaceSwitcher.threads(rows, in: .work, providerDrivers: drivers).map(\.id),
            ["work"]
        )
        XCTAssertEqual(
            WorkspaceSwitcher.threads(rows, in: .code, providerDrivers: drivers).map(\.id),
            ["code"]
        )
    }

    func testSubagentRowsBelongToNeitherWorkspace() {
        let drivers = WorkspaceSwitcher.providerDrivers(
            in: FeatureSnapshot(providers: [provider(id: "codex", driver: "codex")])
        )
        let rows = [thread(environmentID: nil, providerID: "codex")]

        XCTAssertEqual(
            WorkspaceSwitcher.threads(
                rows,
                in: .code,
                providerDrivers: drivers,
                relationshipToParent: { _ in nil }
            ).map(\.id),
            ["thread-1"]
        )
        XCTAssertTrue(
            WorkspaceSwitcher.threads(
                rows,
                in: .code,
                providerDrivers: drivers,
                relationshipToParent: { _ in "subagent" }
            ).isEmpty
        )
    }

    func testBridgeCarriesTheBlockedFlagsTheWorkInboxSectionsRead() {
        XCTAssertTrue(
            WorkspaceSwitcher.workspaceThread(thread(state: .waitingForApproval))
                .hasPendingApprovals
        )
        XCTAssertTrue(
            WorkspaceSwitcher.workspaceThread(thread(state: .waitingForInput)).hasPendingUserInput
        )
        let working = WorkspaceSwitcher.workspaceThread(thread(state: .working))
        XCTAssertFalse(working.hasPendingApprovals)
        XCTAssertFalse(working.hasPendingUserInput)
    }

    // MARK: - Compose

    func testCodeComposeOpensTheNewTaskSheetOnTheSelectedProject() {
        XCTAssertEqual(
            WorkspaceSwitcher.newTaskIntent(
                workspace: .code,
                selectedProjectID: "project-1",
                projects: [],
                serverConfigs: [],
                requiredEnvironmentID: nil
            ),
            .newTask(projectID: "project-1")
        )
    }

    func testWorkComposeResolvesItsOwnBackingProjectRatherThanTheSelectedOne() {
        let backingProject = MobileWorkspaceProject(
            environmentID: localEnvironmentID,
            project: V2Fixture.project(id: "project:t3-work", workspaceRoot: "/private/t3-work")
        )

        let intent = WorkspaceSwitcher.newTaskIntent(
            workspace: .work,
            // A Work launch must ignore this: attaching the conversation to
            // whatever happens to be selected is the failure being prevented.
            selectedProjectID: "project:ordinary",
            projects: [backingProject],
            serverConfigs: [
                MobileWorkspaceEnvironmentConfig(
                    environmentID: localEnvironmentID,
                    t3WorkDirectory: "/private/t3-work",
                    providers: [serverProvider()]
                ),
            ],
            requiredEnvironmentID: nil
        )

        XCTAssertEqual(
            intent,
            .hermesConversation(
                HermesConversationTarget(
                    project: backingProject,
                    modelSelection: ModelSelection(instanceId: "hermes", model: "default")
                )
            )
        )
    }

    func testWorkComposeSaysSoWhenHermesIsNotSetUpInsteadOfDoingNothing() {
        XCTAssertEqual(
            WorkspaceSwitcher.newTaskIntent(
                workspace: .work,
                selectedProjectID: nil,
                projects: [],
                serverConfigs: [],
                requiredEnvironmentID: nil
            ),
            .hermesUnavailable(
                title: "Hermes is not ready",
                message: """
                    Enable and configure Hermes on a connected environment before starting a Work \
                    conversation.
                    """
            )
        )
    }
}
