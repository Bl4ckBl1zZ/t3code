import SwiftUI

/// The current run's V2 task list, kept adjacent to the composer and out of its gesture tree.
struct ComposerTasksView: View {
    let detail: FeatureThreadDetail
    @State private var expanded = false

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
            VStack(alignment: .leading, spacing: 0) {
                Button { withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() } } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "list.bullet.clipboard")
                        Text(steps.first(where: { $0.status == "running" })?.text ?? "Tasks")
                            .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                        Text("\(steps.filter { $0.status == "completed" }.count)/\(steps.count)").monospacedDigit()
                        Image(systemName: "chevron.down").rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                    .padding(12).contentShape(Rectangle())
                }.buttonStyle(.plain)
                    .accessibilityLabel("Tasks, \(steps.filter { $0.status == "completed" }.count) of \(steps.count) complete")
                    .accessibilityHint(expanded ? "Collapse task list" : "Expand task list")
                if expanded {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                                HStack(alignment: .top, spacing: 8) {
                                    Image(systemName: step.status == "completed" ? "checkmark.circle.fill" : step.status == "running" ? "circle.inset.filled" : "circle")
                                    Text(step.text).frame(maxWidth: .infinity, alignment: .leading)
                                    Text(step.status == "running" ? "Running" : step.status == "completed" ? "Completed" : "Pending")
                                        .foregroundStyle(T3Colors.textSecondary)
                                }.font(T3Typography.supporting)
                                    .foregroundStyle(step.status == "completed" ? T3Colors.textSecondary : T3Colors.textPrimary)
                            }
                        }.padding(.horizontal, 12).padding(.bottom, 12)
                    }.frame(maxHeight: 180)
                }
            }
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            .padding(.horizontal, 24)
            .onChange(of: activeRunID) { _, _ in expanded = false }
        }
    }
}
