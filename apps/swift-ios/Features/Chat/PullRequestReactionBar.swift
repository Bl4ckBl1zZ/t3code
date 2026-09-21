import SwiftUI

@MainActor
struct PullRequestReactionContext {
    let canReact: Bool
    let set: ((PullRequestReactionRequest) async throws -> Void)?
    let refresh: () async -> Void
}

/// Compact reaction chips under a comment. Each chip is drawn 30pt tall but
/// keeps a 44pt hit area, and the row grows with Dynamic Type instead of
/// clipping.
struct PullRequestReactionBar: View {
    let reactions: [PullRequestReaction]
    let subjectID: String?
    let context: PullRequestReactionContext
    @State private var model: PullRequestReactionModel
    @ScaledMetric(relativeTo: .footnote) private var chipHeight: CGFloat = 30
    init(reactions: [PullRequestReaction], subjectID: String?, context: PullRequestReactionContext) {
        self.reactions = reactions; self.subjectID = subjectID; self.context = context
        _model = State(initialValue: PullRequestReactionModel(reactions: reactions))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(model.shown) { reaction in
                        Button { toggle(reaction.content) } label: {
                            chip(selected: reaction.viewerHasReacted) {
                                Text("\(PullRequestReactionLogic.emoji(reaction.content)) \(reaction.count)")
                                    .monospacedDigit()
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(!context.canReact || context.set == nil || model.pending.contains(reaction.content) || !PullRequestReactionLogic.order.contains(reaction.content))
                        .accessibilityLabel("\(PullRequestReactionLogic.title(reaction.content)), \(reaction.count)")
                        .accessibilityValue(reaction.viewerHasReacted ? "Selected" : "Not selected")
                        .accessibilityHint(PullRequestReactionLogic.actors(reaction))
                        .contextMenu { Text(PullRequestReactionLogic.actors(reaction)) }
                    }
                    if context.canReact, context.set != nil {
                        Menu {
                            ForEach(PullRequestReactionLogic.order, id: \.self) { content in
                                Button("\(PullRequestReactionLogic.emoji(content)) \(PullRequestReactionLogic.title(content))") { toggle(content) }
                                    .disabled(model.pending.contains(content))
                            }
                        } label: {
                            chip(selected: false) {
                                Image(systemName: "face.smiling")
                                    .foregroundStyle(T3Colors.textSecondary)
                            }
                        }
                        .accessibilityLabel("Add or remove reaction")
                    }
                }
            }
            .scrollIndicators(.hidden)
            if let error = model.error {
                Text(error).font(T3Typography.supporting).foregroundStyle(T3Colors.danger)
            }
        }
        .onChange(of: reactions) { _, latest in model.reconcile(latest) }
        .onChange(of: model.error) { _, error in
            if error != nil { PlatformHapticEngine.shared.play(.error) }
        }
    }

    private func chip(selected: Bool, @ViewBuilder content: () -> some View) -> some View {
        content()
            .font(T3Typography.supporting)
            .padding(.horizontal, 10)
            .frame(minHeight: chipHeight)
            .background(selected ? T3Colors.accent.opacity(0.14) : T3Colors.subtle, in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? T3Colors.accent : .clear, lineWidth: 1))
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
    }

    private func toggle(_ content: String) {
        guard let set = context.set else { return }
        PlatformHapticEngine.shared.playSelection()
        Task { await model.toggle(content, send: { content, reacted in
            try await set(.init(subjectId: subjectID, content: content, reacted: reacted))
        }, refresh: context.refresh) }
    }
}
