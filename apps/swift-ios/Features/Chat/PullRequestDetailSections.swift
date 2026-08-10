import Foundation

// The pull-request sheet's rules, kept apart from the view so the timeline
// merge and the status vocabulary are testable without SwiftUI.

/// The two read-only halves of a change request the sheet offers.
enum PullRequestDetailTab: String, CaseIterable {
    case summary = "Summary"
    case timeline = "Timeline"
}

/// A color the view resolves to a `T3Colors` token. Logic names the meaning;
/// only the view knows what green is.
enum PullRequestStatusTone: Equatable, Sendable {
    case success
    case danger
    case warning
    case accent
    case neutral
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

    /// Open reads as live, merged takes the accent, closed as refused. A draft
    /// is not live yet, so it recedes.
    static func stateTone(state: PullRequestState, isDraft: Bool) -> PullRequestStatusTone {
        if isDraft, state == .open { return .neutral }
        switch state {
        case .open: return .success
        case .closed: return .danger
        case .merged: return .accent
        }
    }

    static func branchLine(_ detail: PullRequestDetail) -> String {
        "\(detail.headBranch) → \(detail.baseBranch)"
    }

    static func statsLine(_ detail: PullRequestDetail) -> String {
        let files = detail.changedFiles == 1 ? "1 file" : "\(detail.changedFiles) files"
        return "+\(detail.additions) −\(detail.deletions) · \(files)"
    }

    // MARK: - Checks

    static func checkSymbol(_ status: PullRequestCheckStatus) -> String {
        switch status {
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
        case .pending: .warning
        case .success: .success
        case .failure: .danger
        case .skipped, .neutral, .cancelled: .neutral
        }
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

    /// A review's verdict beside its author, where the host reported one.
    static func reviewStateLabel(_ comment: PullRequestComment) -> String? {
        guard comment.kind == .review, let state = comment.reviewState,
              !state.isEmpty else { return nil }
        return state.replacingOccurrences(of: "_", with: " ").lowercased()
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
