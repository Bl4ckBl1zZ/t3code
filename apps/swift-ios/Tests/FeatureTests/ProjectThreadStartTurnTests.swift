import XCTest

@testable import T3Code

/// Ports apps/mobile/src/lib/projectThreadStartTurn.test.ts. The immediate send
/// path and the offline outbox drain both go through this builder, so a drift
/// here shows up as two different commands for the same draft.
final class ProjectThreadStartTurnTests: XCTestCase {
    private func spec(
        text: String = "Summarize my messages",
        attachments: [DraftComposerAttachment] = [],
        workspaceMode: ProjectThreadStartTurnSpec.WorkspaceMode = .local,
        branch: String? = nil,
        worktreePath: String? = nil,
        startFromOrigin: Bool = false,
        prepareWorkspace: Bool? = nil,
        worktreeBranchName: String = "unused"
    ) -> ProjectThreadStartTurnSpec {
        ProjectThreadStartTurnSpec(
            projectID: "project:t3-work",
            projectCwd: "/private/t3-work",
            threadID: "thread:work",
            commandID: "command:work",
            messageID: "message:work",
            createdAt: "2026-07-26T00:00:00.000Z",
            text: text,
            attachments: attachments,
            modelSelection: ModelSelection(instanceId: "hermes-primary", model: "default"),
            runtimeMode: .fullAccess,
            interactionMode: .default,
            workspaceMode: workspaceMode,
            branch: branch,
            worktreePath: worktreePath,
            startFromOrigin: startFromOrigin,
            prepareWorkspace: prepareWorkspace,
            worktreeBranchName: worktreeBranchName
        )
    }

    func testMarksProjectlessWorkLaunchesToSkipBackingProjectPreparation() throws {
        let input = try ProjectThreadStartTurn.buildInput(spec(prepareWorkspace: false))
        let bootstrap = input["bootstrap"]

        XCTAssertEqual(bootstrap?["prepareWorkspace"], .bool(false))
        XCTAssertEqual(
            bootstrap?["createThread"]?["projectId"]?.stringValue,
            "project:t3-work"
        )
        XCTAssertEqual(bootstrap?["createThread"]?["worktreePath"], .null)
        XCTAssertNil(bootstrap?["prepareWorktree"])
    }

    func testOmitsTheWorkspaceOverrideForOrdinaryProjectLaunches() throws {
        let input = try ProjectThreadStartTurn.buildInput(spec())

        XCTAssertNil(input["bootstrap"]?["prepareWorkspace"])
    }

    func testLocalLaunchesKeepTheDraftsWorktreePath() throws {
        let input = try ProjectThreadStartTurn.buildInput(spec(worktreePath: "/private/checkout"))

        XCTAssertEqual(
            input["bootstrap"]?["createThread"]?["worktreePath"]?.stringValue,
            "/private/checkout"
        )
    }

    func testWorktreeLaunchesDropTheDraftPathAndAskTheServerToPrepareOne() throws {
        let input = try ProjectThreadStartTurn.buildInput(
            spec(
                workspaceMode: .worktree,
                branch: "main",
                worktreePath: "/private/stale",
                startFromOrigin: true,
                worktreeBranchName: "t3code/abc12345"
            )
        )
        let bootstrap = input["bootstrap"]

        // The server picks the path during bootstrap; a stale draft path here
        // would send the turn to the wrong checkout.
        XCTAssertEqual(bootstrap?["createThread"]?["worktreePath"], .null)
        XCTAssertEqual(bootstrap?["createThread"]?["branch"]?.stringValue, "main")
        XCTAssertEqual(
            bootstrap?["prepareWorktree"]?["projectCwd"]?.stringValue,
            "/private/t3-work"
        )
        XCTAssertEqual(bootstrap?["prepareWorktree"]?["baseBranch"]?.stringValue, "main")
        XCTAssertEqual(bootstrap?["prepareWorktree"]?["branch"]?.stringValue, "t3code/abc12345")
        XCTAssertEqual(bootstrap?["prepareWorktree"]?["startFromOrigin"], .bool(true))
        XCTAssertEqual(bootstrap?["runSetupScript"], .bool(true))
    }

