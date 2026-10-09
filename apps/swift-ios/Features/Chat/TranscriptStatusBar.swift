import SwiftUI

/// The floating line above the transcript: one activity pill for the agents
/// this thread is running and the work it left in the background.
///
/// Both halves answer the same question — what is happening while you are
/// reading something else — so they share one pill and one sheet rather than
/// competing for the top of the screen.
///
/// The bar owns its own visibility rather than leaving it to the host. A lingering
/// failure expires on a clock, and a host that decided visibility once per body
/// would leave the capsule stranded on screen until some unrelated change forced
/// a redraw. Deciding it inside the timeline means the bar disappears on the same
/// tick the linger window closes, and the height preference the transcript reads
/// for its top inset collapses to zero with it.
struct TranscriptStatusBar: View {
    let relationships: ThreadRelationshipsModel?
    let backgroundCommands: [ThreadDetailsBackgroundCommand]
    let onOpenThread: (_ threadID: String, _ isArchived: Bool) -> Void
    let onMerge: () async throws -> Void
    let onDetach: () async throws -> Void
    /// Stop on a running subagent's row in the activity sheet.
    var onStopSubagent: ((_ childThreadID: String) async throws -> Void)? = nil
    var subagentMetadata: [String: SubagentRowMetadata] = [:]

    var body: some View {
        if backgroundCommands.isEmpty {
            // Nothing on this bar is a function of time, so there is nothing for
            // a timeline to drive. The agents half redraws when its own model
            // changes, and this is the overwhelmingly common case.
            bar(summary: .empty, processes: [], nowMilliseconds: 0)
        } else {
            TimelineView(.periodic(from: .now, by: tickInterval)) { context in
                let now = Int(context.date.timeIntervalSince1970 * 1000)
                bar(
                    summary: ThreadDetailsBackgroundTasks.summary(
                        commands: backgroundCommands, nowMilliseconds: now
                    ),
                    processes: ThreadDetailsBackgroundTasks.capsuleProcesses(
                        commands: backgroundCommands, nowMilliseconds: now
                    ),
                    nowMilliseconds: now
                )
            }
        }
    }

    @ViewBuilder
    private func bar(
        summary: ThreadBackgroundSummary,
        processes: [ThreadDetailsBackgroundProcess],
        nowMilliseconds: Int
    ) -> some View {
        let agents = relationships?.showsCollapsedBanner == true ? relationships : nil
        if agents != nil || !summary.isEmpty {
            ThreadActivityPill(
                relationships: relationships,
                showsAgents: agents != nil,
                summary: summary,
                processes: processes,
                nowMilliseconds: nowMilliseconds,
                onOpenThread: onOpenThread,
                onMerge: onMerge,
                onDetach: onDetach,
                onStopSubagent: onStopSubagent,
                subagentMetadata: subagentMetadata
            )
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .padding(.bottom, 6)
        }
    }

    /// Sampled outside the timeline, the way `ThreadDetailsBackgroundTaskRow`
    /// does it: a schedule is fixed when the view is built, so the cadence has to
    /// come from a clock read here rather than from the context it configures.
    private var tickInterval: TimeInterval {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let summary = ThreadDetailsBackgroundTasks.summary(
            commands: backgroundCommands, nowMilliseconds: now
        )
        return TimeInterval(
            ThreadDetailsBackgroundTasks.capsuleTickSeconds(summary, nowMilliseconds: now)
        )
    }
}

/// One compact glass capsule: overlapping orbs and a count for the agents, a
/// glyph and a label for the background work, and a chevron saying it opens.
/// Either half drops out when it has nothing to report.
///
/// The whole capsule is one button into `ThreadActivitySheet`, which lists both
/// halves; the hairline between them separates what it reports, not where a
/// tap lands.
private struct ThreadActivityPill: View {
    let relationships: ThreadRelationshipsModel?
    let showsAgents: Bool
    let summary: ThreadBackgroundSummary
    let processes: [ThreadDetailsBackgroundProcess]
    let nowMilliseconds: Int
    let onOpenThread: (_ threadID: String, _ isArchived: Bool) -> Void
    let onMerge: () async throws -> Void
    let onDetach: () async throws -> Void
    let onStopSubagent: ((_ childThreadID: String) async throws -> Void)?
    let subagentMetadata: [String: SubagentRowMetadata]

