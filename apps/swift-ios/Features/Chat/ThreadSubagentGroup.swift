import SwiftUI

/// What a fan-out of subagents says as one line. Ported from
/// packages/client-runtime/src/state/subagentDisplay.ts.
struct SubagentGroupSummary: Equatable {
    struct Agent: Equatable {
        let status: String
        let startedAt: Date?
        let completedAt: Date?
        let orbSeed: String
    }

    let agents: [Agent]

    init(agents: [Agent]) {
        self.agents = agents
    }

    /// The subagent rows of a lifecycle run, or nil when any row is not a
    /// subagent: a mixed run stays a plain stack, as on web.
    init?(rows: [OrchestrationV2ProjectedTurnItem]) {
        var agents: [Agent] = []
        for row in rows {
            guard case let .subagent(subagentID, _, _, _, childThreadID, _, _, _) = row.item.payload else {
                return nil
            }
            agents.append(Agent(
                status: row.item.base.rawStatus,
                startedAt: row.item.base.startedAt.flatMap(ThreadTimelineDay.date(fromISO8601:)),
                completedAt: row.item.base.completedAt.flatMap(ThreadTimelineDay.date(fromISO8601:)),
                // Child thread first, so an agent keeps its colour on every surface.
                orbSeed: childThreadID ?? subagentID
            ))
        }
        guard !agents.isEmpty else { return nil }
        self.agents = agents
    }

    static func isLive(_ status: String) -> Bool {
        status == "pending" || status == "running" || status == "waiting"
    }

    var isLive: Bool { agents.contains { Self.isLive($0.status) } }
    var hasFailure: Bool { agents.contains { $0.status == "failed" } }

    /// "2 working · 1 done · 1 failed", in a fixed order, zero counts omitted.
    var statusSummary: String {
        var working = 0, done = 0, failed = 0, stopped = 0, idle = 0
        for agent in agents {
            switch agent.status {
            case "pending", "running", "waiting": working += 1
            case "completed": done += 1
            case "failed": failed += 1
            case "idle": idle += 1
            default: stopped += 1
            }
        }
        return [(working, "working"), (done, "done"), (failed, "failed"), (stopped, "stopped"), (idle, "idle")]
            .filter { $0.0 > 0 }
            .map { "\($0.0) \($0.1)" }
            .joined(separator: " · ")
    }

    /// First launch to last settle. Nil end while any member works, or when a
    /// settled member never reported when it finished: the span is withheld
    /// rather than cut short.
    var span: (start: Date?, end: Date?) {
        var start: Date?
        var end: Date?
        var endUnknown = false
        for agent in agents {
            if let startedAt = agent.startedAt, start.map({ startedAt < $0 }) ?? true { start = startedAt }
            if let completedAt = agent.completedAt {
                if end.map({ completedAt > $0 }) ?? true { end = completedAt }
            } else {
                endUnknown = true
            }
        }
        return (start, isLive || endUnknown ? nil : end)
    }

    /// The group's elapsed time at `now`: running while any member works,
    /// frozen once all have settled, nothing without a start or a known end.
    func elapsedLabel(now: Date) -> String? {
        let (start, end) = span
        guard let start else { return nil }
        if let end { return AgentElapsed.compact(seconds: end.timeIntervalSince(start)) }
        guard isLive else { return nil }
        // Ticks once a minute, so under one there is nothing honest to count.
        let seconds = now.timeIntervalSince(start)
        return seconds < 60 ? "<1m" : AgentElapsed.compact(seconds: seconds)
    }
}

/// A fan-out of two or more subagents as one collapsible card: up to three
/// orbs, "N subagents", how they stand, and how long the group has run. Closed
/// by default, like web; the rows inside are the ordinary subagent rows.
struct SubagentGroupCard: View {
    static let visibleOrbs = 3

    let summary: SubagentGroupSummary
    let rows: [OrchestrationV2ProjectedTurnItem]
    var runs: [LifecycleTimelineRun] = []
    var liveChildThreadIDs: [String: String] = [:]
    var subagentMetadata: [String: SubagentRowMetadata] = [:]
    var onOpenThread: (String) -> Void = { _ in }

