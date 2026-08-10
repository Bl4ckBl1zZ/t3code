import Foundation
import Testing
@testable import T3Code

@Suite("Pull request detail sections")
struct PullRequestDetailSectionsTests {
    // MARK: - Fixtures

    private func comment(
        id: String,
        createdAt: String,
        kind: PullRequestCommentKind = .issueComment,
        reviewState: String? = nil
    ) -> PullRequestComment {
        PullRequestComment(
            id: id,
            kind: kind,
            author: PullRequestActor(login: "octocat", name: nil, avatarUrl: nil),
            body: "Looks good",
            createdAt: createdAt,
            url: nil,
            path: nil,
            reviewState: reviewState
        )
    }

    private func commit(oid: String, committedDate: String) -> PullRequestCommit {
        PullRequestCommit(
            oid: oid,
            messageHeadline: "Fix the thing",
            committedDate: committedDate,
            additions: nil,
            deletions: nil,
            authors: nil
        )
    }

    private func activity(
        comments: [PullRequestComment] = [],
        commentCount: Int? = nil,
        commentsTruncated: Bool = false,
        commits: [PullRequestCommit] = []
    ) -> PullRequestActivity {
        PullRequestActivity(
            author: nil,
            reviewers: nil,
            comments: comments,
            commentCount: commentCount ?? comments.count,
            commentsTruncated: commentsTruncated,
            reviewThreads: [],
            commits: commits
        )
    }

    // MARK: - Timeline

    @Test
    func mergesCommentsAndCommitsChronologically() {
        let entries = PullRequestDetailSections.timeline(activity(
            comments: [
                comment(id: "late", createdAt: "2026-08-03T10:00:00Z"),
                comment(id: "early", createdAt: "2026-08-01T10:00:00Z"),
            ],
            commits: [commit(oid: "abc1234def", committedDate: "2026-08-02T10:00:00Z")]
        ))

        #expect(entries.map(\.id) == ["comment-early", "commit-abc1234def", "comment-late"])
    }

    @Test
    func parsesFractionalAndPlainDatesAlike() {
        let entries = PullRequestDetailSections.timeline(activity(
            comments: [
                comment(id: "fractional", createdAt: "2026-08-01T10:00:00.500Z"),
                comment(id: "plain", createdAt: "2026-08-01T10:00:00Z"),
            ]
        ))

        #expect(entries.map(\.id) == ["comment-plain", "comment-fractional"])
        #expect(entries.allSatisfy { $0.date != nil })
    }

    @Test
    func sinksUnparseableDatesToTheEnd() {
        let entries = PullRequestDetailSections.timeline(activity(
            comments: [
                comment(id: "undated", createdAt: "not-a-date"),
                comment(id: "dated", createdAt: "2026-08-01T10:00:00Z"),
            ]
        ))

        #expect(entries.map(\.id) == ["comment-dated", "comment-undated"])
    }

    // MARK: - Truncation

    @Test
    func truncationNoteCountsTheMissingRemarks() {
        let note = PullRequestDetailSections.truncationNote(activity(
            comments: [comment(id: "one", createdAt: "2026-08-01T10:00:00Z")],
            commentCount: 4,
            commentsTruncated: true
        ))

        #expect(note == "3 more comments — open in browser for the full conversation")
    }

    @Test
    func wholeConversationHasNoTruncationNote() {
        let note = PullRequestDetailSections.truncationNote(activity(
            comments: [comment(id: "one", createdAt: "2026-08-01T10:00:00Z")]
        ))

        #expect(note == nil)
    }

    // MARK: - Header

    @Test
    func stateLabelsAndTones() {
        #expect(PullRequestDetailSections.stateLabel(state: .open, isDraft: false) == "Open")
        #expect(PullRequestDetailSections.stateLabel(state: .open, isDraft: true) == "Draft")
        #expect(PullRequestDetailSections.stateLabel(state: .merged, isDraft: false) == "Merged")
        #expect(PullRequestDetailSections.stateTone(state: .open, isDraft: false) == .success)
        #expect(PullRequestDetailSections.stateTone(state: .open, isDraft: true) == .neutral)
        #expect(PullRequestDetailSections.stateTone(state: .merged, isDraft: false) == .accent)
        #expect(PullRequestDetailSections.stateTone(state: .closed, isDraft: false) == .danger)
    }

    // MARK: - Checks

    @Test
    func checkStatusMapsToSymbolAndTone() {
        #expect(PullRequestDetailSections.checkSymbol(.success) == "checkmark.circle.fill")
        #expect(PullRequestDetailSections.checkTone(.success) == .success)
        #expect(PullRequestDetailSections.checkTone(.failure) == .danger)
        #expect(PullRequestDetailSections.checkTone(.pending) == .warning)
        #expect(PullRequestDetailSections.checkTone(.skipped) == .neutral)
    }

    // MARK: - Labels

    @Test
    func reviewVerdictReadsAsWords() {
        let review = comment(
            id: "review",
            createdAt: "2026-08-01T10:00:00Z",
            kind: .review,
            reviewState: "CHANGES_REQUESTED"
        )

        #expect(PullRequestDetailSections.reviewStateLabel(review) == "changes requested")
        #expect(PullRequestDetailSections.reviewStateLabel(
            comment(id: "plain", createdAt: "2026-08-01T10:00:00Z")
        ) == nil)
    }

    @Test
    func shortOidTakesSevenCharacters() {
        #expect(PullRequestDetailSections.shortOid("abc1234def5678") == "abc1234")
        #expect(PullRequestDetailSections.shortOid("abc") == "abc")
    }
}
