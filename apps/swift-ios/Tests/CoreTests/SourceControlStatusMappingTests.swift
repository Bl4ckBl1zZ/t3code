import Foundation
import XCTest

@testable import T3Code

/// `NativeWorkspaceMapper.sourceControl` is the only path from the VCS wire
/// status to every git surface in the app, so anything it drops is unavailable
/// to all of them. It used to drop four flags and the line counts, which is why
/// the thread details sheet had to reconstruct them — and why its `isDefaultRef`
/// reconstruction (always false) meant the confirmation that stops a commit
/// landing straight on the default branch could never fire.
final class SourceControlStatusMappingTests: XCTestCase {
    private func wireStatus(
        isRepo: Bool = true,
        hasPrimaryRemote: Bool = true,
        isDefaultRef: Bool = false,
        refName: String? = "feature/native",
        hasWorkingTreeChanges: Bool = false,
        files: [VCSWorkingTreeFile] = [],
        insertions: Int = 0,
        deletions: Int = 0,
        hasUpstream: Bool = false,
        aheadCount: Int = 0,
        behindCount: Int = 0,
        pr: VCSChangeRequest? = nil
    ) -> VCSStatus {
        VCSStatus(
            isRepo: isRepo,
            sourceControlProvider: nil,
            hasPrimaryRemote: hasPrimaryRemote,
            isDefaultRef: isDefaultRef,
            refName: refName,
            hasWorkingTreeChanges: hasWorkingTreeChanges,
            workingTree: VCSWorkingTree(
                files: files,
                insertions: insertions,
                deletions: deletions
            ),
            hasUpstream: hasUpstream,
            aheadCount: aheadCount,
            behindCount: behindCount,
            aheadOfDefaultCount: nil,
            pr: pr
        )
    }

    func testEveryFlagTheWireStatusCarriesSurvivesTheMapping() {
        let mapped = NativeWorkspaceMapper.sourceControl(
            wireStatus(
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: true,
                files: [
                    VCSWorkingTreeFile(path: "App.swift", insertions: 12, deletions: 3),
                    VCSWorkingTreeFile(path: "Notes.pdf", insertions: 0, deletions: 0),
                ],
                insertions: 12,
                deletions: 3,
                hasUpstream: true,
                aheadCount: 2,
                behindCount: 1,
                pr: VCSChangeRequest(
                    number: 7,
                    title: "Open",
                    url: "https://example.com/pr/7",
                    baseRef: "main",
                    headRef: "feature/native",
                    state: "open"
                )
            )
        )

        XCTAssertTrue(mapped.isRepository)
        XCTAssertEqual(mapped.branch, "main")
        // The flag that gates the "you are on the default branch" confirmation.
        XCTAssertTrue(mapped.isDefaultRef)
        XCTAssertTrue(mapped.hasPrimaryRemote)
        XCTAssertTrue(mapped.hasUpstream)
        XCTAssertTrue(mapped.hasWorkingTreeChanges)
        XCTAssertEqual(mapped.aheadCount, 2)
        XCTAssertEqual(mapped.behindCount, 1)
        XCTAssertEqual(mapped.insertions, 12)
        XCTAssertEqual(mapped.deletions, 3)
        XCTAssertEqual(mapped.pullRequest?.number, 7)
        XCTAssertEqual(mapped.pullRequest?.url?.absoluteString, "https://example.com/pr/7")

        XCTAssertEqual(mapped.files.map(\.path), ["App.swift", "Notes.pdf"])
        XCTAssertEqual(mapped.files.first?.insertions, 12)
        XCTAssertEqual(mapped.files.first?.deletions, 3)
        // A file git listed but that numstat did not score keeps its real zeros
        // rather than being dropped from the list.
        XCTAssertEqual(mapped.files.last?.insertions, 0)
        XCTAssertEqual(mapped.files.last?.deletions, 0)
    }