    @SwiftUI.Environment(\.threadWorkLogHistory) private var sharedHistory
    @State private var localHistory = ThreadWorkLogHistoryStore()

    /// Survives the cell being recycled. Row ids carry their source thread.
    private var history: ThreadWorkLogHistory {
        (sharedHistory ?? localHistory).entry("subagent-group:\(rows.first?.id ?? "empty")")
    }

    private var isExpanded: Bool { history.groupExpanded ?? false }
    private var label: String { "\(summary.agents.count) subagents" }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            header
            if isExpanded {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(rows, id: \.id) { row in
                        ThreadLifecycleRow(
                            row: row,
                            runs: runs,
                            liveChildThreadID: liveChildThreadIDs[row.id],
                            subagentMetadata: subagentMetadata[row.id],
                            grouped: true,
                            onOpenThread: onOpenThread
                        )
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 2)
                .background(T3Colors.surface.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(T3Colors.border, lineWidth: 1)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, ChatTimelineStyle.entrySpacing)
    }

    private var header: some View {
        Button {
            withAnimation(.snappy) { history.groupExpanded = !isExpanded }
        } label: {
            HStack(spacing: 8) {
                orbs
                Text(verbatim: label)
                    .font(ChatTimelineStyle.bodyStrong)
                    .foregroundStyle(T3Colors.textPrimary)
                    .layoutPriority(1)
                Text(verbatim: summary.statusSummary)
                    .font(ChatTimelineStyle.small)
                    .foregroundStyle(statusTint)
                    .frame(maxWidth: .infinity, alignment: .leading)
                elapsed
                TimelineDisclosureChevron(isExpanded: isExpanded)
            }
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(
            [summary.statusSummary, summary.elapsedLabel(now: .now), isExpanded ? "Expanded" : "Collapsed"]
                .compactMap { $0 }
                .joined(separator: ", ")
        )
        .accessibilityAddTraits(.isButton)
    }

    private var statusTint: Color {
        if summary.isLive { return T3Colors.statusRunning }
        return summary.hasFailure ? T3Colors.danger : T3Colors.textTertiary
    }

    private var orbs: some View {
        HStack(spacing: -4) {
            ForEach(Array(summary.agents.prefix(Self.visibleOrbs).enumerated()), id: \.offset) { _, agent in
                AgentOrb(seed: agent.orbSeed, size: 16, state: orbState(agent.status))
                    .overlay { Circle().stroke(T3Colors.background, lineWidth: 1) }
            }
            if summary.agents.count > Self.visibleOrbs {
                Text(verbatim: "+\(summary.agents.count - Self.visibleOrbs)")
                    .font(ChatTimelineStyle.micro.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(T3Colors.textTertiary)
                    .padding(.leading, 8)
            }
        }
        .accessibilityHidden(true)
    }

    /// Static once settled; while the group works it moves on the minute, not
    /// the frame.
    @ViewBuilder
    private var elapsed: some View {
        let start = summary.span.start
        if summary.isLive, let start {
            TimelineView(.periodic(from: start, by: 60)) { context in
                elapsedText(summary.elapsedLabel(now: context.date))
            }
        } else {
            elapsedText(summary.elapsedLabel(now: .now))
        }
    }

    @ViewBuilder
    private func elapsedText(_ value: String?) -> some View {
        if let value {
            Text(verbatim: value)
                .font(ChatTimelineStyle.small)
                .monospacedDigit()
                .foregroundStyle(T3Colors.textTertiary)
        }
    }

    /// The rule each subagent row's own orb follows, so an agent's orb reads
    /// the same in the header as in the row under it.
    private func orbState(_ status: String) -> AgentOrbState {
        let status = OrchestrationV2TurnItemStatus(rawValue: status) ?? .unknown
        if status == .failed { return .failed }
        return status.isTerminal ? .done : .active
    }
}
