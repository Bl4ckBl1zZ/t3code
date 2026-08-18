import SwiftUI

// A read-only, native view of one change request: the summary the host's page
// leads with, and the conversation-plus-commits chronology under it. Opened
// from the thread details sheet's Version Control section; anything beyond
// reading — reviews, merges, comments — stays in the browser, one tap away.
//
// Every rule lives in PullRequestDetailSections.swift; this file is the view.

struct PullRequestDetailSheet: View {
    let client: any FeatureClient
    let threadID: String
    let number: Int

    @State private var overview: FeaturePullRequestOverview?
    @State private var loadError: String?
    @State private var tab: PullRequestDetailTab = .summary
    @SwiftUI.Environment(\.openURL) private var openURL

    var body: some View {
        Group {
            if let overview {
                content(overview)
            } else if let loadError {
                errorView(loadError)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(T3Colors.background)
        .navigationTitle("Pull Request #\(number)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let address = overview?.detail.url, let url = URL(string: address) {
                    Button {
                        openURL(url)
                    } label: {
                        Image(systemName: "arrow.up.right.square")
                    }
                    .accessibilityLabel("Open in Browser")
                }
            }
        }
        .task { await load() }
        .accessibilityIdentifier("pull-request-detail-sheet")
    }

    private func load() async {
        loadError = nil
        do {
            overview = try await client.pullRequestOverview(threadID: threadID, number: number)
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 12) {
            Text(message)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .multilineTextAlignment(.center)
            Button("Retry") {
                Task { await load() }
            }
            .buttonStyle(.bordered)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Content

    private func content(_ overview: FeaturePullRequestOverview) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header(overview.detail)

                Picker("Section", selection: $tab) {
                    ForEach(PullRequestDetailTab.allCases, id: \.self) { tab in
                        Text(tab.rawValue).tag(tab)
                    }
                }
                .pickerStyle(.segmented)

                switch tab {
                case .summary:
                    summary(overview.detail, activity: overview.activity)
                case .timeline:
                    timeline(overview.activity)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 36)
        }
        .scrollIndicators(.hidden)
    }

    private func header(_ detail: PullRequestDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("#\(detail.number) \(detail.title)")
                .font(T3Typography.threadHeading2)
                .foregroundStyle(T3Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                statePill(detail)
                Text(PullRequestDetailSections.branchLine(detail))
                    .font(T3Typography.supporting.monospaced())
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Text(PullRequestDetailSections.statsLine(detail))
                .font(T3Typography.supporting)
                .monospacedDigit()
                .foregroundStyle(T3Colors.textSecondary)
        }
    }

    private func statePill(_ detail: PullRequestDetail) -> some View {
        let tone = color(
            PullRequestDetailSections.stateTone(state: detail.state, isDraft: detail.isDraft)
        )
        return Text(
            PullRequestDetailSections.stateLabel(state: detail.state, isDraft: detail.isDraft)
        )
        .font(T3Typography.supportingStrong)
        .foregroundStyle(tone)
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .background(tone.opacity(0.12), in: Capsule())
    }

    // MARK: - Summary

