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
        reviewState: String? = nil,
        author: String? = "octocat"
    ) -> PullRequestComment {
        PullRequestComment(
            id: id,
            kind: kind,
            author: author.map { PullRequestActor(login: $0, name: nil, avatarUrl: nil) },
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
    func verdictStatesReadAsVerdictsAndTheRestAsWords() {
        let review = comment(
            id: "review",
            createdAt: "2026-08-01T10:00:00Z",
            kind: .review,
            reviewState: "CHANGES_REQUESTED"
        )

        // A verdict is claimed by `reviewOutcome`, so the plain-words label
        // stands down and the two never both render.
        #expect(PullRequestDetailSections.reviewOutcome(review) == .changesRequested)
        #expect(PullRequestDetailSections.reviewStateLabel(review) == nil)

        // A remark with a review attached is not a verdict.
        let commented = comment(
            id: "commented",
            createdAt: "2026-08-01T10:00:00Z",
            kind: .review,
            reviewState: "COMMENTED"
        )
        #expect(PullRequestDetailSections.reviewOutcome(commented) == nil)
        #expect(PullRequestDetailSections.reviewStateLabel(commented) == "commented")

        // A review comment's state describes the review it belongs to.
        let reviewComment = comment(
            id: "inline",
            createdAt: "2026-08-01T10:00:00Z",
            kind: .reviewComment,
            reviewState: "APPROVED"
        )
        #expect(PullRequestDetailSections.reviewOutcome(reviewComment) == nil)
        #expect(PullRequestDetailSections.reviewStateLabel(reviewComment) == nil)
    }

    // MARK: - Review verdicts

    @Test
    func normalizesHostSpellingsOfTheSameVerdict() {
        #expect(PullRequestReviewOutcome(reviewState: "CHANGES_REQUESTED") == .changesRequested)
        #expect(PullRequestReviewOutcome(reviewState: "changes_requested") == .changesRequested)
        #expect(PullRequestReviewOutcome(reviewState: " Approved ") == .approved)
        #expect(PullRequestReviewOutcome(reviewState: "DISMISSED") == .dismissed)
        #expect(PullRequestReviewOutcome(reviewState: "COMMENTED") == nil)
        #expect(PullRequestReviewOutcome(reviewState: nil) == nil)
        #expect(PullRequestReviewOutcome(reviewState: "") == nil)
    }

    @Test
    func keepsOnlyEachReviewersLastWord() {
        let outcomes = PullRequestDetailSections.latestReviewOutcomes(comments: [
            comment(
                id: "a1", createdAt: "2026-08-01T10:00:00Z", kind: .review,
                reviewState: "APPROVED", author: "octocat"
            ),
            comment(
                id: "a2", createdAt: "2026-08-02T10:00:00Z", kind: .review,
                reviewState: "CHANGES_REQUESTED", author: "octocat"
            ),
            comment(
                id: "b1", createdAt: "2026-08-01T09:00:00Z", kind: .review,
                reviewState: "APPROVED", author: "hubot"
            ),
        ])

        #expect(outcomes.count == 2)
        #expect(outcomes.first?.id == "octocat")
        // The later request for changes replaced the earlier approval.
        #expect(outcomes.first?.outcome == .changesRequested)
        #expect(outcomes.last?.outcome == .approved)
    }

    @Test
    func takesTheNewestVerdictEvenWhenTheHostReportsThemOutOfOrder() {
        let outcomes = PullRequestDetailSections.latestReviewOutcomes(comments: [
            comment(
                id: "late", createdAt: "2026-08-05T10:00:00Z", kind: .review,
                reviewState: "APPROVED", author: "octocat"
            ),
            comment(
                id: "early", createdAt: "2026-08-01T10:00:00Z", kind: .review,
                reviewState: "CHANGES_REQUESTED", author: "octocat"
            ),
        ])

        #expect(outcomes.map(\.outcome) == [.approved])
    }

    @Test
    func dismissalsLeaveNothingToShow() {
        let outcomes = PullRequestDetailSections.latestReviewOutcomes(comments: [
            comment(
                id: "a1", createdAt: "2026-08-01T10:00:00Z", kind: .review,
                reviewState: "APPROVED", author: "octocat"
            ),
            comment(
                id: "a2", createdAt: "2026-08-02T10:00:00Z", kind: .review,
                reviewState: "DISMISSED", author: "octocat"
            ),
        ])

        #expect(outcomes.isEmpty)
    }

    @Test
    func twoAuthorlessVerdictsStayTwoReviewers() {
        let outcomes = PullRequestDetailSections.latestReviewOutcomes(comments: [
            comment(
                id: "g1", createdAt: "2026-08-01T10:00:00Z", kind: .review,
                reviewState: "APPROVED", author: nil
            ),
            comment(
                id: "g2", createdAt: "2026-08-02T10:00:00Z", kind: .review,
                reviewState: "CHANGES_REQUESTED", author: nil
            ),
        ])

        #expect(outcomes.count == 2)
    }

    @Test
    func dimsOnlyVerdictsTheBranchMovedPast() {
        let comments = [
            comment(
                id: "old", createdAt: "2026-08-01T10:00:00Z", kind: .review,
                reviewState: "APPROVED", author: "octocat"
            ),
            comment(
                id: "new", createdAt: "2026-08-03T10:00:00Z", kind: .review,
                reviewState: "APPROVED", author: "hubot"
            ),
        ]
        let outcomes = PullRequestDetailSections.latestReviewOutcomes(
            comments: comments,
            commits: [commit(oid: "abc", committedDate: "2026-08-02T10:00:00Z")]
        )

        #expect(outcomes.first?.isStale == true)
        #expect(outcomes.first?.label == "Approved earlier changes")
        #expect(outcomes.last?.isStale == false)
        #expect(outcomes.last?.label == "Approved")

        // Offset and UTC timestamps are compared as instants, not as text:
        // 01:00+02:00 falls before 00:30Z despite sorting after it.
        #expect(PullRequestDetailSections.isVerdictStale(
            at: "2026-08-05T01:00:00+02:00",
            newestCommitDate: PullRequestDetailSections.parseDate("2026-08-05T00:30:00Z")
        ) == false)

        // No commits means nothing to be stale against.
        #expect(PullRequestDetailSections.latestReviewOutcomes(comments: comments)
            .allSatisfy { !$0.isStale })
    }

    @Test
    func reviewerRowsKeepTheSilentAndAddTheUnasked() {
        let outcomes = PullRequestDetailSections.latestReviewOutcomes(comments: [
            comment(
                id: "a1", createdAt: "2026-08-01T10:00:00Z", kind: .review,
                reviewState: "APPROVED", author: "octocat"
            ),
            comment(
                id: "b1", createdAt: "2026-08-01T11:00:00Z", kind: .review,
                reviewState: "CHANGES_REQUESTED", author: "passerby"
            ),
        ])
        let rows = PullRequestDetailSections.reviewerRows(
            reviewers: [
                PullRequestActor(login: "octocat", name: nil, avatarUrl: nil),
                PullRequestActor(login: "hubot", name: nil, avatarUrl: nil),
            ],
            outcomes: outcomes
        )

        #expect(rows.map(\.login) == ["octocat", "hubot", "passerby"])
        #expect(rows[0].entry?.outcome == .approved)
        // Asked and silent is an answer the reader needs, so the row stays.
        #expect(rows[1].entry == nil)
        #expect(rows[2].entry?.outcome == .changesRequested)
    }

    @Test
    func shortOidTakesSevenCharacters() {
        #expect(PullRequestDetailSections.shortOid("abc1234def5678") == "abc1234")
        #expect(PullRequestDetailSections.shortOid("abc") == "abc")
    }
}
