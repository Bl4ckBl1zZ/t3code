import Foundation
import Testing
@testable import T3Code

@Suite("Thread screen chrome")
struct ThreadScreenChromeTests {
    private let now = Date(timeIntervalSince1970: 100_000)

    private func thread(
        _ state: FeatureThreadState = .idle,
        branch: String? = "feature/login",
        configure: (inout FeatureThread) -> Void = { _ in }
    ) -> FeatureThread {
        var thread = FeatureThread(id: "thread", projectID: "project", title: "Task", state: state)
        thread.branch = branch
        configure(&thread)
        return thread
    }

    private func subtitle(
        _ thread: FeatureThread,
        connection: FeatureConnection.State? = .connected
    ) -> ThreadHeaderSubtitle {
        ThreadHeaderSubtitle.resolve(thread: thread, environmentName: "MacBook", connection: connection, now: now)
    }

    @Test
    func aCodeThreadReadsStateThenBranchThenEnvironment() {
        let working = subtitle(thread(.working) { $0.workingStartedAt = now.addingTimeInterval(-200) })
        #expect(working.plainText == "Working 3m · feature/login · MacBook")
        #expect(working.status?.tone == .running)
    }

    @Test
    func theFirstMinuteOfWorkHasNoDuration() {
        let working = subtitle(thread(.working) { $0.workingStartedAt = now.addingTimeInterval(-20) })
        #expect(working.status?.label == "Working")
    }

    @Test
    func aChatThreadNamesItselfInsteadOfABranch() {
        let chat = subtitle(thread(branch: "main") { $0.workInboxRole = "chat" })
        #expect(chat.plainText == "Chat · MacBook")
    }

    @Test
    func anIdleThreadSaysNoStateAndNoPlaceholderBranch() {
        #expect(subtitle(thread()).status == nil)
        #expect(subtitle(thread(branch: nil)).details == ["MacBook"])
        let worktree = subtitle(thread(branch: nil) { $0.worktreePath = "/tmp/worktrees/fix-login" })
        #expect(worktree.details == ["fix-login", "MacBook"])
    }

    @Test
    func anUnreachableEnvironmentOutranksTheThreadsOwnState() {
        let offline = subtitle(thread(.waitingForApproval), connection: .disconnected)
        #expect(offline.status?.label == "Offline")
        let reconnecting = subtitle(thread(.working), connection: .reconnecting)
        #expect(reconnecting.status?.label == "Reconnecting…")
    }

    @Test
    func blockedStatesNameWhatTheyWaitFor() {
        #expect(subtitle(thread(.waitingForApproval)).status?.label == "Needs approval")
        #expect(subtitle(thread(.waitingForInput)).status?.label == "Needs input")
        #expect(subtitle(thread(.failed)).status?.tone == .danger)
    }

    @Test
    func archiveAndSnoozeOnlyShowWhenNothingIsHappening() {
        #expect(subtitle(thread { $0.isArchived = true }).status?.label == "Archived")
        let snoozed = subtitle(thread { $0.snoozedUntil = now.addingTimeInterval(3_600) })
        #expect(snoozed.status?.label.hasPrefix("Snoozed until") == true)
        let expired = subtitle(thread { $0.snoozedUntil = now.addingTimeInterval(-60) })
        #expect(expired.status == nil)
        let archivedButWorking = subtitle(thread(.working) { $0.isArchived = true })
        #expect(archivedButWorking.status?.tone == .running)
    }

    @Test
    func outboxCaptionsFollowDelivery() {
        #expect(ThreadMessageCaption.outbox(.waiting, hasAttachments: false) == .waitingForConnection)
        #expect(ThreadMessageCaption.outbox(.sending, hasAttachments: true).label == "Uploading…")
        #expect(ThreadMessageCaption.outbox(.sending, hasAttachments: false).label == "Sending…")
        let failed = ThreadMessageCaption.outbox(.failed, hasAttachments: false)
        #expect(failed == .failed)
        #expect(failed.isDelivery)
        #expect(!ThreadMessageCaption.scheduled.isDelivery)
    }

    @Test
    func theQueueHeadLocksOnlyOnceNothingRunsAheadOfIt() {
        let queued = ThreadWorkflowRun(id: "next", ordinal: 2, status: "queued")
        let behindARun = ThreadWorkflows.deriveQueueWorkflowState(
            runs: [ThreadWorkflowRun(id: "active", ordinal: 1, status: "running"), queued]
        )
        #expect(behindARun.dispatchingRunID == nil)
        let starting = ThreadWorkflows.deriveQueueWorkflowState(
            runs: [ThreadWorkflowRun(id: "done", ordinal: 1, status: "completed"), queued]
        )
        #expect(starting.dispatchingRunID == "next")
    }

    @Test
    func reviewThreadCommentCountsAgreeInNumber() {
        #expect(PullRequestThreadCard.commentCount(1) == "1 comment")
        #expect(PullRequestThreadCard.commentCount(0) == "0 comments")
        #expect(PullRequestThreadCard.commentCount(4) == "4 comments")
    }

    @Test
    func pullRequestLinksUseTheirHostsNumbering() throws {
        let github = try #require(PullRequestLinkTarget(URL(string: "https://github.com/t3/code/pull/482")!))
        #expect(github.displayNumber == "#482")
        let gitlab = try #require(
            PullRequestLinkTarget(URL(string: "https://gitlab.com/t3/code/-/merge_requests/482")!)
        )
        #expect(gitlab.displayNumber == "!482")
    }

    @Test
    func codeHighlightingOnlyColoursLanguagesTheLexerKnows() {
        #expect(MarkdownCodeHighlighting.lexerLanguage(for: "TSX") == "typescript")
        #expect(MarkdownCodeHighlighting.lexerLanguage(for: "zsh") == "shell")
        #expect(MarkdownCodeHighlighting.lexerLanguage(for: "text") == nil)
        #expect(MarkdownCodeHighlighting.lexerLanguage(for: nil) == nil)

        let code = "let x = 1 // one\nreturn \"x\""
        let highlighted = MarkdownCodeHighlighting.highlight(code, language: "swift")
        #expect(String(highlighted.characters) == code)
    }

    @Test
    func aRenderedDocumentPreparesItsCodeColours() async {
        let cache = MarkdownRenderCache()
        let code = "func greet() {}"
        #expect(cache.codeHighlight(language: "swift", code: code) == nil)
        _ = await cache.document(for: MarkdownContentRevision("```swift\n\(code)\n```"))
        #expect(cache.codeHighlight(language: "swift", code: code) != nil)
        #expect(cache.codeHighlight(language: "text", code: code) == nil)
    }
}
