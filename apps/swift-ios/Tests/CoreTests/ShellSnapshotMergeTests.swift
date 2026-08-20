import XCTest

@testable import T3Code

/// The shell subscription sends two kinds of `snapshot` frame down one wire
/// shape. Confusing them empties Home, so these pin which one replaces state.
final class ShellSnapshotMergeTests: XCTestCase {
    private func project(
        id: String = "project-1",
        root: String = "/work/one",
        identity: RepositoryIdentity? = nil
    ) -> OrchestrationProject {
        V2Fixture.project(id: id, workspaceRoot: root)
            .settingRepositoryIdentity(identity)
    }

    private func identity(_ key: String) -> RepositoryIdentity {
        let json = JSONValue.object([
            "canonicalKey": .string(key),
            "locator": .object([
                "source": .string("git"),
                "remoteName": .string("origin"),
                "remoteUrl": .string("https://example.test/\(key).git"),
            ]),
        ])
        return try! JSONDecoder.t3.decode(
            RepositoryIdentity.self,
            from: try! JSONEncoder.t3.encode(json)
        )
    }

    func testEnrichmentFrameKeepsThreadsItDoesNotCarry() {
        let previous = V2Fixture.shellSnapshot(
            sequence: 7,
            projects: [project()],
            threads: [V2Fixture.threadShell(id: "thread-1", projectID: "project-1", title: "Work")],
            archivedThreads: [
                V2Fixture.threadShell(id: "thread-old", projectID: "project-1", title: "Done"),
            ]
        )
        // What the server actually sends on resume: identity for the resolved
        // roots, no thread body at all.
        let enrichment = V2Fixture.shellSnapshot(
            sequence: 7,
            projects: [project(identity: identity("one"))],
            threads: [],
            archivedThreads: []
        )

        let merged = ShellSnapshotMerge.merge(
            previous: previous,
            next: enrichment,
            resolvedRepositoryIdentityRoots: ["/work/one"]
        )

        XCTAssertEqual(merged.threads.map(\.id), ["thread-1"])
        XCTAssertEqual(merged.archivedThreads.map(\.id), ["thread-old"])
        XCTAssertEqual(merged.snapshotSequence, 7)
        XCTAssertEqual(merged.projects.first?.repositoryIdentity, identity("one"))
    }

    func testEnrichmentFrameNeverAddsOrRemovesProjects() {
        let previous = V2Fixture.shellSnapshot(
            projects: [project(), project(id: "project-2", root: "/work/two")]
        )
        let enrichment = V2Fixture.shellSnapshot(
            projects: [project(id: "project-3", root: "/work/three", identity: identity("three"))]
        )

        let merged = ShellSnapshotMerge.merge(
            previous: previous,
            next: enrichment,
            resolvedRepositoryIdentityRoots: ["/work/three"]
        )

        XCTAssertEqual(merged.projects.map(\.id), ["project-1", "project-2"])
    }

    func testResolvedRootAcceptsIdentityResolvingToNone() {
        let previous = V2Fixture.shellSnapshot(projects: [project(identity: identity("stale"))])
        let enrichment = V2Fixture.shellSnapshot(projects: [project(identity: nil)])

        let merged = ShellSnapshotMerge.merge(
            previous: previous,
            next: enrichment,
            resolvedRepositoryIdentityRoots: ["/work/one"]
        )

        XCTAssertNil(merged.projects.first?.repositoryIdentity)
    }

    func testUnresolvedRootKeepsTheIdentityItAlreadyHas() {
        let previous = V2Fixture.shellSnapshot(projects: [project(identity: identity("one"))])
        let enrichment = V2Fixture.shellSnapshot(projects: [project(identity: nil)])

        let merged = ShellSnapshotMerge.merge(
            previous: previous,
            next: enrichment,
            resolvedRepositoryIdentityRoots: ["/work/elsewhere"]
        )

        XCTAssertEqual(merged.projects.first?.repositoryIdentity, identity("one"))
    }

