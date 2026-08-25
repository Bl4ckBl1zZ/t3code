import XCTest
@testable import T3Code

/// The wire half of pull-request linking: the command the client sends and the
/// two places the server's answer arrives.
final class ThreadLinkedPullRequestTests: XCTestCase {
    func testLinkCommandCarriesTheWholeReference() throws {
        let command = try OrchestrationCommands.setLinkedPullRequest(
            threadID: "thread-1",
            pullRequest: OrchestrationV2ThreadLinkedPullRequest(
                projectId: "project-1",
                repository: "pingdotgg/t3code",
                number: 42,
                url: "https://github.com/pingdotgg/t3code/pull/42"
            ),
            commandID: "cmd-link"
        )

        XCTAssertEqual(command["type"]?.stringValue, "thread.metadata.update")
        XCTAssertEqual(command["threadId"]?.stringValue, "thread-1")
        XCTAssertEqual(command["commandId"]?.stringValue, "cmd-link")
        let linked = command["linkedPullRequest"]
        XCTAssertEqual(linked?["projectId"]?.stringValue, "project-1")
        XCTAssertEqual(linked?["repository"]?.stringValue, "pingdotgg/t3code")
        XCTAssertEqual(linked?["number"], .number(42))
        XCTAssertEqual(
            linked?["url"]?.stringValue,
            "https://github.com/pingdotgg/t3code/pull/42"
        )
    }

    func testUnlinkSendsExplicitNullRatherThanOmittingTheKey() throws {
        // `thread.metadata.update` leaves absent keys alone, so omitting the
        // field would be "no change" instead of "remove the link".
        let command = try OrchestrationCommands.setLinkedPullRequest(
            threadID: "thread-1",
            pullRequest: nil,
            commandID: "cmd-unlink"
        )
        XCTAssertEqual(command["linkedPullRequest"], JSONValue.null)
    }

    func testShellDecodesALinkedPullRequestAndToleratesItsAbsence() throws {
        let linked = try JSONDecoder.t3.decode(
            OrchestrationV2ThreadShell.self,
            from: Data(shellJSON(linkedPullRequest: """
            , "linkedPullRequest": {
              "projectId": "project-1",
              "repository": "pingdotgg/t3code",
              "number": 42,
              "url": "https://github.com/pingdotgg/t3code/pull/42"
            }
            """).utf8)
        )
        XCTAssertEqual(linked.linkedPullRequest?.number, 42)
        XCTAssertEqual(linked.linkedPullRequest?.repository, "pingdotgg/t3code")

        // A server that predates linking sends no key at all, which has to read
        // as "resolve the pull request from the branch" rather than fail the
        // whole shell decode.
        let unlinked = try JSONDecoder.t3.decode(
            OrchestrationV2ThreadShell.self,
            from: Data(shellJSON(linkedPullRequest: "").utf8)
        )
        XCTAssertNil(unlinked.linkedPullRequest)
    }

    func testCapabilityIsOptionalSoOlderServersHideTheAction() throws {
        let advertised = try JSONDecoder.t3.decode(
            EnvironmentDescriptor.self,
            from: Data("""
            {
              "environmentId": "environment-1",
              "label": "Studio",
              "platform": {"os": "darwin", "arch": "arm64"},
              "serverVersion": "1.0.0",
              "capabilities": {"repositoryIdentity": true, "threadPullRequestLinking": true}
            }
            """.utf8)
        )
        XCTAssertEqual(advertised.capabilities.threadPullRequestLinking, true)

        let silent = try JSONDecoder.t3.decode(
            EnvironmentDescriptor.self,
            from: Data("""
            {
              "environmentId": "environment-1",
              "label": "Studio",
              "platform": {"os": "darwin", "arch": "arm64"},
              "serverVersion": "1.0.0",
              "capabilities": {"repositoryIdentity": true}
            }
            """.utf8)
        )
        XCTAssertNil(silent.capabilities.threadPullRequestLinking)
    }

    private func shellJSON(linkedPullRequest: String) -> String {
        """
        {
          "id": "thread-1",
          "projectId": "project-1",
          "createdBy": "user",
          "creationSource": "mobile",
          "title": "Linked",
          "providerInstanceId": "codex",
          "modelSelection": {"instanceId": "codex", "model": "gpt-5.4"},
          "runtimeMode": "full-access",
          "interactionMode": "default",
          "branch": "feature/linked",
          "worktreePath": null\(linkedPullRequest),
          "lineage": {"rootThreadId": "thread-1", "relationshipToParent": null},
          "forkedFrom": null,
          "activeProviderThreadId": null,
          "latestRunId": null,
          "activeRunId": null,
          "status": "idle",
          "pendingRuntimeRequest": null,
          "latestVisibleMessage": null,
          "hasActionableProposedPlan": false,
          "itemCount": 0,
          "visibleItemCount": 0,
          "createdAt": "2026-08-25T12:00:00.000Z",
          "updatedAt": "2026-08-25T12:00:00.000Z",
          "archivedAt": null,
          "settledOverride": null,
          "settledAt": null,
          "deletedAt": null
        }
        """
    }
}
