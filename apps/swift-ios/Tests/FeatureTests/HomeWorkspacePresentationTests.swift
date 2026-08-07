import Foundation
import XCTest

@testable import T3Code

/// Covers the Home sidebar's half of the workspace switch: which rows a
/// workspace shows, the cache that decides whether the switch is visible at all,
/// and the inbox dividers T3 Work draws over its active block.
///
/// The T3 Work / T3 Code split is invisible in the failure case — a stale
/// presentation renders perfectly, just with the other workspace's threads — so
/// these assert the plumbing rather than the pure functions underneath, which
/// `WorkspaceSwitcherTests` and `WorkInboxSectionsTests` already own.
final class HomeWorkspacePresentationTests: XCTestCase {
    private let environmentID = "environment:local"

    // MARK: - Fixtures

    private func thread(
        id: String,
        providerID: String,
        workInboxRole: String? = nil,
        relationshipToParent: String? = nil,
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
            isArchived: isArchived,
            workInboxRole: workInboxRole,
            relationshipToParent: relationshipToParent
        )
    }

    private func snapshot(threads: [FeatureThread]) -> FeatureSnapshot {
        FeatureSnapshot(
            environments: [
                FeatureEnvironment(
                    id: environmentID,
                    name: "Local",
                    endpoint: "http://localhost",
                    isActive: true
                ),
            ],
            projects: [
                FeatureProject(
                    id: "project-1",
                    environmentID: environmentID,
                    name: "Project",
                    path: "/tmp/project"
                ),
            ],
            threads: threads,
            providers: [
                FeatureProvider(id: "hermes", name: "Hermes", driver: "hermes"),
                FeatureProvider(id: "claude", name: "Claude", driver: "claude"),
            ]
        )
    }

    private func presentation(
        _ snapshot: FeatureSnapshot,
        workspace: MobileWorkspace
    ) -> HomePresentation {
        HomePresentation(
            snapshot: snapshot,
            workspace: workspace,
            query: "",
            projectID: nil,
            now: .now
        )
    }

    private func collectionView(
        _ presentation: HomePresentation,
        workspace: MobileWorkspace
    ) -> HomeThreadCollectionView {
        HomeThreadCollectionView(
            presentation: presentation,
            workspace: workspace,
            query: "",
            selectedThreadID: nil,
            forceRichRows: false,
            isSnoozedExpanded: false,
            isSettledExpanded: false,
            isArchiveExpanded: false,
            settledLimit: 12,
            onOpen: { _ in },
            onToggleSnoozed: {},
            onToggleSettled: {},
            onToggleArchive: {},
            onShowMoreSettled: {},
            onRename: { _ in },
            onArchive: { _, _ in },
            onSettle: { _, _ in },
            onSnooze: { _, _ in },
            onPin: { _, _ in },
            onDelete: { _ in },
            onCopyHandoffScript: { _ in },
            onRegenerateTitle: { _ in }
        )
    }

    // MARK: - Which rows a workspace shows

    func testEachWorkspaceShowsOnlyItsOwnThreads() {
        let snapshot = snapshot(threads: [
            thread(id: "work", providerID: "hermes"),
            thread(id: "code", providerID: "claude"),
        ])

        XCTAssertEqual(presentation(snapshot, workspace: .work).active.map(\.id), ["work"])
        XCTAssertEqual(presentation(snapshot, workspace: .code).active.map(\.id), ["code"])
    }

    /// A subagent is a step inside its parent's timeline, so neither workspace
    /// lists it as work of its own — which only holds if `relationshipToParent`
    /// actually reaches the routing model.
    func testSubagentThreadsAreListedByNeitherWorkspace() {
        let snapshot = snapshot(threads: [
            thread(id: "code", providerID: "claude"),
            thread(id: "code-subagent", providerID: "claude", relationshipToParent: "subagent"),
            thread(id: "work-subagent", providerID: "hermes", relationshipToParent: "subagent"),
        ])

        XCTAssertEqual(presentation(snapshot, workspace: .code).active.map(\.id), ["code"])
        XCTAssertTrue(presentation(snapshot, workspace: .work).active.isEmpty)
    }

    func testTheArchiveShelfIsSplitByWorkspaceToo() {
        let snapshot = snapshot(threads: [
            thread(id: "work", providerID: "hermes", isArchived: true),
            thread(id: "code", providerID: "claude", isArchived: true),
        ])

        XCTAssertEqual(presentation(snapshot, workspace: .work).archived.map(\.id), ["work"])
        XCTAssertEqual(presentation(snapshot, workspace: .code).archived.map(\.id), ["code"])
    }

    // MARK: - The cache

    /// The failure this guards is silent: the switcher flips, the cache returns
    /// the presentation it already built, and the list keeps showing the other
    /// workspace's threads without a crash or a compile error.
    @MainActor
    func testFlippingTheWorkspaceAloneInvalidatesTheCachedPresentation() {
        let snapshot = snapshot(threads: [
            thread(id: "work", providerID: "hermes"),
            thread(id: "code", providerID: "claude"),
        ])
        let cache = HomePresentationCache()
        let now = Date.now

        let code = cache.presentation(
            snapshot: snapshot,
            revision: 1,
            workspace: .code,
            query: "",
            projectID: nil,
            now: now
        )
        let work = cache.presentation(
            snapshot: snapshot,
            revision: 1,
            workspace: .work,
            query: "",
            projectID: nil,
            now: now
        )

        XCTAssertEqual(code.active.map(\.id), ["code"])
        XCTAssertEqual(work.active.map(\.id), ["work"])
    }

    // MARK: - Work inbox dividers

    func testWorkGroupsItsActiveBlockUnderInboxHeaders() {
        let snapshot = snapshot(threads: [
            thread(id: "active", providerID: "hermes"),
            thread(id: "blocked", providerID: "hermes", state: .waitingForApproval),
            thread(id: "main", providerID: "hermes", workInboxRole: "main"),
        ])
        let items = collectionView(
            presentation(snapshot, workspace: .work),
            workspace: .work
        ).collectionItems

        // The Main section only exists when `workInboxRole` reaches the grouping
        // — a nil role puts the pinned thread in Active with everything else.
        XCTAssertEqual(
            items.compactMap { item -> String? in
                guard case let .workSectionHeader(header) = item else { return nil }
                return header.label
            },
            ["Main", "Needs you", "Active"]
        )
        XCTAssertEqual(
            headerFollowedByRows(items),
            [
                HeaderRows(label: "Main", rows: ["main"]),
                HeaderRows(label: "Needs you", rows: ["blocked"]),
                HeaderRows(label: "Active", rows: ["active"]),
            ]
        )
    }

    func testCodeKeepsOneUndifferentiatedActiveBlock() {
        let snapshot = snapshot(threads: [
            thread(id: "first", providerID: "claude"),
            thread(id: "second", providerID: "claude", state: .waitingForApproval),
        ])
        let items = collectionView(
            presentation(snapshot, workspace: .code),
            workspace: .code
        ).collectionItems

        XCTAssertFalse(items.contains { item in
            if case .workSectionHeader = item { return true }
            return false
        })
        XCTAssertEqual(Set(threadIDs(items)), ["first", "second"])
    }

    func testAnEmptyWorkInboxDrawsNoHeadersAtAll() {
        let items = collectionView(
            presentation(snapshot(threads: []), workspace: .work),
            workspace: .work
        ).collectionItems

        XCTAssertFalse(items.contains { item in
            if case .workSectionHeader = item { return true }
            return false
        })
        XCTAssertTrue(items.contains { item in
            if case .empty(.active) = item { return true }
            return false
        })
    }

    // MARK: - Helpers

    private struct HeaderRows: Equatable {
        let label: String
        let rows: [String]
    }

    private func threadIDs(_ items: [HomeCollectionItem]) -> [String] {
        items.compactMap { item in
            guard case let .thread(thread, _, _, _, _) = item else { return nil }
            return thread.id
        }
    }

    private func headerFollowedByRows(_ items: [HomeCollectionItem]) -> [HeaderRows] {
        var groups: [HeaderRows] = []
        for item in items {
            switch item {
            case let .workSectionHeader(header):
                groups.append(HeaderRows(label: header.label, rows: []))
            case let .thread(thread, _, _, _, _):
                guard let last = groups.last else { continue }
                groups[groups.count - 1] = HeaderRows(
                    label: last.label,
                    rows: last.rows + [thread.id]
                )
            default:
                continue
            }
        }
        return groups
    }
}
