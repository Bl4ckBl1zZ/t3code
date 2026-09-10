import SwiftUI

struct PullRequestThreadCard: View {
    let thread: PullRequestReviewThread
    let access: FeaturePullRequestThreadAccess?
    let canReply: Bool
    let canResolve: Bool
    let editing: FeaturePullRequestEditingAccess?
    let canEditComment: (PullRequestThreadComment) -> Bool
    let onReplied: () async -> Void
    @State private var textEdit: PullRequestTextEdit?
    @State private var model: PullRequestThreadModel
    @State private var expanded: Bool

    init(thread: PullRequestReviewThread, access: FeaturePullRequestThreadAccess?, canReply: Bool, canResolve: Bool, editing: FeaturePullRequestEditingAccess?, canEditComment: @escaping (PullRequestThreadComment) -> Bool, onReplied: @escaping () async -> Void) {
        self.thread = thread; self.access = access; self.canReply = canReply; self.canResolve = canResolve; self.editing = editing; self.canEditComment = canEditComment; self.onReplied = onReplied
        _model = State(initialValue: PullRequestThreadModel(thread: thread))
        _expanded = State(initialValue: !thread.isResolved)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { expanded.toggle() } label: {
                HStack {
                    Image(systemName: model.resolved ? "checkmark.circle" : "bubble.left")
                    Text("\(model.resolved ? "Resolved" : "Open") · \(max(thread.commentCount ?? 0, model.comments.count)) comments")
                    Spacer()
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                }.font(T3Typography.supportingStrong).frame(minHeight: 44)
            }.buttonStyle(.plain)
            Text("\(thread.path)\(thread.line.map { ":\($0)" } ?? "")\(thread.side == "left" ? " · previous version" : "")\(thread.isOutdated ? " · outdated" : "")")
                .font(T3Typography.supporting.monospaced()).foregroundStyle(T3Colors.textSecondary).textSelection(.enabled)
            if expanded {
                ForEach(model.comments) { comment in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(comment.author?.login ?? "Unknown").font(T3Typography.supportingStrong)
                        MarkdownMessageView(comment.body)
                        if editing != nil, canEditComment(comment) {
                            Button("Edit comment", systemImage: "pencil") { textEdit = .comment(id: comment.id, kind: "review-comment", body: comment.body) }
                                .font(T3Typography.supporting).frame(minHeight: 44)
                        }
                    }
                    Divider()
                }
                if let access, model.cursor != nil {
                    Button("Load more comments") { Task { await model.loadMore(load: access.loadMore) } }.disabled(model.pending)
                }
                if let access, canReply {
                    TextField("Reply to conversation", text: $model.reply, axis: .vertical)
                        .lineLimit(2...8).padding(10).background(T3Colors.background, in: RoundedRectangle(cornerRadius: 8))
                    Button("Send reply") { Task { if await model.send(send: access.reply) { await onReplied() } } }
                        .disabled(model.pending || !PullRequestReviewDraftModel.validBody(model.reply))
                }
                if let access, canResolve {
                    Button(model.resolved ? "Reopen conversation" : "Resolve conversation") {
                        Task { await model.toggleResolution(send: access.resolve) }
                    }.disabled(model.pending)
                }
                if model.pending { ProgressView() }
                if let error = model.error { Text(error).foregroundStyle(T3Colors.warning).font(T3Typography.supporting) }
            }
        }
        .padding(12).background(T3Colors.subtle, in: RoundedRectangle(cornerRadius: 12))
        .sheet(item: $textEdit) { edit in
            if let editing {
                PullRequestTextEditor(edit: edit, access: FeaturePullRequestEditingAccess(update: editing.update,
                    updateComment: { id, kind, body in
                        try await editing.updateComment(id, kind, body)
                        model.updateComment(id: id, body: body)
                    }, comment: editing.comment), completed: onReplied)
            }
        }
        .onChange(of: thread) { _, latest in model.reconcile(latest) }
        .accessibilityElement(children: .contain)
    }
}

@MainActor
struct PullRequestConversationContext {
    let threads: [PullRequestReviewThread]
    let access: FeaturePullRequestThreadAccess?
    let canReply: Bool
    let canResolve: Bool
    let editing: FeaturePullRequestEditingAccess?
    let canEditComment: (PullRequestThreadComment) -> Bool
    let refresh: () async -> Void
}
