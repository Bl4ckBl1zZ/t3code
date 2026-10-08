import SwiftUI

/// The thread's plan on its own (web's `PlanSidebar`): the latest task list
/// with each step's status, its explanation, and the latest proposed plan with
/// Copy, Share and Save. Reads the live detail, so steps tick over while it is
/// open, and stays available after the run ends.
struct ThreadPlanSheet: View {
    let model: FeatureRootModel
    let threadID: String
    var saver: ProposedPlanWorkspaceSaver?

    private var detail: FeatureThreadDetail? { model.details[threadID] }

    var body: some View {
        let steps = detail.flatMap(ThreadProposedPlans.steps(in:))
        let plan = detail.flatMap(ThreadProposedPlans.latest(in:))
        NavigationStack {
            Group {
                if steps == nil, plan == nil {
                    ContentUnavailableView(
                        "No Plan Yet",
                        systemImage: "list.bullet.clipboard",
                        description: Text("Plans appear here when the agent makes one.")
                    )
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 24) {
                            if let steps { stepsSection(steps) }
                            if let plan { planSection(plan) }
                        }
                        .padding(20)
                        .frame(maxWidth: T3Metrics.readingWidth, alignment: .leading)
                        .frame(maxWidth: .infinity)
                    }
                }
            }
            .background(T3Colors.sheet)
            // Web's label: a thread planning in Plan mode has a plan, one that
            // only tracks work has tasks.
            .navigationTitle(plan != nil || detail?.thread.interactionMode == .plan ? "Plan" : "Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let plan, !plan.isStreaming {
                    ToolbarItem(placement: .primaryAction) {
                        ProposedPlanActionsMenu(plan: plan, saver: saver)
                    }
                }
            }
            .t3SheetToolbar(.close)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func stepsSection(_ steps: ThreadPlanSteps) -> some View {
        let completed = steps.steps.filter { $0.status == "completed" }.count
        return VStack(alignment: .leading, spacing: 12) {
            if let explanation = steps.explanation {
                Text(explanation)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(alignment: .firstTextBaseline) {
                Text("Steps")
                    .font(T3Typography.eyebrow)
                    .foregroundStyle(T3Colors.textTertiary)
                    .textCase(.uppercase)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                Text("\(completed) of \(steps.steps.count) complete")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .monospacedDigit()
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(steps.steps.enumerated()), id: \.offset) { _, step in
                    PlanStepRow(step: step)
                }
            }
        }
    }

    private func planSection(_ plan: ThreadProposedPlan) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Proposed Plan")
                .font(T3Typography.eyebrow)
                .foregroundStyle(T3Colors.textTertiary)
                .textCase(.uppercase)
            Text(plan.title ?? "Proposed plan")
                .font(T3Typography.threadHeading3)
                .foregroundStyle(T3Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if !plan.displayedMarkdown.isEmpty {
                MarkdownMessageView(plan.displayedMarkdown, isStreaming: plan.isStreaming)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct PlanStepRow: View {
    let step: OrchestrationV2PlanStep

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(step.text)
                .font(T3Typography.supporting)
                .foregroundStyle(step.status == "running" ? T3Colors.textPrimary : T3Colors.textSecondary)
                .strikethrough(step.status == "completed", color: T3Colors.textTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            step.status == "running" ? T3Colors.statusRunning.opacity(0.08) : Color.clear,
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(step.text)
        .accessibilityValue(statusLabel)
    }

    private var symbol: String {
        switch step.status {
        case "completed": "checkmark.circle.fill"
        case "running": "circle.inset.filled"
        default: "circle"
        }
    }

    private var tint: Color {
        switch step.status {
        case "completed": T3Colors.success
        case "running": T3Colors.statusRunning
        default: T3Colors.textTertiary
        }
    }

    private var statusLabel: String {
        switch step.status {
        case "completed": "Completed"
        case "running": "In progress"
        default: "Pending"
        }
    }
}