    @State private var isSheetPresented = false
    @State private var decay = ThreadRelationshipDecay()
    @State private var visibleRows: [ThreadRelationshipRow] = []
    @State private var archivedRows: [ThreadRelationshipRow] = []

    @ScaledMetric(relativeTo: .footnote) private var height: CGFloat = 36
    @ScaledMetric(relativeTo: .footnote) private var orbSize: CGFloat = 18

    var body: some View {
        Button {
            isSheetPresented = true
        } label: {
            label
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Shows agents and background tasks")
        .accessibilityIdentifier("thread-activity-pill")
        .task(id: relationships?.rows) {
            await trackDecay()
        }
        .sheet(isPresented: $isSheetPresented) {
            ThreadActivitySheet(
                model: relationships,
                visibleRows: visibleRows,
                archivedRows: archivedRows,
                backgroundProcesses: processes,
                onOpenThread: onOpenThread,
                onMerge: onMerge,
                onDetach: onDetach,
                onStopSubagent: onStopSubagent,
                subagentMetadata: subagentMetadata
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    private var label: some View {
        HStack(spacing: 10) {
            if showsAgents, let relationships {
                agents(relationships)
            }
            if showsAgents, !summary.isEmpty {
                Capsule()
                    .fill(T3Colors.textTertiary.opacity(0.5))
                    .frame(width: 1, height: height * 0.42)
                    .accessibilityHidden(true)
            }
            if !summary.isEmpty {
                ThreadBackgroundSegment(summary: summary, nowMilliseconds: nowMilliseconds)
            }
            Image(systemName: "chevron.down")
                .font(.caption2.weight(.bold))
                .foregroundStyle(T3Colors.textTertiary)
                .accessibilityHidden(true)
        }
        .padding(.leading, showsAgents ? 8 : 12)
        .padding(.trailing, 12)
        .frame(height: height)
        // `.regular`, matching the composer pill: solid enough that the
        // transcript scrolling under it never competes with the orbs.
        // Interactive, because the capsule is the button.
        .t3GlassEffect(.regular, interactive: true, in: Capsule(style: .continuous))
        .t3GlassRim(in: Capsule(style: .continuous))
        // The visual stays slim; the hit area still meets the tap minimum.
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .contentShape(Rectangle())
    }

    private func agents(_ model: ThreadRelationshipsModel) -> some View {
        let summary = model.subagentSummary
        return HStack(spacing: 7) {
            // Negative spacing overlaps the orbs; the halo behind each one cuts
            // the orb beside it the way the desktop stack's ring does.
            HStack(spacing: -orbSize / 3) {
                ForEach(summary.orbRows.prefix(3)) { row in
                    ThreadRelationshipOrb(
                        seed: ThreadActivitySheet.orbSeed(for: row, in: model),
                        size: orbSize,
                        state: ThreadRelationships.subagentOrbState(row.edge.status)
                    )
                    .background { Circle().fill(T3Colors.surface).padding(-1.5) }
                }
            }
            .fixedSize()

            HStack(spacing: 0) {
                Text(summary.primaryLabel)
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textPrimary)
                if let failedLabel = summary.secondaryFailedLabel {
                    Text(" · \(failedLabel)")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.danger)
                }
            }
            .monospacedDigit()
            .lineLimit(1)
        }
    }

    private var accessibilityLabel: String {
        var parts: [String] = []
        if showsAgents, let summary = relationships?.subagentSummary {
            parts.append(
                "Agents: " + [summary.primaryLabel, summary.secondaryFailedLabel]
                    .compactMap { $0 }
                    .joined(separator: ", ")
            )
        }
        if !summary.isEmpty {
            parts.append(
                ThreadDetailsBackgroundTasks.capsuleAccessibilityLabel(
                    summary, nowMilliseconds: nowMilliseconds
                )
            )
        }
        return parts.joined(separator: ". ")
    }

    /// Re-splits the rows when one is due to collapse into the Done group.
    /// One scheduled wake-up rather than a ticker: a finished subagent is a
    /// minute away from collapsing, and nothing else changes in between.
    private func trackDecay() async {
        guard let rows = relationships?.rows else {
            visibleRows = []
            archivedRows = []
            return
        }
        while !Task.isCancelled {
            let split = decay.split(rows: rows)
            visibleRows = split.visible
            archivedRows = split.archived
            guard let nextRefresh = split.nextRefresh else { return }
            let delay = nextRefresh.timeIntervalSinceNow + 0.05
            guard delay > 0 else { continue }
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                return
            }
        }
    }
}
