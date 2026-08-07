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

    /// `upstream` and the per-file `state` / `isStaged` are the parts the status
    /// contract does not carry. Pinning them here documents the gap: when the
    /// contract grows the ref name or the porcelain XY code, this test is what
    /// fails and points at the mapper.
    func testTheFieldsTheStatusContractDoesNotReportStayUnset() throws {
        let mapped = NativeWorkspaceMapper.sourceControl(
            wireStatus(
                hasWorkingTreeChanges: true,
                files: [VCSWorkingTreeFile(path: "Deleted.swift", insertions: 0, deletions: 9)],
                hasUpstream: true
            )
        )

        // `hasUpstream` is reported; the upstream ref *name* is not, so this
        // stays nil and consumers must not read it as "no upstream".
        XCTAssertNil(mapped.upstream)
        XCTAssertTrue(mapped.hasUpstream)

        let file = try XCTUnwrap(mapped.files.first)
        XCTAssertEqual(file.state, .modified)
        XCTAssertFalse(file.isStaged)
        XCTAssertEqual(file.deletions, 9)
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
