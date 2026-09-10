import SwiftUI

struct PullRequestReviewSheet: View {
    @Bindable var draft: PullRequestReviewDraftModel
    let verdicts: [String]
    let submit: (PullRequestReviewSubmission) async throws -> Void
    let onSubmitted: () -> Void
    @State private var verdict = "comment"
    @State private var editing: NativePullRequestPendingComment?
    @SwiftUI.Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Summary") {
                    TextEditor(text: $draft.summary).frame(minHeight: 140)
                        .accessibilityLabel("Review summary")
                    if draft.summary.utf16.count > 65_536 {
                        Text("The summary exceeds the host’s 65,536-character limit.").foregroundStyle(T3Colors.warning)
                    }
                }
                Section("Pending line comments · \(draft.comments.count)") {
                    ForEach(draft.comments) { entry in
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(entry.comment.path):\(entry.comment.position.newLine ?? entry.comment.position.oldLine ?? 0)")
                                .font(T3Typography.supporting.monospaced())
                            Text(entry.comment.body).font(T3Typography.supporting)
                            Button("Edit") { editing = entry }.disabled(draft.submitting)
                            Button("Remove", role: .destructive) { draft.remove(entry.id) }.disabled(draft.submitting)
                        }
                    }
                    if draft.comments.isEmpty { Text("No line comments yet.").foregroundStyle(T3Colors.textSecondary) }
                }
                Section {
                    Picker("Verdict", selection: $verdict) {
                        ForEach(verdicts, id: \.self) { Text(Self.label($0)).tag($0) }
                    }
                    if let error = draft.error { Text(error).foregroundStyle(T3Colors.warning) }
                    Button {
                        Task {
                            if await draft.submit(verdict: verdict, offered: verdicts, send: submit) {
                                dismiss(); onSubmitted()
                            }
                        }
                    } label: {
                        HStack { Text(draft.submitting ? "Submitting…" : "Submit review"); if draft.submitting { ProgressView() } }
                    }.disabled(!draft.canSubmit(verdict, offered: verdicts))
                } footer: {
                    Text("Your summary and line comments stay private on this device until you submit. Closing this sheet keeps the draft.")
                }
            }
            .scrollContentBackground(.hidden).background(T3Colors.background)
            .navigationTitle("Review pull request").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(draft.submitting) } }
            .sheet(item: $editing) { entry in
                PullRequestPendingCommentEditor(entry: entry, draft: draft)
            }
            .interactiveDismissDisabled(draft.submitting)
            .onAppear { if !verdicts.contains(verdict) { verdict = verdicts.first ?? "comment" } }
        }
    }

    private static func label(_ verdict: String) -> String {
        switch verdict {
        case "approve": "Approve"
        case "request-changes": "Request changes"
        default: "Comment"
        }
    }
}

struct PullRequestLineCommentSheet: View {
    let file: FeatureReviewFile
    let line: FeatureDiffLine
    let draft: PullRequestReviewDraftModel
    @State private var bodyText = ""
    @SwiftUI.Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section(file.path) {
                    Text("Line \(line.newLine ?? line.oldLine ?? 0) · \(line.kind == .deletion ? "previous version" : "new version")")
                        .font(T3Typography.supporting)
                    Text(verbatim: line.text).font(T3Typography.code).textSelection(.enabled)
                }
                Section("Line comment") {
                    TextEditor(text: $bodyText).frame(minHeight: 140).accessibilityLabel("Line comment")
                }
                Section {
                    Button("Add to review") { draft.add(file: file, line: line, body: bodyText); dismiss() }
                        .disabled(!PullRequestReviewDraftModel.validBody(bodyText))
                } footer: { Text("This comment is saved privately until you submit the review.") }
            }
            .scrollContentBackground(.hidden).background(T3Colors.background)
            .navigationTitle("Comment on line").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

private struct PullRequestPendingCommentEditor: View {
    let entry: NativePullRequestPendingComment
    let draft: PullRequestReviewDraftModel
    @State private var bodyText: String
    @SwiftUI.Environment(\.dismiss) private var dismiss
    init(entry: NativePullRequestPendingComment, draft: PullRequestReviewDraftModel) {
        self.entry = entry; self.draft = draft; _bodyText = State(initialValue: entry.comment.body)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section(entry.comment.path) { TextEditor(text: $bodyText).frame(minHeight: 180).accessibilityLabel("Line comment") }
                Button("Save draft") { draft.edit(entry.id, body: bodyText); dismiss() }
                    .disabled(!PullRequestReviewDraftModel.validBody(bodyText))
            }
            .scrollContentBackground(.hidden).background(T3Colors.background)
            .navigationTitle("Edit line comment").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}