    func testAuthoritativeFrameReplacesThreadsAndSequence() {
        let previous = V2Fixture.shellSnapshot(
            sequence: 7,
            projects: [project()],
            threads: [V2Fixture.threadShell(id: "thread-1", projectID: "project-1", title: "Work")]
        )
        let next = V2Fixture.shellSnapshot(
            sequence: 9,
            projects: [project(id: "project-2", root: "/work/two")],
            threads: [V2Fixture.threadShell(id: "thread-2", projectID: "project-2", title: "New")]
        )

        let merged = ShellSnapshotMerge.merge(
            previous: previous,
            next: next,
            resolvedRepositoryIdentityRoots: nil
        )

        XCTAssertEqual(merged.threads.map(\.id), ["thread-2"])
        XCTAssertEqual(merged.projects.map(\.id), ["project-2"])
        XCTAssertEqual(merged.snapshotSequence, 9)
    }

    func testAuthoritativeFrameKeepsIdentityEnrichmentAlreadyResolved() {
        let previous = V2Fixture.shellSnapshot(projects: [project(identity: identity("one"))])
        let cold = V2Fixture.shellSnapshot(sequence: 9, projects: [project(identity: nil)])

        let merged = ShellSnapshotMerge.merge(
            previous: previous,
            next: cold,
            resolvedRepositoryIdentityRoots: nil
        )

        XCTAssertEqual(merged.projects.first?.repositoryIdentity, identity("one"))
    }

    func testMovedWorkspaceRootDoesNotInheritTheOldIdentity() {
        let previous = V2Fixture.shellSnapshot(projects: [project(identity: identity("one"))])
        let moved = V2Fixture.shellSnapshot(
            sequence: 9,
            projects: [project(root: "/work/moved", identity: nil)]
        )

        XCTAssertNil(
            ShellSnapshotMerge.merge(
                previous: previous,
                next: moved,
                resolvedRepositoryIdentityRoots: nil
            ).projects.first?.repositoryIdentity
        )
        XCTAssertNil(
            ShellSnapshotMerge.merge(
                previous: previous,
                next: moved,
                resolvedRepositoryIdentityRoots: ["/work/moved"]
            ).projects.first?.repositoryIdentity
        )
    }

    func testFirstFrameIsTakenWholeWithNothingToMergeInto() {
        let next = V2Fixture.shellSnapshot(
            projects: [project()],
            threads: [V2Fixture.threadShell(id: "thread-1", projectID: "project-1", title: "Work")]
        )

        XCTAssertEqual(
            ShellSnapshotMerge.merge(
                previous: nil,
                next: next,
                resolvedRepositoryIdentityRoots: nil
            ),
            next
        )
    }

    func testSnapshotFrameIsAuthoritativeOnlyWithoutTheEnrichmentMarker() throws {
        let body = """
        {"schemaVersion":1,"snapshotSequence":3,"projects":[],"threads":[],"archivedThreads":[]}
        """
        let authoritative = try JSONDecoder.t3.decode(
            OrchestrationV2ShellStreamItem.self,
            from: Data(#"{"kind":"snapshot","snapshot":\#(body)}"#.utf8)
        )
        let enrichment = try JSONDecoder.t3.decode(
            OrchestrationV2ShellStreamItem.self,
            from: Data(
                #"{"kind":"snapshot","snapshot":\#(body),"resolvedRepositoryIdentityRoots":["/work/one"]}"#
                    .utf8
            )
        )

        guard case let .snapshot(_, authoritativeRoots) = authoritative,
              case let .snapshot(_, enrichmentRoots) = enrichment else {
            return XCTFail("Both frames decode as snapshots.")
        }
        XCTAssertNil(authoritativeRoots)
        XCTAssertEqual(enrichmentRoots, ["/work/one"])
    }
}
