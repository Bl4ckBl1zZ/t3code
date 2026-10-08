import SwiftUI

/// "Plan ready" above the composer (web's `ComposerPlanFollowUpBanner` and its
/// Implement split button). Implement sends the plan in Build mode here;
/// Implement in New Thread starts a sibling thread with it and opens it.
/// Typing a message instead refines the plan: the thread is still in Plan mode,
/// so an ordinary send is web's Refine.
///
/// Shown only while ``ThreadProposedPlans/followUp(in:thread:)`` finds a plan,
/// which stops once the thread leaves Plan mode, a turn starts, or the server
/// no longer counts the plan as actionable.
struct ComposerPlanFollowUpBanner: View {
    let model: FeatureRootModel
    let threadID: String
    let plan: ThreadProposedPlan
    let selection: FeatureSelection?
    /// The composer holds a message, which turns Send into Refine.
    let hasDraft: Bool
    /// A send is in flight or the environment is unreachable.
    let isBlocked: Bool
    let onOpenPlan: () -> Void

    @State private var implementing: Implementation?

    private enum Implementation { case here, newThread }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: onOpenPlan) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("Plan Ready")
                        .font(T3Typography.eyebrow)
                        .foregroundStyle(T3Colors.statusInput)
                        .textCase(.uppercase)
                    Text(plan.title ?? "Proposed plan")
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right")
                        .font(T3Typography.supporting.weight(.semibold))
                        .foregroundStyle(T3Colors.textTertiary)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Plan ready: \(plan.title ?? "Proposed plan")")
            .accessibilityHint("Shows the plan")

            if hasDraft {
                Text("Sending your message refines the plan.")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { actions }
                    VStack(alignment: .leading, spacing: 8) { actions }
                }
            }
        }
        .padding(14)
        .t3GlassEffect(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .t3GlassRim(in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer-plan-follow-up")
    }

    @ViewBuilder
    private var actions: some View {
        Button { implement(.here) } label: {
            busyLabel("Implement", systemImage: "hammer", busy: implementing == .here)
        }
        .t3ProminentButtonStyle()
        .controlSize(.small)
        .disabled(isDisabled)
        .accessibilityHint("Switches to Build and sends the plan")

        Button { implement(.newThread) } label: {
            busyLabel("Implement in New Thread", systemImage: "plus.bubble", busy: implementing == .newThread)
        }
        .t3SecondaryButtonStyle()
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .disabled(isDisabled)
    }

    private var isDisabled: Bool { isBlocked || implementing != nil }

    private func busyLabel(_ title: String, systemImage: String, busy: Bool) -> some View {
        Label {
            Text(title).lineLimit(1)
        } icon: {
            if busy {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: systemImage)
            }
        }
        .font(T3Typography.control)
    }

    private func implement(_ kind: Implementation) {
        guard !isDisabled else { return }
        implementing = kind
        let implementation = FeatureProposedPlanImplementation(threadID: threadID, plan: plan, selection: selection)
        Task {
            do {
                switch kind {
                case .here:
                    try await model.client.implementProposedPlan(implementation)
                    PlatformHapticEngine.shared.play(.success)
                case .newThread:
                    let created = try await model.client.implementProposedPlanInNewThread(implementation)
                    PlatformHapticEngine.shared.play(.success)
                    NotificationCenter.default.post(
                        name: .platformRouteReceived,
                        object: nil,
                        userInfo: ["route": PlatformRoute.thread(
                            environmentID: created.environmentID,
                            threadID: created.wireID ?? created.id
                        )]
                    )
                }
            } catch is CancellationError {
            } catch {
                model.reportFailure(
                    error.localizedDescription,
                    title: kind == .here ? "Couldn't Implement Plan" : "Couldn't Start Implementation Thread"
                )
            }
            implementing = nil
        }
    }
}
