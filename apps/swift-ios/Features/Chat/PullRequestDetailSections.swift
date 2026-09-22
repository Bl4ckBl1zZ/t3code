import Foundation

// The pull-request sheet's rules, kept apart from the view so the timeline
// merge and the status vocabulary are testable without SwiftUI.

/// Sections of a change request available from a thread or the workspace.
enum PullRequestDetailTab: String, CaseIterable {
    case summary = "Summary"
    case timeline = "Timeline"
    case code = "Code"
}

/// A color the view resolves to a `T3Colors` token. Logic names the meaning;
/// only the view knows what green is.
enum PullRequestStatusTone: Equatable, Sendable {
    case success
    case danger
    case warning
    case accent
    /// Merged: done and accepted, which is neither live nor refused.
    case merged
    case neutral
}

/// A review that says something about the change itself, rather than only
/// carrying remarks. `COMMENTED` is not one of these: it is a remark with a
/// review attached, not a verdict.
enum PullRequestReviewOutcome: Equatable, Sendable {
    case approved
    case changesRequested
    case dismissed

    /// Hosts spell the same three differently — GitHub reports
    /// `CHANGES_REQUESTED`, Bitbucket `changes_requested` — so case and
    /// separator are ignored, and anything else is not a verdict.
    init?(reviewState: String?) {
        let normalized = reviewState?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
        switch normalized {
        case "approved": self = .approved
        case "changes-requested": self = .changesRequested
        case "dismissed": self = .dismissed
        default: return nil
        }
    }

    var label: String {
        switch self {
        case .approved: "Approved"
        case .changesRequested: "Changes Requested"
        case .dismissed: "Review Dismissed"
        }
    }

    /// What a superseded verdict says: the same word with when it applied
    /// added, because commits landed after it and it stands for code the
    /// branch no longer has.
    var staleLabel: String {
        "\(label) earlier changes"
    }

    var tone: PullRequestStatusTone {
        switch self {
        case .approved: .success
        case .changesRequested: .danger
        case .dismissed: .neutral
        }
    }

    var symbol: String {
        switch self {
        case .approved: "checkmark.circle.fill"
        case .changesRequested: "xmark.circle.fill"
        case .dismissed: "circle.dotted"
        }
    }
}

/// Where one reviewer landed, which is what "is this approved?" actually asks.
struct PullRequestReviewOutcomeEntry: Identifiable, Equatable, Sendable {
    /// What made this entry its own reviewer. A login where the host reported
    /// one, and otherwise the review's own id — so two authorless verdicts stay
    /// two rows rather than collapsing into one.
    let id: String
    let actor: PullRequestActor?
    let outcome: PullRequestReviewOutcome
    let at: String
    /// Commits landed after this verdict, so it speaks for code that is no
    /// longer on the branch.
    let isStale: Bool

    var label: String { isStale ? outcome.staleLabel : outcome.label }
}

/// One row of the Reviewers section: everyone asked, plus everyone who ruled
/// without being asked, each with their standing verdict or nothing yet.
struct PullRequestReviewerRow: Identifiable, Equatable, Sendable {
    let id: String
    let login: String
    let entry: PullRequestReviewOutcomeEntry?
}

/// One check with its position in the host's list, which is its identity:
/// matrix jobs repeat a name, and a name alone collides.
struct PullRequestCheckEntry: Identifiable, Equatable, Sendable {
    let id: Int
    let check: PullRequestCheck
}

/// The Checks section of the detail sheet, grouped by what needs the reader.
struct PullRequestChecksSummary: Equatable, Sendable {
    /// Failed and action-required checks, failures first.
    let attention: [PullRequestCheckEntry]
    let running: [PullRequestCheckEntry]
    /// Passed, skipped, neutral and cancelled: nothing to do, so collapsed.
    let settled: [PullRequestCheckEntry]

    var total: Int { attention.count + running.count + settled.count }
    var isAllPassing: Bool { attention.isEmpty && running.isEmpty && total > 0 }

    /// "All checks passed", or the counts that need attention, worst first.
    var headline: String {
        if isAllPassing { return "All checks passed" }
        let failing = attention.filter { $0.check.status == .failure }.count
        let actionRequired = attention.count - failing
        var parts: [String] = []
        if failing > 0 { parts.append("\(failing) failing") }
        if actionRequired > 0 { parts.append("\(actionRequired) need\(actionRequired == 1 ? "s" : "") action") }
        if !running.isEmpty { parts.append("\(running.count) in progress") }
        return parts.joined(separator: " · ")
    }

