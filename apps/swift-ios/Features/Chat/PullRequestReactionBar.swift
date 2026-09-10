import SwiftUI

@MainActor
struct PullRequestReactionContext {
    let canReact: Bool
    let set: ((PullRequestReactionRequest) async throws -> Void)?
    let refresh: () async -> Void
}

struct PullRequestReactionBar: View {
    let reactions: [PullRequestReaction]
    let subjectID: String?
    let context: PullRequestReactionContext
    @State private var model: PullRequestReactionModel
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
                            Text("\(PullRequestReactionLogic.emoji(reaction.content)) \(reaction.count)")
                                .font(T3Typography.supporting).monospacedDigit().padding(.horizontal, 10).frame(minHeight: 44)
                                .background(reaction.viewerHasReacted ? T3Colors.accent.opacity(0.12) : T3Colors.subtle, in: Capsule())
                                .overlay(Capsule().strokeBorder(reaction.viewerHasReacted ? T3Colors.accent : T3Colors.border, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .disabled(!context.canReact || context.set == nil || model.pending.contains(reaction.content) || !PullRequestReactionLogic.order.contains(reaction.content))
                        .accessibilityLabel("\(PullRequestReactionLogic.label(reaction.content)), \(reaction.count)")
                        .accessibilityValue(reaction.viewerHasReacted ? "Selected" : "Not selected")
                        .accessibilityHint(PullRequestReactionLogic.actors(reaction))
                        .contextMenu { Text(PullRequestReactionLogic.actors(reaction)) }
                    }
                    if context.canReact, context.set != nil {
                        Menu {
                            ForEach(PullRequestReactionLogic.order, id: \.self) { content in
                                Button("\(PullRequestReactionLogic.emoji(content)) \(PullRequestReactionLogic.label(content))") { toggle(content) }
                                    .disabled(model.pending.contains(content))
                            }
                        } label: { Image(systemName: "face.smiling").frame(width: 44, height: 44) }
                        .accessibilityLabel("Add or remove reaction")
                    }
                }
            }.scrollIndicators(.hidden).frame(height: 44)
            if let error = model.error { Text(error).font(T3Typography.supporting).foregroundStyle(T3Colors.warning) }
        }
        .onChange(of: reactions) { _, latest in model.reconcile(latest) }
    }
    private func toggle(_ content: String) {
        guard let set = context.set else { return }
        Task { await model.toggle(content, send: { content, reacted in
            try await set(.init(subjectId: subjectID, content: content, reacted: reacted))
        }, refresh: context.refresh) }
    }
}
