import SwiftUI

struct PullRequestTextEditor: View {
    let edit: PullRequestTextEdit
    let access: FeaturePullRequestEditingAccess
    let completed: () async -> Void
    let commentAction: NativePullRequestAction?
    let performCommentAction: (() async throws -> Void)?
    @State private var text: String
    @State private var pending = false
    @State private var error: String?
    @SwiftUI.Environment(\.dismiss) private var dismiss
    init(edit: PullRequestTextEdit, access: FeaturePullRequestEditingAccess, commentAction: NativePullRequestAction? = nil, performCommentAction: (() async throws -> Void)? = nil, completed: @escaping () async -> Void) {
        self.commentAction = commentAction; self.performCommentAction = performCommentAction
        self.edit = edit; self.access = access; self.completed = completed; _text = State(initialValue: edit.text)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text).frame(minHeight: 200).accessibilityLabel(edit.label).disabled(pending)
                    if let error { Text(error).foregroundStyle(T3Colors.warning) }
                    if edit.id == "new-comment", let commentAction, let performCommentAction {
                        Button(commentAction == .close ? "Close with comment" : "Reopen with comment", role: commentAction == .close ? .destructive : nil) {
                            pending = true; error = nil
                            Task {
                                defer { pending = false }
                                do {
                                    try await access.comment(text)
                                    // The comment is durable even if the host refuses the state change.
                                    text = ""
                                    do {
                                        try await performCommentAction()
                                        dismiss()
                                    } catch { self.error = "Comment posted. \(error.localizedDescription)" }
                                    await completed()
                                } catch { self.error = error.localizedDescription }
                            }
                        }.disabled(pending || !edit.valid(text))
                    }
                    Button {
                        pending = true; error = nil
                        Task {
                            defer { pending = false }
                            do {
                                switch edit {
                                case .title: try await access.update(.init(title: text.trimmingCharacters(in: .whitespacesAndNewlines), body: nil))
                                case .description: try await access.update(.init(title: nil, body: text))
                                case let .comment(id, kind, _): try await access.updateComment(id, kind, text)
                                case .newComment: try await access.comment(text)
                                }
                                dismiss(); await completed()
                            } catch { self.error = error.localizedDescription }
                        }
                    } label: { HStack { Text(edit.id == "new-comment" ? "Post comment" : "Save changes"); if pending { ProgressView() } } }
                        .disabled(pending || !edit.valid(text))
                }
            }
            .scrollContentBackground(.hidden).background(T3Colors.background)
            .navigationTitle(edit.label).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) } }
            .interactiveDismissDisabled(pending)
        }
    }
}
