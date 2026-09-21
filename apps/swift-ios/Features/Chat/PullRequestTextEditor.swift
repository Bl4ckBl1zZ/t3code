import SwiftUI

/// Edits a pull request's title or description, a comment, or writes a new
/// one. The title is one line at the medium detent; long text gets the full
/// sheet. The commit is the toolbar's confirm button.
struct PullRequestTextEditor: View {
    let edit: PullRequestTextEdit
    let access: FeaturePullRequestEditingAccess
    let number: Int?
    let completed: () async -> Void
    let commentAction: NativePullRequestAction?
    let performCommentAction: (() async throws -> Void)?
    @State private var text: String
    @State private var pending = false
    @State private var error: String?
    @State private var confirmingStateChange = false
    @FocusState private var focused: Bool
    @SwiftUI.Environment(\.dismiss) private var dismiss
    init(edit: PullRequestTextEdit, access: FeaturePullRequestEditingAccess, number: Int? = nil, commentAction: NativePullRequestAction? = nil, performCommentAction: (() async throws -> Void)? = nil, completed: @escaping () async -> Void) {
        self.commentAction = commentAction; self.performCommentAction = performCommentAction; self.number = number
        self.edit = edit; self.access = access; self.completed = completed; _text = State(initialValue: edit.text)
    }

    private var isTitle: Bool { if case .title = edit { true } else { false } }
    private var isNewComment: Bool { edit.id == "new-comment" }
    private var hasChanges: Bool { text != edit.text }
    private var stateChangeLabel: String? {
        guard isNewComment, let commentAction, performCommentAction != nil else { return nil }
        return commentAction == .close ? "Close with Comment" : "Reopen with Comment"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if isTitle {
                        TextField("Title", text: $text)
                            .submitLabel(.done)
                            .onSubmit { if edit.valid(text), !pending { save() } }
                            .focused($focused)
                    } else {
                        ZStack(alignment: .topLeading) {
                            if text.isEmpty {
                                Text(isNewComment ? "Leave a comment" : "Write something")
                                    .foregroundStyle(T3Colors.placeholder)
                                    .padding(.top, 8)
                                    .padding(.leading, 5)
                                    .accessibilityHidden(true)
                            }
                            TextEditor(text: $text)
                                .frame(minHeight: 200)
                                .scrollContentBackground(.hidden)
                                .focused($focused)
                        }
                    }
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(T3Colors.danger)
                    } else if isTitle {
                        Text("Up to 1,024 characters.")
                    }
                }
                .disabled(pending)
                .accessibilityLabel(edit.label)
                .t3GroupedRow()

                if let stateChangeLabel {
                    Section {
                        Button(stateChangeLabel, role: commentAction == .close ? .destructive : nil) {
                            if commentAction == .close { confirmingStateChange = true } else { postWithStateChange() }
                        }
                        .disabled(pending || !edit.valid(text))
                        .confirmationDialog(
                            "Close \(number.map { "#\($0)" } ?? "this pull request") with this comment?",
                            isPresented: $confirmingStateChange,
                            titleVisibility: .visible
                        ) {
                            Button("Close with Comment", role: .destructive, action: postWithStateChange)
                            Button("Cancel", role: .cancel) {}
                        }
                    }
                    .t3GroupedRow()
                }
            }
            .t3GroupedListBackground()
            .navigationTitle(edit.label)
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: isNewComment ? "Post" : "Save",
                    isEnabled: edit.valid(text) && (hasChanges || isNewComment),
                    isBusy: pending,
                    action: save
                ),
                hasChanges: hasChanges || pending
            )
            .onAppear { focused = true }
        }
        .presentationDetents(isTitle ? [.medium] : [.large])
        .t3GlassSheetBackground()
    }

    private func save() {
        guard !pending else { return }
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
                PlatformHapticEngine.shared.play(.success)
                dismiss(); await completed()
            } catch {
                self.error = error.localizedDescription
                PlatformHapticEngine.shared.play(.error)
            }
        }
    }

    private func postWithStateChange() {
        guard let performCommentAction, !pending else { return }
        pending = true; error = nil
        Task {
            defer { pending = false }
            do {
                try await access.comment(text)
                // The comment is durable even if the host refuses the state change.
                text = ""
                do {
                    try await performCommentAction()
                    PlatformHapticEngine.shared.play(.success)
                    dismiss()
                } catch {
                    self.error = "Comment posted. \(error.localizedDescription)"
                    PlatformHapticEngine.shared.play(.error)
                }
                await completed()
            } catch {
                self.error = error.localizedDescription
                PlatformHapticEngine.shared.play(.error)
            }
        }
    }
}