    @ViewBuilder
    private func summary(_ detail: PullRequestDetail, activity: PullRequestActivity?) -> some View {
        if detail.body.isEmpty {
            Text("No description.")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
        } else {
            MarkdownMessageView(detail.body)
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        if !detail.labels.isEmpty {
            section("Labels") {
                Text(detail.labels.map(\.name).joined(separator: " · "))
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
        }

        // Verdicts need the conversation, so they can only be shown where the
        // activity read landed. Without it the reviewers still list — as bare
        // names, because "awaiting review" would be a claim this cannot make
        // when the verdicts simply were not read.
        if let activity {
            // Reviewers come from the activity where it has them: its
            // conversation query reports reviewers the basic detail does not.
            let reviewerRows = PullRequestDetailSections.reviewerRows(
                reviewers: activity.reviewers ?? detail.reviewers,
                outcomes: PullRequestDetailSections.latestReviewOutcomes(
                    comments: activity.comments,
                    commits: activity.commits
                )
            )
            if !reviewerRows.isEmpty {
                section("Reviewers") {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(reviewerRows) { row in
                            reviewerRow(row)
                        }
                    }
                }
            }
        } else if !detail.reviewers.isEmpty {
            section("Reviewers") {
                Text(detail.reviewers.map(\.login).joined(separator: " · "))
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
        }

        if !detail.checks.isEmpty {
            section("Checks") {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(detail.checks, id: \.name) { check in
                        checkRow(check)
                    }
                }
            }
        }
    }

    private func reviewerRow(_ row: PullRequestReviewerRow) -> some View {
        HStack(spacing: 8) {
            Text(row.login)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(1)
            Spacer(minLength: 8)
            if let entry = row.entry {
                verdictBadge(entry.outcome, label: entry.label, isStale: entry.isStale)
            } else {
                Text("Awaiting review")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
            }
        }
    }

    /// A verdict reads in the tone a check of the same standing already wears
    /// in this sheet, so "approved" and "all checks passed" cannot look like
    /// two different kinds of good news. A stale verdict keeps its words and
    /// loses its strength: it still happened, it just no longer speaks for
    /// what is on the branch.
    private func verdictBadge(
        _ outcome: PullRequestReviewOutcome,
        label: String,
        isStale: Bool
    ) -> some View {
        let tone = color(outcome.tone)
        return HStack(spacing: 4) {
            Image(systemName: outcome.symbol)
                .font(.system(size: 11, weight: .semibold))
            Text(label)
                .font(T3Typography.supportingStrong)
                .lineLimit(1)
        }
        .foregroundStyle(isStale ? T3Colors.textTertiary : tone)
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .background(
            (isStale ? T3Colors.textTertiary : tone).opacity(isStale ? 0.10 : 0.14),
            in: Capsule()
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }

    private func checkRow(_ check: PullRequestCheck) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: PullRequestDetailSections.checkSymbol(check.status))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(color(PullRequestDetailSections.checkTone(check.status)))
            VStack(alignment: .leading, spacing: 2) {
                Text(check.name)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textPrimary)
                if let description = check.description, !description.isEmpty {
                    Text(description)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - Timeline

    @ViewBuilder
    private func timeline(_ activity: PullRequestActivity?) -> some View {
        if let activity {
            let entries = PullRequestDetailSections.timeline(activity)
            if entries.isEmpty {
                Text("No activity yet.")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
            } else {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(entries) { entry in
                        timelineRow(entry)
                    }
                    if let note = PullRequestDetailSections.truncationNote(activity) {
                        Text(note)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textTertiary)
                    }
                }
            }
        } else {
            // The activity read failed while the detail did not; the summary
            // still stands, so this tab explains itself rather than sinking
            // the sheet.
            Text("The conversation could not be loaded. Open in browser to read it.")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
        }
    }

    @ViewBuilder
    private func timelineRow(_ entry: PullRequestTimelineEntry) -> some View {
        switch entry.kind {
        case let .commit(commit):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "circle.dotted")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(T3Colors.textTertiary)
                Text(PullRequestDetailSections.shortOid(commit.oid))
                    .font(T3Typography.supporting.monospaced())
                    .foregroundStyle(T3Colors.textTertiary)
                Text(commit.messageHeadline)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
        case let .comment(comment):
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(PullRequestDetailSections.commentAuthorLabel(comment))
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textPrimary)
                    if let outcome = PullRequestDetailSections.reviewOutcome(comment) {
                        // Not dimmed for staleness here: the row sits in the
                        // chronology, so the commits that superseded it are
                        // already visible underneath.
                        verdictBadge(outcome, label: outcome.label, isStale: false)
                    } else if let state = PullRequestDetailSections.reviewStateLabel(comment) {
                        Text(state)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textTertiary)
                    }
                    if let relative = PullRequestDetailSections.relativeLabel(comment.createdAt) {
                        Text(relative)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textTertiary)
                    }
                }
                if !comment.body.isEmpty {
                    MarkdownMessageView(comment.body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(12)
            .background(T3Colors.subtle, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    // MARK: - Helpers

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textSecondary)
            content()
        }
    }

    private func color(_ tone: PullRequestStatusTone) -> Color {
        switch tone {
        case .success: T3Colors.success
        case .danger: T3Colors.danger
        case .warning: T3Colors.warning
        case .accent: T3Colors.accent
        case .neutral: T3Colors.textTertiary
        }
    }
}
