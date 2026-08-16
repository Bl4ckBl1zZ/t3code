import SwiftUI

// Compact workflow readout for a subagent row.
//
// Ports apps/mobile/src/features/threads/AgentWorkflowProgress.tsx and the
// presentation helpers in packages/shared/src/workflowObservability.ts. A phone
// row has space for one line, so this shows the phase counter, phase pips, the
// current phase name and the token rollup — and nothing at all when the task is
// not a workflow, which is the common case.
//
// The types mirror `OrchestrationV2WorkflowProgress` / `OrchestrationV2TaskUsage`
// from packages/contracts/src/orchestrationV2.ts. They live here rather than in
// `Core` because `Core`'s `OrchestrationV2Subagent` does not yet carry the
// `workflow` / `usage` annotations; once it does, these become adapters.

public struct AgentWorkflowPhase: Equatable, Hashable, Sendable, Identifiable {
    /// The phase's position in the script's own declaration order, which is not
    /// necessarily execution order.
    public let index: Int
    public let title: String
    public let detail: String?

    public init(index: Int, title: String, detail: String? = nil) {
        self.index = index
        self.title = title
        self.detail = detail
    }

    public var id: String { "\(index)-\(title)" }
}

public struct AgentWorkflowProgress: Equatable, Hashable, Sendable {
    public let name: String?
    public let description: String?
    public let phases: [AgentWorkflowPhase]
    /// The title of the phase most recently entered.
    public let currentPhase: String?
    /// Agents spawned so far by this workflow.
    public let spawnedCount: Int?

    public init(
        name: String? = nil,
        description: String? = nil,
        phases: [AgentWorkflowPhase] = [],
        currentPhase: String? = nil,
        spawnedCount: Int? = nil
    ) {
        self.name = name
        self.description = description
        self.phases = phases
        self.currentPhase = currentPhase
        self.spawnedCount = spawnedCount
    }
}

/// Cumulative token rollup for one task. Every field past `totalTokens` is
/// optional because no driver reports the full set, and a missing field means
/// "not reported", which is not the same as zero.
public struct AgentTaskUsage: Equatable, Hashable, Sendable {
    public let totalTokens: Int
    public let inputTokens: Int?
    public let cachedInputTokens: Int?
    public let outputTokens: Int?
    public let reasoningOutputTokens: Int?
    public let toolUses: Int?
    public let durationMs: Int?

    public init(
        totalTokens: Int,
        inputTokens: Int? = nil,
        cachedInputTokens: Int? = nil,
        outputTokens: Int? = nil,
        reasoningOutputTokens: Int? = nil,
        toolUses: Int? = nil,
        durationMs: Int? = nil
    ) {
        self.totalTokens = totalTokens
        self.inputTokens = inputTokens
        self.cachedInputTokens = cachedInputTokens
        self.outputTokens = outputTokens
        self.reasoningOutputTokens = reasoningOutputTokens
        self.toolUses = toolUses
        self.durationMs = durationMs
    }
}

public struct WorkflowPhaseProgress: Equatable, Hashable, Sendable {
    public let current: Int
    public let total: Int

    public init(current: Int, total: Int) {
        self.current = current
        self.total = total
    }
}

public enum WorkflowObservability {
    /// Phase progress as a "3/7" style pair, or nil when the script declared no
    /// phases so callers omit the indicator rather than rendering "0/0".
    ///
    /// Position resolves by title rather than by tracking the furthest phase
    /// reached. A script may skip a phase or revisit an earlier one, and showing
    /// progress move backwards is more honest than pinning it at a high-water
    /// mark that no longer describes what is running.
    public static func phaseProgress(_ workflow: AgentWorkflowProgress?) -> WorkflowPhaseProgress? {
        guard let workflow, !workflow.phases.isEmpty else { return nil }
        let total = workflow.phases.count
        guard let currentPhase = workflow.currentPhase else {
            return WorkflowPhaseProgress(current: 0, total: total)
        }
        let index = workflow.phases.firstIndex { $0.title == currentPhase }
        // An unrecognized current phase means the script entered a phase it
        // never declared in meta.phases; count it as started rather than
        // dropping the indicator entirely.
        return WorkflowPhaseProgress(current: index.map { $0 + 1 } ?? 1, total: total)
    }

    /// Compact token count: 1234 -> "1.2k". Exact below 1000.
    public static func formatTokenCount(_ tokens: Int) -> String {
        if tokens < 1000 { return String(tokens) }
        if tokens < 1_000_000 { return "\(scaled(Double(tokens) / 1000))k" }
        return "\(scaled(Double(tokens) / 1_000_000))M"
    }

    /// One decimal below ten, whole numbers above.
    ///
    /// The tenth is rounded before formatting rather than left to `%.1f`, whose
    /// round-half-to-even would render an exact 1.25 as "1.2" where the web and
    /// React Native clients — and `Number.toFixed` — show "1.3".
    private static func scaled(_ value: Double) -> String {
        guard value < 10 else { return String(Int(value.rounded())) }
        return String(format: "%.1f", (value * 10).rounded() / 10)
    }
}

/// One line of workflow state under a subagent row. Renders nothing when the
/// task reports neither phases nor usage.
struct AgentWorkflowProgressView: View {
    let workflow: AgentWorkflowProgress?
    let usage: AgentTaskUsage?

    var body: some View {
        if progress != nil || usage != nil {
            HStack(spacing: 6) {
                if let progress {
                    Text("\(progress.current)/\(progress.total)")
                        .font(T3Typography.supporting)
                        .monospacedDigit()
                        .foregroundStyle(T3Colors.textTertiary)

                    // Phase pips, sized for touch-distance legibility rather
                    // than the denser desktop treatment.
                    HStack(spacing: 2) {
                        ForEach(Array(phases.enumerated()), id: \.element.id) { index, _ in
                            Capsule()
                                .fill(
                                    index < progress.current
                                        ? T3Colors.accent.opacity(0.7)
                                        : T3Colors.subtleStrong
                                )
                                .frame(width: 10, height: 3)
                        }
                    }
                }

                if let currentPhase = workflow?.currentPhase {
                    Text(currentPhase)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                if let usage {
                    Text("\(WorkflowObservability.formatTokenCount(usage.totalTokens)) tok")
                        .font(T3Typography.supporting)
                        .monospacedDigit()
                        .foregroundStyle(T3Colors.textTertiary)
                        .layoutPriority(1)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel)
        }
    }

    private var phases: [AgentWorkflowPhase] { workflow?.phases ?? [] }

    private var progress: WorkflowPhaseProgress? {
        WorkflowObservability.phaseProgress(workflow)
    }

    private var accessibilityLabel: String {
        var parts: [String] = []
        if let progress {
            parts.append("Phase \(progress.current) of \(progress.total)")
        }
        if let currentPhase = workflow?.currentPhase {
            parts.append(currentPhase)
        }
        if let usage {
            parts.append("\(WorkflowObservability.formatTokenCount(usage.totalTokens)) tokens")
        }
        return parts.joined(separator: ", ")
    }
}