    /// Segment sizes for the proportional bar, in draw order.
    var segments: [(tone: PullRequestStatusTone, count: Int)] {
        let failing = attention.filter { $0.check.status == .failure }.count
        let warning = attention.count - failing + running.count
        let passed = settled.filter { $0.check.status == .success }.count
        return [
            (PullRequestStatusTone.danger, failing),
            (.warning, warning),
            (.success, passed),
            (.neutral, settled.count - passed),
        ].filter { $0.count > 0 }
    }
}

/// One row of the Timeline tab: the conversation and the commits, merged into
/// a single chronology.
struct PullRequestTimelineEntry: Identifiable, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case comment(PullRequestComment)
        case commit(PullRequestCommit)
    }

    let id: String
    let date: Date?
    let kind: Kind
}

enum PullRequestDetailSections {
    // MARK: - Header

    static func stateLabel(state: PullRequestState, isDraft: Bool) -> String {
        if isDraft, state == .open { return "Draft" }
        switch state {
        case .open: return "Open"
        case .closed: return "Closed"
        case .merged: return "Merged"
        }
    }

    /// Open reads as live, merged as accepted, closed as refused. A draft is
    /// not live yet, so it recedes. Every pull-request surface reads this one
    /// map, so a state never changes color between screens.
    static func stateTone(state: PullRequestState, isDraft: Bool) -> PullRequestStatusTone {
        if isDraft, state == .open { return .neutral }
        switch state {
        case .open: return .success
        case .closed: return .danger
        case .merged: return .merged
        }
    }

    static func stateSymbol(state: PullRequestState, isDraft: Bool) -> String {
        if isDraft, state == .open { return "circle.dashed" }
        switch state {
        case .open: return T3Symbol.pullRequest
        case .closed: return "xmark.circle"
        case .merged: return "arrow.triangle.merge"
        }
    }

    static func branchLine(_ detail: PullRequestDetail) -> String {
        "\(detail.headBranch) → \(detail.baseBranch)"
    }

    static func statsLine(_ detail: PullRequestDetail) -> String {
        let files = detail.changedFiles == 1 ? "1 file" : "\(detail.changedFiles) files"
        return "+\(detail.additions) −\(detail.deletions) · \(files)"
    }

    /// The header's second line: repository and number. The title is the
    /// headline, so the number is not repeated in front of it.
    static func repositoryLine(_ detail: PullRequestDetail) -> String {
        "#\(detail.number) · \(detail.repository)"
    }

    /// Size, then who wrote it — or, once merged, when it landed.
    static func headerMeta(_ detail: PullRequestDetail, now: Date = .now) -> String {
        var parts = [statsLine(detail)]
        if detail.state == .merged, let mergedAt = detail.mergedAt, let when = relativeLabel(mergedAt, now: now) {
            parts.append("merged \(when)")
        } else if let author = detail.author {
            parts.append("by \(author.login)")
        }
        return parts.joined(separator: " · ")
    }

    /// "Auto-Merge · Squash", or just "Auto-Merge" when the host did not say how.
    static func autoMergeLabel(_ detail: PullRequestDetail) -> String? {
        guard detail.state == .open, detail.autoMergeEnabled == true else { return nil }
        guard let method = detail.autoMergeMethod, !method.isEmpty else { return "Auto-Merge" }
        return "Auto-Merge · \(method.capitalized)"
    }

    /// "3 commits behind main" for the behind-base banner.
    static func behindLabel(_ detail: PullRequestDetail) -> String? {
        guard detail.state == .open, detail.baseComparison == "behind" else { return nil }
        guard let count = detail.behindBy else { return "Behind \(detail.baseBranch)" }
        return "\(count) \(count == 1 ? "commit" : "commits") behind \(detail.baseBranch)"
    }

    // MARK: - Checks

    static func checkSymbol(_ status: PullRequestCheckStatus) -> String {
        switch status {
        case .actionRequired: "exclamationmark.circle"
        case .pending: "clock"
        case .success: "checkmark.circle.fill"
        case .failure: "xmark.circle.fill"
        case .skipped: "arrow.right.circle"
        case .neutral: "circle"
        case .cancelled: "slash.circle"
        }
    }

