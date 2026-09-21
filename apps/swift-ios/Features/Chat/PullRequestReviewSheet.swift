import SwiftUI

/// Writes and submits a review: the verdict, a summary, and the line comments
/// drafted from the Code tab. The draft stays on this device until submitted,
/// so closing the sheet loses nothing.
struct PullRequestReviewSheet: View {
    @Bindable var draft: PullRequestReviewDraftModel
    let verdicts: [String]
    let submit: (PullRequestReviewSubmission) async throws -> Void
    let onSubmitted: () -> Void
    @State private var verdict = "comment"
    @State private var editing: NativePullRequestPendingComment?
    @SwiftUI.Environment(\.dismiss) private var dismiss

    private var summaryTooLong: Bool { draft.summary.utf16.count > 65_536 }

    var body: some View {
        NavigationStack {
            Form {
                if verdicts.count > 1 {
                    Section {
                        Picker("Verdict", selection: $verdict) {
                            ForEach(verdicts, id: \.self) { Text(Self.label($0)).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        .disabled(draft.submitting)
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                Section {
                    ZStack(alignment: .topLeading) {
                        if draft.summary.isEmpty {
                            Text("Summarize your review (optional)")
                                .foregroundStyle(T3Colors.placeholder)
                                .padding(.top, 8)
                                .padding(.leading, 5)
                                .accessibilityHidden(true)
                        }
                        TextEditor(text: $draft.summary)
                            .frame(minHeight: 120)
                            .scrollContentBackground(.hidden)
                            .accessibilityLabel("Review summary")
                    }
                    .disabled(draft.submitting)
                } header: {
                    Text("Summary")
                } footer: {
                    if summaryTooLong {
                        Text("The summary exceeds the host’s 65,536-character limit.").foregroundStyle(T3Colors.danger)
                    }
                }
                .t3GroupedRow()
                if !draft.comments.isEmpty {
                    Section {
                        ForEach(draft.comments) { entry in
                            // The row edits; deleting is a swipe, so one tap can
                            // never do both.
                            Button { editing = entry } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(entry.comment.body)
                                        .font(T3Typography.threadBody)
                                        .foregroundStyle(T3Colors.textPrimary)
                                        .lineLimit(3)
                                    Text("\(entry.comment.path) · L\(entry.comment.position.newLine ?? entry.comment.position.oldLine ?? 0)")
                                        .font(T3Typography.tool)
                                        .foregroundStyle(T3Colors.textTertiary)
                                        .lineLimit(1)
                                        .truncationMode(.head)
                                }
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button("Delete", systemImage: "trash", role: .destructive) { draft.remove(entry.id) }
                            }
                            .disabled(draft.submitting)
                        }
                    } header: {
                        Text("Line Comments")
                    }
                    .t3GroupedRow()
                }
                Section {
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        if let error = draft.error {
                            Text(error).foregroundStyle(T3Colors.danger)
                        }
                        Text("Saved on this device until you submit. Closing keeps the draft.")
                    }
                }
            }
            .t3GroupedListBackground()
            .navigationTitle("Review")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(
                .close,
                confirm: T3SheetConfirmation(
                    title: "Submit",
                    isEnabled: draft.canSubmit(verdict, offered: verdicts),
                    isBusy: draft.submitting,
                    action: submitReview
                )
            )
            .sheet(item: $editing) { entry in
                PullRequestPendingCommentEditor(entry: entry, draft: draft)
            }
            .interactiveDismissDisabled(draft.submitting)
            .onAppear { if !verdicts.contains(verdict) { verdict = verdicts.first ?? "comment" } }
        }
        .presentationDetents([.medium, .large])
        .t3GlassSheetBackground()
    }

    private func submitReview() {
        Task {
            if await draft.submit(verdict: verdict, offered: verdicts, send: submit) {
                PlatformHapticEngine.shared.play(.success)
                dismiss(); onSubmitted()
            } else if draft.error != nil {
                PlatformHapticEngine.shared.play(.error)
            }
        }
    }

    private static func label(_ verdict: String) -> String {
        switch verdict {
        case "approve": "Approve"
        case "request-changes": "Request Changes"
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
                Section {
                    Text(verbatim: line.text).font(T3Typography.code).textSelection(.enabled)
                } header: {
                    Text(file.path).lineLimit(1).truncationMode(.head)
                } footer: {
                    Text("Line \(line.newLine ?? line.oldLine ?? 0) · \(line.kind == .deletion ? "previous version" : "new version")")
                }
                .t3GroupedRow()
                Section {
                    PullRequestCommentField(text: $bodyText, placeholder: "Leave a comment")
                } footer: {
                    Text("This comment is saved privately until you submit the review.")
                }
                .t3GroupedRow()
            }
            .t3GroupedListBackground()
            .navigationTitle("Comment on Line")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: "Add to Review",
                    isEnabled: PullRequestReviewDraftModel.validBody(bodyText),
                    action: { draft.add(file: file, line: line, body: bodyText); dismiss() }
                ),
                hasChanges: !bodyText.isEmpty
            )
        }
        .presentationDetents([.medium, .large])
        .t3GlassSheetBackground()
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
                Section {
                    PullRequestCommentField(text: $bodyText, placeholder: "Leave a comment")
                } header: {
                    Text(entry.comment.path).lineLimit(1).truncationMode(.head)
                }
                .t3GroupedRow()
            }
            .t3GroupedListBackground()
            .navigationTitle("Edit Line Comment")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: "Save",
                    isEnabled: PullRequestReviewDraftModel.validBody(bodyText) && bodyText != entry.comment.body,
                    action: { draft.edit(entry.id, body: bodyText); dismiss() }
                ),
                hasChanges: bodyText != entry.comment.body
            )
        }
        .presentationDetents([.medium, .large])
        .t3GlassSheetBackground()
    }
}

/// A multi-line comment field with a placeholder, which `TextEditor` lacks.
private struct PullRequestCommentField: View {
    @Binding var text: String
    let placeholder: String

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder)
                    .foregroundStyle(T3Colors.placeholder)
                    .padding(.top, 8)
                    .padding(.leading, 5)
                    .accessibilityHidden(true)
            }
            TextEditor(text: $text)
                .frame(minHeight: 140)
                .scrollContentBackground(.hidden)
                .accessibilityLabel(placeholder)
        }
    }
}
