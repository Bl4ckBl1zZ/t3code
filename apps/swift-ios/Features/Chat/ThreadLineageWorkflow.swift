import SwiftUI

// A workflow coordinator's members in Lineage, grouped by phase.
//
// Ports apps/web/src/components/chat/ThreadLineageWorkflowRow.logic.ts and the
// row in ThreadLineageWorkflowRow.tsx. The coordinator keeps its ordinary
// Lineage row; the members fold underneath it, each opening its own thread.

/// One roster member as a Lineage row renders it.
struct ThreadLineageWorkflowMember: Equatable, Identifiable {
    /// Spawn ordinal within the run, the member's stable identity.
    let index: Int
    let title: String
    let model: String?
    /// A subagent status (`pending`, `running`, `completed`, `failed`, …).
    let status: String
    let childThreadID: String?
    let phaseIndex: Int?
    let durationMs: Int?

    var id: Int { index }

    /// The elapsed time a settled member shows instead of its status word.
    var settledElapsed: String? {
        guard ThreadLineageWorkflowGroup.isTerminal(status), status != "failed", let durationMs else { return nil }
        return AgentElapsed.compact(seconds: Double(durationMs) / 1000)
    }
}

struct ThreadLineageWorkflowPhase: Equatable, Identifiable {
    enum State: Equatable { case pending, running, done }

    let index: Int
    let title: String
    let members: [ThreadLineageWorkflowMember]
    /// Done is every member settled (success or error); running is any still active.
    let state: State
    let settledCount: Int

    var id: Int { index }

    /// The phase's status word, as web's `workflowPhaseStatusLabel`.
    var statusLabel: String {
        if state == .running { return "running" }
        if members.contains(where: { $0.status == "failed" }) { return "failed" }
        if members.contains(where: { $0.status == "cancelled" || $0.status == "interrupted" }) { return "stopped" }
        return state == .done ? "done" : "not started"
    }
}

/// A workflow coordinator's roster grouped by phase, as Lineage unfolds it.
struct ThreadLineageWorkflowGroup: Equatable {
    /// Phases with at least one member, in declaration order.
    let phases: [ThreadLineageWorkflowPhase]
    /// Members with no reported phase render directly under the workflow.
    let unphasedMembers: [ThreadLineageWorkflowMember]

    var memberCount: Int { phases.reduce(unphasedMembers.count) { $0 + $1.members.count } }

    static func isTerminal(_ status: String) -> Bool {
        ["completed", "failed", "cancelled", "interrupted"].contains(status)
    }

    private static func isActive(_ status: String) -> Bool {
        ["pending", "running", "waiting", "idle"].contains(status)
    }

    /// Nil for a subagent whose provider reported no roster, which keeps its
    /// plain row.
    init?(coordinatorStatus: String, workflow: AgentWorkflowProgress?) {
        guard let workflow, let roster = workflow.members else { return nil }
        let coordinatorIsTerminal = Self.isTerminal(coordinatorStatus)
        let members = roster.map { agent in
            // A member the run never settled ends with the run: once the
            // coordinator is done, a queued or running entry is stale.
            let status = (agent.state == "queued" || agent.state == "running") && coordinatorIsTerminal
                ? coordinatorStatus
                : agent.state == "queued" ? "pending" : agent.state
            return ThreadLineageWorkflowMember(
                index: agent.index,
                title: agent.label,
                model: agent.model,
                status: status,
                childThreadID: agent.childThreadId,
                phaseIndex: agent.phaseIndex,
                durationMs: agent.durationMs
            )
        }
        .sorted { $0.index < $1.index }

        // Union, not either/or: the declared plan lags the members, because the
        // provider only admits a phase once something in it starts. Members
        // seed the titles; the declared ones then win.
        var titles: [Int: String] = [:]
        for agent in roster {
            guard let phaseIndex = agent.phaseIndex else { continue }
            titles[phaseIndex] = agent.phaseTitle ?? titles[phaseIndex] ?? "Phase \(phaseIndex + 1)"
        }
        for phase in workflow.phases { titles[phase.index] = phase.title }

        phases = titles.keys.sorted().compactMap { index in
            let phaseMembers = members.filter { $0.phaseIndex == index }
            guard !phaseMembers.isEmpty else { return nil }
            let state: ThreadLineageWorkflowPhase.State = phaseMembers.contains { Self.isActive($0.status) }
                ? .running
                : .done
            return ThreadLineageWorkflowPhase(
                index: index,
                title: titles[index] ?? "Phase \(index + 1)",
                members: phaseMembers,
                state: state,
                settledCount: phaseMembers.filter { Self.isTerminal($0.status) }.count
            )
        }
        unphasedMembers = members.filter { $0.phaseIndex == nil }
    }
}