    static func checkTone(_ status: PullRequestCheckStatus) -> PullRequestStatusTone {
        switch status {
        case .pending, .actionRequired: .warning
        case .success: .success
        case .failure: .danger
        case .skipped, .neutral, .cancelled: .neutral
        }
    }

    /// Checks regrouped by what the reader has to do about them: failures
    /// first, then runs still going, then everything settled, each group in
    /// host order. Identity is the host position, because matrix jobs share a
    /// name.
    static func checksSummary(_ checks: [PullRequestCheck]) -> PullRequestChecksSummary {
        let entries = checks.enumerated().map { PullRequestCheckEntry(id: $0.offset, check: $0.element) }
        func rank(_ status: PullRequestCheckStatus) -> Int? {
            switch status {
            case .failure: 0
            case .actionRequired: 1
            default: nil
            }
        }
        let attention = entries
            .filter { rank($0.check.status) != nil }
            .sorted { (rank($0.check.status) ?? 0, $0.id) < (rank($1.check.status) ?? 0, $1.id) }
        return PullRequestChecksSummary(
            attention: attention,
            running: entries.filter { $0.check.status == .pending },
            settled: entries.filter {
                [.success, .skipped, .neutral, .cancelled].contains($0.check.status)
            }
        )
    }

    // MARK: - Review verdicts

    /// The newest commit on the branch, which is what a verdict is current
    /// against. Nil where the host reported no commits — or none with a date
    /// that parses — since nothing can then be said to predate them.
    static func newestCommitDate(_ commits: [PullRequestCommit]) -> Date? {
        commits.compactMap { parseDate($0.committedDate) }.max()
    }

    /// Whether a verdict was given before the code it was given on.
    ///
    /// Measured against commit dates, which is all the activity carries. That
    /// is a proxy and not the question — a commit date says when the work was
    /// written, not when it reached this change request — so it errs towards
    /// leaving a verdict alone and dims only where the branch plainly moved on.
    static func isVerdictStale(at iso: String, newestCommitDate: Date?) -> Bool {
        guard let newestCommitDate, let verdictAt = parseDate(iso) else { return false }
        return verdictAt < newestCommitDate
    }

    /// Each reviewer's last word, one entry per person, in the order the host
    /// first mentioned them. A host keeps every review anybody ever submitted,
    /// and an approval later followed by a request for changes is not an
    /// approval any more. A dismissal is a verdict taken back, so it leaves
    /// nothing to show rather than showing itself.
    static func latestReviewOutcomes(
        comments: [PullRequestComment],
        commits: [PullRequestCommit] = []
    ) -> [PullRequestReviewOutcomeEntry] {
        let newestCommit = newestCommitDate(commits)
        var latest: [String: PullRequestReviewOutcomeEntry] = [:]
        var order: [String] = []
        for comment in comments {
            guard let outcome = PullRequestReviewOutcome(reviewState: comment.reviewState) else {
                continue
            }
            // Two deleted accounts are two reviewers. Keying both as "ghost"
            // would let one overwrite the other and undercount the verdicts.
            let key = comment.author?.login ?? "ghost:\(comment.id)"
            // Not every host returns its reviews in order, so the newest wins
            // rather than the last read. An unparseable date never displaces a
            // dated verdict.
            if let current = latest[key] {
                let currentAt = parseDate(current.at) ?? .distantPast
                let candidateAt = parseDate(comment.createdAt) ?? .distantPast
                if currentAt > candidateAt { continue }
            } else {
                order.append(key)
            }
            latest[key] = PullRequestReviewOutcomeEntry(
                id: key,
                actor: comment.author,
                outcome: outcome,
                at: comment.createdAt,
                isStale: isVerdictStale(at: comment.createdAt, newestCommitDate: newestCommit)
            )
        }
        return order.compactMap { latest[$0] }.filter { $0.outcome != .dismissed }
    }