    /// The case the old mapping got wrong. A branch that tracks an upstream and
    /// is exactly level with it has both drift counts at zero, so inferring
    /// "tracked" from the counts reported no upstream and the branch could be
    /// offered a first push it did not need.
    func testABranchLevelWithItsUpstreamIsStillReportedAsTracked() {
        let mapped = NativeWorkspaceMapper.sourceControl(
            wireStatus(hasUpstream: true, aheadCount: 0, behindCount: 0)
        )

        XCTAssertTrue(mapped.hasUpstream)
        XCTAssertEqual(mapped.aheadCount, 0)
        XCTAssertEqual(mapped.behindCount, 0)
    }

    func testARepositoryWithNoRemoteIsReportedAsSuchRatherThanAssumedToHaveOne() {
        let mapped = NativeWorkspaceMapper.sourceControl(
            wireStatus(hasPrimaryRemote: false, hasUpstream: false)
        )

        XCTAssertFalse(mapped.hasPrimaryRemote)
        XCTAssertFalse(mapped.hasUpstream)
    }

    /// `VcsStatusResult` reports `hasWorkingTreeChanges` separately from the
    /// per-file list, and they can disagree: git calls a tree dirty for changes
    /// its numstat does not score.
    func testADirtyTreeWithNoScoredFilesStillOffersACommit() {
        let mapped = NativeWorkspaceMapper.sourceControl(
            wireStatus(hasWorkingTreeChanges: true, files: [])
        )

        XCTAssertTrue(mapped.hasWorkingTreeChanges)
        XCTAssertTrue(mapped.files.isEmpty)
        XCTAssertTrue(mapped.availableActions.contains(.commit))
    }

    func testACleanTreeReportsNoWorkingTreeChanges() {
        let mapped = NativeWorkspaceMapper.sourceControl(wireStatus())

        XCTAssertFalse(mapped.hasWorkingTreeChanges)
        XCTAssertFalse(mapped.availableActions.contains(.commit))
    }

    /// The upstream *ref name* is the one thing the status contract still does
    /// not carry. Pinning it documents the gap: when the contract grows it, this
    /// test is what fails and points at the mapper.
    func testTheUpstreamRefNameTheStatusContractDoesNotReportStaysUnset() {
        let mapped = NativeWorkspaceMapper.sourceControl(
            wireStatus(hasUpstream: true)
        )

        // `hasUpstream` is reported; the ref *name* is not, so this stays nil
        // and consumers must not read it as "no upstream".
        XCTAssertNil(mapped.upstream)
        XCTAssertTrue(mapped.hasUpstream)
    }

    // MARK: - Per-file status

    /// Every file used to arrive `.modified` and unstaged, because the server
    /// parsed git's porcelain XY codes only to learn *that* a path changed. The
    /// codes reach the wire now, and none of these states is recoverable from
    /// the line counts beside them: an addition and an addition-only edit are
    /// both `n/0`, and an untracked file and a binary one are both `0/0`.
    func testEveryPorcelainChangeKindReachesTheFileList() {
        let mapped = NativeWorkspaceMapper.sourceControl(
            wireStatus(
                hasWorkingTreeChanges: true,
                files: [
                    VCSWorkingTreeFile(
                        path: "Added.swift",
                        insertions: 12,
                        deletions: 0,
                        changeKind: .added,
                        stagedChangeKind: .added
                    ),
                    VCSWorkingTreeFile(
                        path: "Modified.swift",
                        insertions: 3,
                        deletions: 1,
                        changeKind: .modified,
                        unstagedChangeKind: .modified
                    ),
                    VCSWorkingTreeFile(
                        path: "Deleted.swift",
                        insertions: 0,
                        deletions: 9,
                        changeKind: .deleted,
                        unstagedChangeKind: .deleted
                    ),
                    VCSWorkingTreeFile(
                        path: "Untracked.swift",
                        insertions: 0,
                        deletions: 0,
                        changeKind: .untracked,
                        unstagedChangeKind: .untracked
                    ),
                    VCSWorkingTreeFile(
                        path: "Conflicted.swift",
                        insertions: 4,
                        deletions: 4,
                        changeKind: .conflicted
                    ),
                ]
            )
        )

        XCTAssertEqual(
            mapped.files.map(\.state),
            [.added, .modified, .deleted, .untracked, .conflicted]
        )
        // The line counts are still the real ones next to the new states.
        XCTAssertEqual(mapped.files.map(\.insertions), [12, 3, 0, 0, 4])
        XCTAssertEqual(mapped.files.map(\.deletions), [0, 1, 9, 0, 4])
    }

