import SwiftUI

/// One review conversation: its state and place in the diff, the remarks, and
/// a reply field with its send button beside it. Resolved conversations start
/// collapsed.
struct PullRequestThreadCard: View {
    let thread: PullRequestReviewThread
    let access: FeaturePullRequestThreadAccess?
    let canReply: Bool
    let canResolve: Bool
    let editing: FeaturePullRequestEditingAccess?
    let reactions: PullRequestReactionContext
    let canEditComment: (PullRequestThreadComment) -> Bool
    let onReplied: () async -> Void
    @State private var textEdit: PullRequestTextEdit?
    @State private var model: PullRequestThreadModel
    @State private var expanded: Bool

    init(thread: PullRequestReviewThread, access: FeaturePullRequestThreadAccess?, canReply: Bool, canResolve: Bool, editing: FeaturePullRequestEditingAccess?, reactions: PullRequestReactionContext, canEditComment: @escaping (PullRequestThreadComment) -> Bool, onReplied: @escaping () async -> Void) {
        self.thread = thread; self.access = access; self.canReply = canReply; self.canResolve = canResolve; self.editing = editing; self.reactions = reactions; self.canEditComment = canEditComment; self.onReplied = onReplied
        _model = State(initialValue: PullRequestThreadModel(thread: thread))
        _expanded = State(initialValue: !thread.isResolved)
    }

    private var commentCount: Int { max(thread.commentCount ?? 0, model.comments.count) }

    /// "1 comment", "3 comments".
    static func commentCount(_ count: Int) -> String {
        count == 1 ? "1 comment" : "\(count) comments"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 8) {
                    stateBadge
                    Text(Self.commentCount(commentCount))
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(T3Colors.textTertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            Text("\(thread.path)\(thread.line.map { " · L\($0)" } ?? "")\(thread.side == "left" ? " · previous version" : "")\(thread.isOutdated ? " · outdated" : "")")
                .font(T3Typography.tool).foregroundStyle(T3Colors.textSecondary).textSelection(.enabled)
            if expanded {
                ForEach(model.comments) { comment in
                    commentRow(comment)
                    Divider()
                }
                if let access, model.cursor != nil {
                    Button("Show More Comments") { Task { await model.loadMore(load: access.loadMore) } }
                        .disabled(model.pending)
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                }
                if let access, canReply {
                    replyField(access)
                }
                if let access, canResolve {
                    Button(model.resolved ? "Reopen Conversation" : "Resolve Conversation") {
                        Task {
                            await model.toggleResolution(send: access.resolve)
                            if model.error == nil { PlatformHapticEngine.shared.play(.success) }
                        }
                    }
                    .disabled(model.pending)
                    .frame(minHeight: T3Metrics.minimumTapTarget)
                }
                if let error = model.error {
                    Label(error, systemImage: "exclamationmark.circle")
                        .foregroundStyle(T3Colors.danger).font(T3Typography.supporting)
                }
            }
        }
        .padding(12)
        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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
        .onChange(of: model.error) { _, error in
            if error != nil { PlatformHapticEngine.shared.play(.error) }
        }
        .accessibilityElement(children: .contain)
    }

    private var stateBadge: some View {
        let tone: PullRequestStatusTone = model.resolved ? .neutral : .success
        return Text(model.resolved ? "Resolved" : "Open")
            .font(T3Typography.supportingStrong)
            .foregroundStyle(tone.color)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(tone.color.opacity(0.14), in: Capsule())
    }

    private func commentRow(_ comment: PullRequestThreadComment) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                PullRequestAvatar(login: comment.author?.login ?? "?", avatarURL: comment.author?.avatarUrl)
                Text(comment.author?.login ?? "Unknown")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textPrimary)
                if let relative = PullRequestDetailSections.relativeLabel(comment.createdAt) {
                    Text(relative).font(T3Typography.supporting).foregroundStyle(T3Colors.textTertiary)
                }
            }
            MarkdownMessageView(comment.body)
            if reactions.canReact || !(comment.reactions ?? []).isEmpty {
                PullRequestReactionBar(reactions: comment.reactions ?? [], subjectID: comment.id, context: reactions)
            }
        }
        .contentShape(Rectangle())
        .contextMenu {
            PullRequestSelectionMenuItems(selection: .comment(comment, thread: thread))
            if editing != nil, canEditComment(comment) {
                Button("Edit", systemImage: "pencil") {
                    textEdit = .comment(id: comment.id, kind: "review-comment", body: comment.body)
                }
            }
        }
    }

    private func replyField(_ access: FeaturePullRequestThreadAccess) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Reply", text: $model.reply, axis: .vertical)
                .lineLimit(1...8)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .disabled(model.pending)
            if model.pending {
                ProgressView().frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
            } else {
                Button {
                    Task {
                        if await model.send(send: access.reply) {
                            PlatformHapticEngine.shared.play(.success)
                            await onReplied()
                        }
                    }
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(T3Colors.primaryActionForeground)
                        .frame(width: 32, height: 32)
                        .background(T3Colors.primaryAction, in: Circle())
                        .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!PullRequestReviewDraftModel.validBody(model.reply))
                .opacity(PullRequestReviewDraftModel.validBody(model.reply) ? 1 : 0.4)
                .accessibilityLabel("Send reply")
            }
        }
    }
}

@MainActor
struct PullRequestConversationContext {
    let threads: [PullRequestReviewThread]
    let access: FeaturePullRequestThreadAccess?
    let canReply: Bool
    let canResolve: Bool
    let editing: FeaturePullRequestEditingAccess?
    let reactions: PullRequestReactionContext
    let canEditComment: (PullRequestThreadComment) -> Bool
    let refresh: () async -> Void
}
