import XCTest

@testable import T3Code

private let localEnvironmentID = "environment:local"
private let otherEnvironmentID = "environment:other"
private let hermesInstanceID = "hermes-primary"

/// Ports apps/mobile/src/lib/mobileWorkspace.test.ts. The T3 Work / T3 Code
/// split is a pure client decision over the shared thread list, so both clients
/// have to draw it identically or the same server state reads two ways.
final class MobileWorkspaceTests: XCTestCase {
    // MARK: - Fixtures

    private func model(
        slug: String = "default",
        isDefault: Bool? = nil
    ) -> ServerProviderModelSnapshot {
        ServerProviderModelSnapshot(
            slug: slug,
            name: slug,
            shortName: nil,
            subProvider: nil,
            isCustom: false,
            isDefault: isDefault,
            isLegacy: nil,
            capabilities: nil
        )
    }

    private func provider(
        instanceID: String = hermesInstanceID,
        driver: String = "hermes",
        enabled: Bool = true,
        installed: Bool = true,
        status: String = "ready",
        availability: String? = nil,
        models: [ServerProviderModelSnapshot]? = nil
    ) -> ServerProviderSnapshot {
        ServerProviderSnapshot(
            instanceId: instanceID,
            driver: driver,
            displayName: nil,
            accentColor: nil,
            badgeLabel: nil,
            showInteractionModeToggle: nil,
            requiresNewThreadForModelChange: nil,
            enabled: enabled,
            installed: installed,
            version: nil,
            status: status,
            auth: ServerProviderAuthSnapshot(
                status: "authenticated",
                type: nil,
                label: nil,
                email: nil
            ),
            checkedAt: V2Fixture.timestamp,
            message: nil,
            availability: availability,
            unavailableReason: nil,
            models: models ?? [model()],
            slashCommands: nil,
            skills: nil
        )
    }

    private func config(
        environmentID: String = localEnvironmentID,
        t3WorkDirectory: String? = "/private/t3-work",
        providers: [ServerProviderSnapshot]? = nil
    ) -> MobileWorkspaceEnvironmentConfig {
        MobileWorkspaceEnvironmentConfig(
            environmentID: environmentID,
            t3WorkDirectory: t3WorkDirectory,
            providers: providers ?? [provider()]
        )
    }

    private func project(
        id: String,
        workspaceRoot: String,
        environmentID: String = localEnvironmentID
    ) -> MobileWorkspaceProject {
        MobileWorkspaceProject(
            environmentID: environmentID,
            project: V2Fixture.project(id: id, workspaceRoot: workspaceRoot)
        )
    }

    private func thread(
        environmentID: String = localEnvironmentID,
        providerInstanceID: String? = hermesInstanceID,
        archivedAt: String? = nil,
        relationshipToParent: String? = nil,
        workInboxRole: String? = nil,
        hasPendingApprovals: Bool = false,
        hasPendingUserInput: Bool = false
    ) -> MobileWorkspaceThread {
        MobileWorkspaceThread(
            environmentID: environmentID,
            archivedAt: archivedAt,
            relationshipToParent: relationshipToParent,
            runtimeProviderInstanceID: nil,
            providerInstanceID: providerInstanceID,
            modelSelection: ModelSelection(
                instanceId: providerInstanceID ?? "unset",
                model: "default"
            ),
            workInboxRole: workInboxRole,
            hasPendingApprovals: hasPendingApprovals,
            hasPendingUserInput: hasPendingUserInput
        )
    }

    // MARK: - Workspace routing

    func testRecognizesCustomHermesInstanceIDsFromProviderMetadata() {
        let drivers = MobileWorkspaceRouting.providerDriverMap(serverConfigs: [config()])

        XCTAssertEqual(
            drivers[
                MobileWorkspaceRouting.providerInstanceKey(
                    environmentID: localEnvironmentID,
                    providerInstanceID: hermesInstanceID
                )
            ],
            "hermes"
        )
        XCTAssertTrue(
            MobileWorkspaceRouting.isWorkspaceThread(
                thread(), workspace: .work, providerDrivers: drivers
            )
        )
        XCTAssertFalse(
            MobileWorkspaceRouting.isWorkspaceThread(
                thread(), workspace: .code, providerDrivers: drivers
            )
        )
    }