    func testAStagedFileIsReportedAsStagedAndAnUnstagedOneIsNot() throws {
        let mapped = NativeWorkspaceMapper.sourceControl(
            wireStatus(
                hasWorkingTreeChanges: true,
                files: [
                    VCSWorkingTreeFile(
                        path: "Staged.swift",
                        insertions: 2,
                        deletions: 0,
                        changeKind: .modified,
                        stagedChangeKind: .modified
                    ),
                    VCSWorkingTreeFile(
                        path: "Unstaged.swift",
                        insertions: 2,
                        deletions: 0,
                        changeKind: .modified,
                        unstagedChangeKind: .modified
                    ),
                ]
            )
        )

        let staged = try XCTUnwrap(mapped.files.first)
        XCTAssertTrue(staged.isStaged)
        XCTAssertFalse(staged.hasUnstagedChanges)

        let unstaged = try XCTUnwrap(mapped.files.last)
        XCTAssertFalse(unstaged.isStaged)
        XCTAssertTrue(unstaged.hasUnstagedChanges)
    }

    /// The case a single staged flag cannot express. Porcelain reports the index
    /// and the working tree in separate columns (`MM`), so a file with something
    /// to commit *and* something still outside the index is distinguishable from
    /// one that is fully staged.
    func testAFileStagedAndThenEditedAgainReportsBothSides() throws {
        let mapped = NativeWorkspaceMapper.sourceControl(
            wireStatus(
                hasWorkingTreeChanges: true,
                files: [
                    VCSWorkingTreeFile(
                        path: "StagedThenEdited.swift",
                        insertions: 2,
                        deletions: 0,
                        changeKind: .modified,
                        stagedChangeKind: .modified,
                        unstagedChangeKind: .modified
                    )
                ]
            )
        )

        let file = try XCTUnwrap(mapped.files.first)
        XCTAssertTrue(file.isStaged)
        XCTAssertTrue(file.hasUnstagedChanges)
    }

    func testARenameCarriesThePathItCameFrom() throws {
        let mapped = NativeWorkspaceMapper.sourceControl(
            wireStatus(
                hasWorkingTreeChanges: true,
                files: [
                    VCSWorkingTreeFile(
                        path: "Features/Renamed.swift",
                        insertions: 1,
                        deletions: 0,
                        changeKind: .renamed,
                        stagedChangeKind: .renamed,
                        originalPath: "App/Renamed.swift"
                    )
                ]
            )
        )

        let file = try XCTUnwrap(mapped.files.first)
        XCTAssertEqual(file.state, .renamed)
        XCTAssertEqual(file.previousPath, "App/Renamed.swift")
        XCTAssertTrue(file.isStaged)
    }

    /// `FeatureSourceControlFileState` has no `copied`, and the view that renders
    /// it switches exhaustively. A copy creates a new file at this path, so it
    /// reads as an addition that remembers its source.
    func testACopyIsShownAsAnAdditionThatRemembersItsSource() throws {
        let mapped = NativeWorkspaceMapper.sourceControl(
            wireStatus(
                hasWorkingTreeChanges: true,
                files: [
                    VCSWorkingTreeFile(
                        path: "Copy.swift",
                        insertions: 20,
                        deletions: 0,
                        changeKind: .copied,
                        stagedChangeKind: .copied,
                        originalPath: "Original.swift"
                    )
                ]
            )
        )

        let file = try XCTUnwrap(mapped.files.first)
        XCTAssertEqual(file.state, .added)
        XCTAssertEqual(file.previousPath, "Original.swift")
    }