/// The members under a workflow's Lineage row: folded by default, with the
/// running phase open until the reader picks a side for it.
struct ThreadLineageWorkflowMembers: View {
    let group: ThreadLineageWorkflowGroup
    /// Seeds orbs for members that have no thread of their own yet.
    let coordinatorSeed: String
    let canOpen: (String) -> Bool
    let onOpen: (String) -> Void

    @State private var isExpanded = false
    @State private var phaseOpen: [Int: Bool] = [:]

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            ForEach(group.phases) { phase in
                DisclosureGroup(isExpanded: phaseBinding(phase)) {
                    ForEach(phase.members) { memberRow($0) }
                } label: {
                    phaseLabel(phase)
                }
            }
            ForEach(group.unphasedMembers) { memberRow($0) }
            if group.memberCount == 0 {
                Text("No agents yet")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
            }
        } label: {
            LabeledContent("Agents") {
                Text("\(group.memberCount)").monospacedDigit()
            }
            .font(T3Typography.threadBody)
            .foregroundStyle(T3Colors.textSecondary)
        }
    }

    private func phaseBinding(_ phase: ThreadLineageWorkflowPhase) -> Binding<Bool> {
        Binding(
            get: { phaseOpen[phase.index] ?? (phase.state == .running) },
            set: { phaseOpen[phase.index] = $0 }
        )
    }

    private func phaseLabel(_ phase: ThreadLineageWorkflowPhase) -> some View {
        let agents = phase.members.count == 1 ? "agent" : "agents"
        return HStack(spacing: 8) {
            Text(phase.title)
                .foregroundStyle(phase.state == .running ? T3Colors.textPrimary : T3Colors.textSecondary)
                .lineLimit(1)
            Spacer(minLength: 4)
            if phase.statusLabel == "failed" {
                Text("Failed").foregroundStyle(T3Colors.danger)
            }
            Text("\(phase.settledCount)/\(phase.members.count) \(agents)")
                .monospacedDigit()
                .foregroundStyle(T3Colors.textTertiary)
        }
        .font(T3Typography.supporting)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(phase.title) phase, \(phase.statusLabel), \(phase.settledCount) of \(phase.members.count) \(agents) finished")
    }

    private func memberRow(_ member: ThreadLineageWorkflowMember) -> some View {
        let status = WorkRowStatus(agentStatus: member.status)
        let openable = member.childThreadID.map(canOpen) ?? false
        return Button {
            if let id = member.childThreadID, openable { onOpen(id) }
        } label: {
            HStack(spacing: 10) {
                AgentOrb(
                    seed: member.childThreadID ?? "\(coordinatorSeed):agent:\(member.index)",
                    size: 20,
                    state: orbState(status)
                )
                VStack(alignment: .leading, spacing: 1) {
                    Text(member.title)
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    if let model = member.model {
                        Text(model)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textTertiary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if let elapsed = member.settledElapsed {
                    Text(verbatim: elapsed)
                        .monospacedDigit()
                        .foregroundStyle(T3Colors.textSecondary)
                        .accessibilityLabel("Finished in \(elapsed)")
                } else {
                    Text(status?.accessibilityLabel ?? "Done")
                        .foregroundStyle(status == .failed ? T3Colors.danger : T3Colors.textSecondary)
                }
            }
            .font(T3Typography.supporting)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!openable)
        .accessibilityHint(openable ? "Opens this agent's thread" : "")
    }

    private func orbState(_ status: WorkRowStatus?) -> AgentOrbState {
        switch status {
        case .running: .active
        case .failed: .failed
        case .stopped, nil: .done
        }
    }
}