    func testSplitsHermesAndNonHermesThreadsBetweenWorkAndCode() {
        let drivers = MobileWorkspaceRouting.providerDriverMap(
            serverConfigs: [
                config(providers: [provider(), provider(instanceID: "codex", driver: "codex")])
            ]
        )
        let codeThread = thread(providerInstanceID: "codex")

        XCTAssertTrue(
            MobileWorkspaceRouting.isWorkspaceThread(
                codeThread, workspace: .code, providerDrivers: drivers
            )
        )
        XCTAssertFalse(
            MobileWorkspaceRouting.isWorkspaceThread(
                codeThread, workspace: .work, providerDrivers: drivers
            )
        )
    }

    func testExcludesArchivedAndSubagentThreadsFromBothWorkspaces() {
        let drivers = MobileWorkspaceRouting.providerDriverMap(serverConfigs: [config()])

        XCTAssertFalse(
            MobileWorkspaceRouting.isWorkspaceThread(
                thread(archivedAt: V2Fixture.timestamp),
                workspace: .code,
                providerDrivers: drivers
            )
        )
        XCTAssertFalse(
            MobileWorkspaceRouting.isWorkspaceThread(
                thread(relationshipToParent: "subagent"),
                workspace: .work,
                providerDrivers: drivers
            )
        )
    }

    func testTreatsTheLegacyInstanceIDAsHermesBeforeServerConfigArrives() {
        // A cached shell can render before any config lands. The canonical
        // legacy id is safe to assume; a custom id has to wait for metadata.
        XCTAssertTrue(
            MobileWorkspaceRouting.isWorkspaceThread(
                thread(providerInstanceID: "hermes"), workspace: .work, providerDrivers: [:]
            )
        )
        XCTAssertFalse(
            MobileWorkspaceRouting.isWorkspaceThread(
                thread(), workspace: .work, providerDrivers: [:]
            )
        )
    }

    // MARK: - Hermes launch target

    func testRoutesNewWorkConversationsThroughThePrivateBackingProject() {
        let ordinaryProject = project(id: "project:ordinary", workspaceRoot: "/workspace/repo")
        let backingProject = project(id: "project:t3-work", workspaceRoot: "/private/t3-work")

        let target = MobileWorkspaceRouting.resolveHermesConversationTarget(
            projects: [ordinaryProject, backingProject],
            serverConfigs: [config()],
            requiredEnvironmentID: nil
        )

        XCTAssertEqual(
            target,
            HermesConversationTarget(
                project: backingProject,
                modelSelection: ModelSelection(instanceId: hermesInstanceID, model: "default")
            )
        )
    }

    func testRoutesNewWorkConversationsThroughTheSelectedEnvironment() {
        let firstBackingProject = project(
            id: "project:first-t3-work",
            workspaceRoot: "/private/t3-work",
            environmentID: otherEnvironmentID
        )
        let selectedBackingProject = project(
            id: "project:selected-t3-work",
            workspaceRoot: "/private/t3-work"
        )

        let target = MobileWorkspaceRouting.resolveHermesConversationTarget(
            projects: [firstBackingProject, selectedBackingProject],
            serverConfigs: [config(environmentID: otherEnvironmentID), config()],
            requiredEnvironmentID: localEnvironmentID
        )

        XCTAssertEqual(target?.project, selectedBackingProject)
    }

