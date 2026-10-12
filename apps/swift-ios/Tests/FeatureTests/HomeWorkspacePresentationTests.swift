import Foundation
import XCTest

@testable import T3Code

/// Covers the Home sidebar's presentation: which rows the list shows, search
/// results, change-request overlays and the shelves it draws.
final class HomeWorkspacePresentationTests: XCTestCase {
    private let environmentID = "environment:local"

    // MARK: - Fixtures

    private func thread(
        id: String,
        providerID: String,
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
                FeatureProvider(id: "claude", name: "Claude", driver: "claude"),
            ]
        )
    }

    private func presentation(of snapshot: FeatureSnapshot) -> HomePresentation {
        HomePresentation(
            snapshot: snapshot,
            query: "",
            projectID: nil,
            now: .now
        )
    }

    private func collectionView(
        _ presentation: HomePresentation,
        changeRequests: [String: FeaturePullRequest] = [:],
        query: String = ""
    ) -> HomeThreadCollectionView {
        HomeThreadCollectionView(
            presentation: presentation,
            changeRequests: changeRequests,
            query: query,
            selectedThreadID: nil,
            forceRichRows: false,
            isSnoozedExpanded: false,
            isSettledExpanded: false,
            isArchiveExpanded: false,
            settledLimit: 12,
            confirmThreadUnpin: false,
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
            onCopy: { _, _ in },
            onRegenerateTitle: { _ in }
        )
    }

    // MARK: - Message search

    /// Title matches lead; threads found only by message content follow with the
    /// matched message as an excerpt, so the user can see why a row is there.
    func testMessageMatchesFollowTitleMatchesWithAnExcerpt() {
        let snapshot = snapshot(threads: [
            thread(id: "alpha", providerID: "claude"),
            thread(id: "beta", providerID: "claude"),
            thread(id: "gamma", providerID: "claude"),
        ])
        let presentation = HomePresentation(
            snapshot: snapshot,
            query: "alp",
            projectID: nil,
            now: .now,
            contentMatchIDs: ["beta"]
        )
        var view = collectionView(presentation, query: "alp")
        let match = FeatureThreadSearchMatch(source: .assistant, snippet: "The ALPha build passed")
        view.contentMatches = ["beta": match]

        let rows = view.collectionItems.compactMap { item -> (String, HomeThreadSearchExcerpt?)? in
            guard case let .thread(thread, context, _, _, _) = item else { return nil }
            return (thread.id, context.searchExcerpt)
        }
        XCTAssertEqual(rows.map(\.0), ["alpha", "beta"])
        XCTAssertNil(rows[0].1)
        XCTAssertEqual(rows[1].1, HomeThreadSearchExcerpt(match: match, query: "alp"))
        XCTAssertEqual(rows[1].1?.speaker, "Agent:")
    }

    /// With nothing matched locally, the empty state waits for message search
    /// instead of claiming there are no results.
    func testEmptySearchWaitsForMessageSearch() {
        let snapshot = snapshot(threads: [thread(id: "alpha", providerID: "claude")])
        let presentation = HomePresentation(snapshot: snapshot, query: "zzz", projectID: nil, now: .now)
        var view = collectionView(presentation, query: "zzz")
        view.isSearchingContent = true
        XCTAssertEqual(view.collectionItems, [.searchEmpty("zzz", true)])
        view.isSearchingContent = false
        XCTAssertEqual(view.collectionItems, [.searchEmpty("zzz", false)])
    }

    // MARK: - Change requests on rows

    /// Change requests arrive on their own subscription, well after the cached
    /// presentation is built, so the row has to pick them up from the overlay
    /// rather than from the snapshot the presentation was indexed from.
    func testAChangeRequestReachesItsRowWithoutRebuildingThePresentation() {
        let snapshot = snapshot(threads: [
            thread(id: "code", providerID: "claude"),
            thread(id: "other", providerID: "claude"),
        ])
        let presentation = presentation(of: snapshot)
        let pullRequest = FeaturePullRequest(
            number: 184,
            title: "fix: TestFlight version regression",
            state: "open"
        )

        let items = collectionView(
            presentation,
            changeRequests: ["code": pullRequest]
        ).collectionItems

        XCTAssertEqual(rowContext(for: "code", in: items)?.pullRequest, pullRequest)
        XCTAssertNil(rowContext(for: "other", in: items)?.pullRequest)
    }

    /// Without a change request the row keeps its branch, so the overlay must
    /// stay empty rather than leaving a previous thread's PR behind it.
    func testARowWithoutAChangeRequestCarriesNone() {
        let snapshot = snapshot(threads: [thread(id: "code", providerID: "claude")])
        let items = collectionView(presentation(of: snapshot))
            .collectionItems

        XCTAssertNil(rowContext(for: "code", in: items)?.pullRequest)
    }

    private func rowContext(
        for threadID: String,
        in items: [HomeCollectionItem]
    ) -> HomeThreadRowContext? {
        for case let .thread(thread, context, _, _, _) in items where thread.id == threadID {
            return context
        }
        return nil
    }

    // MARK: - Which rows the list shows

    /// A subagent is a step inside its parent's timeline, so the list never
    /// shows it as work of its own.
    func testSubagentThreadsAreNotListed() {
        let snapshot = snapshot(threads: [
            thread(id: "code", providerID: "claude"),
            thread(id: "code-subagent", providerID: "claude", relationshipToParent: "subagent"),
        ])

        XCTAssertEqual(presentation(of: snapshot).active.map(\.id), ["code"])
    }

    func testArchivedThreadsLiveOnTheArchiveShelf() {
        let snapshot = snapshot(threads: [
            thread(id: "archived", providerID: "claude", isArchived: true),
            thread(id: "live", providerID: "claude"),
        ])

        let presentation = presentation(of: snapshot)
        XCTAssertEqual(presentation.archived.map(\.id), ["archived"])
        XCTAssertEqual(presentation.active.map(\.id), ["live"])
    }

    func testTheActiveBlockIsOneUndifferentiatedBlock() {
        let snapshot = snapshot(threads: [
            thread(id: "first", providerID: "claude"),
            thread(id: "second", providerID: "claude", state: .waitingForApproval),
        ])
        let items = collectionView(presentation(of: snapshot)).collectionItems

        XCTAssertEqual(Set(threadIDs(items)), ["first", "second"])
    }

    /// An empty list is one empty state and nothing else: no shelf headers
    /// counting zero.
    func testAnEmptyListDrawsOnlyItsEmptyState() {
        var view = collectionView(presentation(of: snapshot(threads: [])))
        let empty = HomeEmptyState.resolve(hasCreationProjects: true, filteredProjectName: nil)
        view.emptyState = empty

        XCTAssertEqual(view.collectionItems, [.empty(empty)])
    }

    /// Placeholders stand in for the whole list while the first snapshot
    /// loads, under the banner, never alongside an empty state.
    func testPlaceholdersReplaceTheListWhileLoading() {
        var view = collectionView(presentation(of: snapshot(threads: [])))
        view.isPlaceholder = true
        view.emptyState = HomeEmptyState.resolve(
            hasCreationProjects: false,
            filteredProjectName: nil
        )
        let banner = HomeConnectionBanner(
            tone: .warning,
            title: "Connecting to Mac…",
            message: "Changes you make are queued.",
            offersReconnect: false
        )
        view.banner = banner

        XCTAssertEqual(view.collectionItems, [.banner(banner)] + (0..<6).map(HomeCollectionItem.placeholder))
    }

    /// Shelves with nothing on them are not drawn; pinned rows get their own
    /// heading and the rest sit under Active.
    func testEmptyShelvesAreNotDrawnAndPinnedRowsAreHeaded() {
        var pinned = thread(id: "pinned", providerID: "claude")
        pinned.pinnedAt = .now
        let items = collectionView(
            presentation(of: snapshot(threads: [pinned, thread(id: "active", providerID: "claude")]))
        ).collectionItems

        XCTAssertFalse(items.contains { item in
            if case .shelfHeader = item { return true }
            return false
        })
        XCTAssertEqual(
            items.compactMap { item -> String? in
                guard case let .sectionTitle(title) = item else { return nil }
                return title
            },
            ["Pinned", "Active"]
        )
        XCTAssertEqual(threadIDs(items), ["pinned", "active"])
    }

    /// An archived thread found by search says so; the Archived shelf does
    /// not repeat it on every row.
    func testArchivedSearchResultsCarryTheArchivedBadge() {
        let snapshot = snapshot(threads: [
            thread(id: "alpha-archived", providerID: "claude", isArchived: true),
            thread(id: "alpha-live", providerID: "claude"),
        ])
        let presentation = HomePresentation(snapshot: snapshot, query: "alpha", projectID: nil, now: .now)
        let items = collectionView(presentation, query: "alpha").collectionItems

        XCTAssertEqual(rowContext(for: "alpha-archived", in: items)?.showsArchivedBadge, true)
        XCTAssertEqual(rowContext(for: "alpha-live", in: items)?.showsArchivedBadge, false)
    }

    // MARK: - Helpers

    private func threadIDs(_ items: [HomeCollectionItem]) -> [String] {
        items.compactMap { item in
            guard case let .thread(thread, _, _, _, _) = item else { return nil }
            return thread.id
        }
    }
}
