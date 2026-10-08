import SwiftUI

/// The current run's V2 task list, kept adjacent to the composer and out of its gesture tree.
/// A tap opens the plan sheet, which lists every step and outlives the run.
struct ComposerTasksView: View {
    let detail: FeatureThreadDetail
    let onOpenPlan: () -> Void

    private var activeRunID: String? {
        ThreadWorkflows.resolveActiveRun(runs: detail.workflow.runs)?.id
    }

    private var steps: [OrchestrationV2PlanStep] {
        guard detail.approvals.isEmpty, detail.userInputs.isEmpty, let activeRunID,
              detail.thread.state == .working,
              let item = detail.timelineItems.last(where: {
                  $0.item.base.runId == activeRunID && $0.item.type == "todo_list"
              }), case let .todoList(_, steps, _) = item.item.payload,
              steps.contains(where: { $0.status == "running" }) else { return [] }
        return steps
    }

    var body: some View {
        let steps = steps
        if !steps.isEmpty {
            let completed = steps.filter { $0.status == "completed" }.count
            Button(action: onOpenPlan) {
                HStack(spacing: 8) {
                    Image(systemName: "list.bullet.clipboard")
                    Text(steps.first(where: { $0.status == "running" })?.text ?? "Tasks")
                        .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    Text("\(completed)/\(steps.count)").monospacedDigit()
                    Image(systemName: "chevron.up")
                }
                .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                .padding(12).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Tasks, \(completed) of \(steps.count) complete")
            .accessibilityHint("Shows the plan")
            .t3GlassEffect(.regular, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .t3GlassRim(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .padding(.horizontal, 24)
        }
    }
}