    /// The Reviewers section: everyone the change request asked, in the order
    /// the host listed them, followed by anyone who ruled without being asked.
    /// Requested reviewers keep their row with no verdict, because "asked and
    /// silent" is an answer the reader needs.
    static func reviewerRows(
        reviewers: [PullRequestActor],
        outcomes: [PullRequestReviewOutcomeEntry]
    ) -> [PullRequestReviewerRow] {
        var byLogin: [String: PullRequestReviewOutcomeEntry] = [:]
        for entry in outcomes {
            guard let login = entry.actor?.login else { continue }
            byLogin[login] = entry
        }
        var seen = Set<String>()
        var rows = reviewers.compactMap { actor -> PullRequestReviewerRow? in
            guard seen.insert(actor.login).inserted else { return nil }
            return PullRequestReviewerRow(
                id: actor.login,
                login: actor.login,
                entry: byLogin[actor.login]
            )
        }
        for entry in outcomes where !seen.contains(entry.actor?.login ?? entry.id) {
            let login = entry.actor?.login ?? "Unknown"
            seen.insert(entry.actor?.login ?? entry.id)
            rows.append(PullRequestReviewerRow(id: entry.id, login: login, entry: entry))
        }
        return rows
    }

    // MARK: - Timeline

    /// Comments and commits in one chronology, oldest first. Review threads are
    /// not folded in: on the hosts that report both, a thread's remarks already
    /// appear in `comments` as review comments, and the sheet has no diff to
    /// pin a thread to anyway.
    static func timeline(_ activity: PullRequestActivity) -> [PullRequestTimelineEntry] {
        var entries = activity.comments.map { comment in
            PullRequestTimelineEntry(
                id: "comment-\(comment.id)",
                date: parseDate(comment.createdAt),
                kind: .comment(comment)
            )
        }
        entries += activity.commits.map { commit in
            PullRequestTimelineEntry(
                id: "commit-\(commit.oid)",
                date: parseDate(commit.committedDate),
                kind: .commit(commit)
            )
        }
        // Stable: same-instant entries keep comments before commits, and an
        // undated entry sinks to the end rather than jumping around.
        return entries.enumerated().sorted { lhs, rhs in
            let left = lhs.element.date ?? .distantFuture
            let right = rhs.element.date ?? .distantFuture
            if left != right { return left < right }
            return lhs.offset < rhs.offset
        }.map(\.element)
    }

    /// A note for remarks the host holds that the read stopped short of.
    /// Nil when the conversation was read whole.
    static func truncationNote(_ activity: PullRequestActivity) -> String? {
        guard activity.commentsTruncated else { return nil }
        let missing = activity.commentCount - activity.comments.count
        guard missing > 0 else { return nil }
        let noun = missing == 1 ? "comment" : "comments"
        return "\(missing) more \(noun) — open in browser for the full conversation"
    }

    static func shortOid(_ oid: String) -> String {
        String(oid.prefix(7))
    }

    static func commentAuthorLabel(_ comment: PullRequestComment) -> String {
        comment.author?.login ?? "Unknown"
    }

    /// A review's verdict beside its author, where it gave one. Only reviews
    /// carry these; a review comment's `reviewState` describes the review it
    /// belongs to, not the remark.
    static func reviewOutcome(_ comment: PullRequestComment) -> PullRequestReviewOutcome? {
        guard comment.kind == .review else { return nil }
        return PullRequestReviewOutcome(reviewState: comment.reviewState)
    }

    /// The remaining review states, which are remarks rather than verdicts —
    /// GitHub's `COMMENTED`, or a state no host here reports yet. Nil once
    /// `reviewOutcome` has claimed it, so the two never both render.
    static func reviewStateLabel(_ comment: PullRequestComment) -> String? {
        guard comment.kind == .review, let state = comment.reviewState,
              !state.isEmpty, reviewOutcome(comment) == nil else { return nil }
        let words = state.replacingOccurrences(of: "_", with: " ").lowercased()
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    // MARK: - Dates

    /// `IsoDateTime` arrives with or without fractional seconds depending on
    /// the host; both have to parse or a timeline entry loses its place.
    static func parseDate(_ iso: String) -> Date? {
        fractionalFormatter.date(from: iso) ?? plainFormatter.date(from: iso)
    }

    static func relativeLabel(_ iso: String, now: Date = .now) -> String? {
        guard let date = parseDate(iso) else { return nil }
        if now.timeIntervalSince(date) < 60 { return "just now" }
        return relativeFormatter.localizedString(for: date, relativeTo: now)
    }

    private static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plainFormatter = ISO8601DateFormatter()

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()
}