    func testWorktreeLaunchesOmitStartFromOriginRatherThanSendingFalse() throws {
        let input = try ProjectThreadStartTurn.buildInput(
            spec(workspaceMode: .worktree, branch: "main", worktreeBranchName: "t3code/abc12345")
        )

        XCTAssertNil(input["bootstrap"]?["prepareWorktree"]?["startFromOrigin"])
    }

    func testTitleSeedAndCreateThreadTitleAgree() throws {
        let input = try ProjectThreadStartTurn.buildInput(spec(text: "  Ship   the native app "))

        XCTAssertEqual(input["titleSeed"]?.stringValue, "Ship the native app")
        XCTAssertEqual(
            input["bootstrap"]?["createThread"]?["title"]?.stringValue,
            "Ship the native app"
        )
        // The raw text is what the user actually sent; only the title collapses.
        XCTAssertEqual(input["message"]?["text"]?.stringValue, "  Ship   the native app ")
    }

    func testTitleFallsBackWhenThePromptIsWhitespaceOnly() {
        XCTAssertEqual(ProjectThreadStartTurn.deriveTitle(fromPrompt: "   \n\t "), "New thread")
        XCTAssertEqual(ProjectThreadStartTurn.deriveTitle(fromPrompt: ""), "New thread")
    }

    func testLongTitlesTruncateWithoutStrandingATrailingSpace() {
        let seventyTwo = String(repeating: "a", count: 72)
        XCTAssertEqual(ProjectThreadStartTurn.deriveTitle(fromPrompt: seventyTwo), seventyTwo)

        let seventyThree = String(repeating: "a", count: 73)
        XCTAssertEqual(
            ProjectThreadStartTurn.deriveTitle(fromPrompt: seventyThree),
            "\(String(repeating: "a", count: 69))..."
        )

        // The cut lands right after a space, which must not survive into "... ".
        let cutAtSpace = "\(String(repeating: "a", count: 68)) \(String(repeating: "b", count: 8))"
        XCTAssertEqual(
            ProjectThreadStartTurn.deriveTitle(fromPrompt: cutAtSpace),
            "\(String(repeating: "a", count: 68))..."
        )
    }

    func testTheMessageCarriesWireUploadsRatherThanDrafts() throws {
        let input = try ProjectThreadStartTurn.buildInput(
            spec(attachments: [
                .image(
                    DraftComposerImageAttachment(
                        id: "draft-1",
                        name: "shot.png",
                        mimeType: "image/png",
                        sizeBytes: 12,
                        dataUrl: "data:image/png;base64,AAAA",
                        previewURI: "file:///tmp/shot.png"
                    )
                ),
                .document(
                    DraftComposerDocumentAttachment(
                        id: "draft-2",
                        kind: .pdf,
                        name: "itinerary.pdf",
                        mimeType: "application/pdf",
                        sizeBytes: 1024,
                        dataUrl: "data:application/pdf;base64,AAAA"
                    )
                ),
            ])
        )

        guard case let .array(attachments)? = input["message"]?["attachments"] else {
            return XCTFail("expected an attachment array")
        }
        XCTAssertEqual(attachments.count, 2)
        XCTAssertEqual(attachments[0]["type"]?.stringValue, "image")
        XCTAssertNil(attachments[0]["previewURI"])
        XCTAssertNil(attachments[0]["id"])
        XCTAssertEqual(attachments[1]["type"]?.stringValue, "pdf")
        XCTAssertEqual(attachments[1]["sizeBytes"], .number(1024))
    }

    func testTheCommandIdentifiesItselfAsAMobileCreation() throws {
        let input = try ProjectThreadStartTurn.buildInput(spec())

        XCTAssertEqual(input["creationSource"]?.stringValue, "mobile")
        XCTAssertEqual(input["commandId"]?.stringValue, "command:work")
        XCTAssertEqual(input["threadId"]?.stringValue, "thread:work")
        XCTAssertEqual(input["message"]?["role"]?.stringValue, "user")
        XCTAssertEqual(input["runtimeMode"]?.stringValue, "full-access")
        XCTAssertEqual(input["interactionMode"]?.stringValue, "default")
        XCTAssertEqual(input["createdAt"]?.stringValue, "2026-07-26T00:00:00.000Z")
        XCTAssertEqual(
            input["modelSelection"]?["instanceId"]?.stringValue,
            "hermes-primary"
        )
    }
}