    func testFallsBackToALaterReadyHermesProviderWhenTheFirstHasNoModels() {
        let backingProject = project(id: "project:t3-work", workspaceRoot: "/private/t3-work")

        let target = MobileWorkspaceRouting.resolveHermesConversationTarget(
            projects: [backingProject],
            serverConfigs: [
                config(providers: [
                    provider(instanceID: "hermes-modelless", models: []),
                    provider(),
                ])
            ],
            requiredEnvironmentID: nil
        )

        XCTAssertEqual(
            target,
            HermesConversationTarget(
                project: backingProject,
                modelSelection: ModelSelection(instanceId: hermesInstanceID, model: "default")
            )
        )
    }

    func testDoesNotAttachWorkConversationsToAnArbitraryProjectWhileSetupIsIncomplete() {
        XCTAssertNil(
            MobileWorkspaceRouting.resolveHermesConversationTarget(
                projects: [project(id: "project:ordinary", workspaceRoot: "/workspace/repo")],
                serverConfigs: [config()],
                requiredEnvironmentID: nil
            )
        )
        XCTAssertNil(
            MobileWorkspaceRouting.resolveHermesConversationTarget(
                projects: [project(id: "project:t3-work", workspaceRoot: "/private/t3-work")],
                serverConfigs: [config(t3WorkDirectory: nil)],
                requiredEnvironmentID: nil
            )
        )
    }

    // MARK: - Work inbox

    func testWorkInboxPutsMainFirstAndBlockedWorkAheadOfOrdinaryWork() {
        XCTAssertEqual(
            MobileWorkspaceRouting.workInboxSection(
                thread(workInboxRole: "main", hasPendingApprovals: true)
            ),
            .main
        )
        XCTAssertEqual(
            MobileWorkspaceRouting.workInboxSection(thread(hasPendingApprovals: true)),
            .needsYou
        )
        XCTAssertEqual(
            MobileWorkspaceRouting.workInboxSection(thread(hasPendingUserInput: true)),
            .needsYou
        )
        XCTAssertEqual(MobileWorkspaceRouting.workInboxSection(thread()), .active)
    }

    func testMainAndParkedWorkOfferNoPinAffordance() {
        let drivers = MobileWorkspaceRouting.providerDriverMap(serverConfigs: [config()])
        func canPin(
            _ candidate: MobileWorkspaceThread,
            isSnoozed: Bool = false,
            isSettled: Bool = false
        ) -> Bool {
            MobileWorkspaceRouting.canPinWorkThread(
                thread: candidate,
                providerDrivers: drivers,
                isSnoozed: isSnoozed,
                isSettled: isSettled
            )
        }

        XCTAssertTrue(canPin(thread()))
        XCTAssertFalse(canPin(thread(workInboxRole: "main")))
        XCTAssertFalse(canPin(thread(), isSnoozed: true))
        XCTAssertFalse(canPin(thread(), isSettled: true))
        // Only Work threads live in the Work inbox at all.
        XCTAssertFalse(canPin(thread(providerInstanceID: "codex")))
    }

    // MARK: - Draft workspace mode

    func testKeepsWorkConversationsOnTheCurrentCheckoutEvenWhenTheServerDefaultsToWorktree() {
        // The Work composer hides the Workspace pill, so a worktree mode could
        // never get a base branch and would leave the send button disabled.
        XCTAssertEqual(
            MobileWorkspaceRouting.resolveDraftWorkspaceMode(
                isWorkConversation: true, requestedMode: .worktree
            ),
            .local
        )
        XCTAssertEqual(
            MobileWorkspaceRouting.resolveDraftWorkspaceMode(
                isWorkConversation: true, requestedMode: .local
            ),
            .local
        )
    }

    func testHonoursTheRequestedModeForProjectTasks() {
        XCTAssertEqual(
            MobileWorkspaceRouting.resolveDraftWorkspaceMode(
                isWorkConversation: false, requestedMode: .worktree
            ),
            .worktree
        )
        XCTAssertEqual(
            MobileWorkspaceRouting.resolveDraftWorkspaceMode(
                isWorkConversation: false, requestedMode: .local
            ),
            .local
        )
    }
}