    /// A server that predates the per-file status fields sends none of them. The
    /// file still has to appear, and `.modified`/unstaged is what the whole list
    /// used to be.
    func testAFileFromAServerWithoutPerFileStatusFallsBackToModified() throws {
        let mapped = NativeWorkspaceMapper.sourceControl(
            wireStatus(
                hasWorkingTreeChanges: true,
                files: [VCSWorkingTreeFile(path: "Legacy.swift", insertions: 1, deletions: 1)]
            )
        )

        let file = try XCTUnwrap(mapped.files.first)
        XCTAssertEqual(file.state, .modified)
        XCTAssertFalse(file.isStaged)
        XCTAssertNil(file.previousPath)
        XCTAssertEqual(file.insertions, 1)
        XCTAssertEqual(file.deletions, 1)
    }

    /// The status fields are optional on the wire, so a payload from an older
    /// server has to decode rather than take the whole git surface down with it.
    func testAWorkingTreeFileDecodesWithoutTheOptionalStatusFields() throws {
        let payload = Data(
            #"{"path":"Legacy.swift","insertions":2,"deletions":0}"#.utf8
        )

        let file = try JSONDecoder().decode(VCSWorkingTreeFile.self, from: payload)

        XCTAssertEqual(file.path, "Legacy.swift")
        XCTAssertNil(file.changeKind)
        XCTAssertNil(file.stagedChangeKind)
        XCTAssertNil(file.unstagedChangeKind)
        XCTAssertNil(file.originalPath)
    }

    /// A change kind added to the contract after this build shipped reads as
    /// absent — the file still lists, rather than the decode failing.
    func testAnUnknownChangeKindDoesNotFailTheDecode() throws {
        let payload = Data(
            #"{"path":"Future.swift","insertions":0,"deletions":0,"changeKind":"submoduled"}"#.utf8
        )

        let file = try JSONDecoder().decode(VCSWorkingTreeFile.self, from: payload)

        XCTAssertEqual(file.path, "Future.swift")
        XCTAssertNil(file.changeKind)
    }

    // MARK: - Hand-built statuses

    /// The mapper always supplies the real values, so these defaults only apply
    /// to statuses assembled in previews and tests. They still have to be
    /// self-consistent: a status handed a list of changed files must not also
    /// claim a clean working tree.
    func testAHandBuiltStatusDerivesTheFlagsItWasNotGiven() {
        let dirty = FeatureSourceControlStatus(
            branch: "feature",
            files: [FeatureSourceControlFile(path: "a.swift", state: .modified, isStaged: false)]
        )
        XCTAssertTrue(dirty.hasWorkingTreeChanges)
        // An unstaged file has working-tree changes; that is the only way it
        // could have been listed.
        XCTAssertTrue(dirty.files.first?.hasUnstagedChanges == true)
        XCTAssertFalse(
            FeatureSourceControlFile(path: "b.swift", state: .added, isStaged: true)
                .hasUnstagedChanges
        )

        let clean = FeatureSourceControlStatus(branch: "feature")
        XCTAssertFalse(clean.hasWorkingTreeChanges)
        XCTAssertFalse(clean.hasUpstream)

        let drifted = FeatureSourceControlStatus(branch: "feature", aheadCount: 1)
        XCTAssertTrue(drifted.hasUpstream)

        // An explicit value always wins over the derivation.
        let tracked = FeatureSourceControlStatus(branch: "feature", hasUpstream: true)
        XCTAssertTrue(tracked.hasUpstream)
        XCTAssertEqual(tracked.aheadCount, 0)
    }
}
