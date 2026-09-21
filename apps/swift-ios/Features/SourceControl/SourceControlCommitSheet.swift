import SwiftUI

/// The commit message form for the three commit actions, titled after the one
/// that opened it, with a summary of what gets committed and where it goes.
struct SourceControlCommitSheet: View {
    let action: FeatureSourceControlAction
    let status: FeatureSourceControlStatus
    let onCommit: (String) -> Void

    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var message = ""
    @FocusState private var isMessageFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Commit message", text: $message, axis: .vertical)
                        .lineLimit(3...10)
                        .focused($isMessageFocused)
                        .t3GroupedRow()
                } footer: {
                    if trimmedMessage.isEmpty {
                        Text("Write a message to commit.")
                    }
                }

                Section {
                    LabeledContent("Changes") {
                        HStack(spacing: 6) {
                            Text(fileCount)
                            if status.insertions > 0 || status.deletions > 0 {
                                Text("+\(status.insertions)")
                                    .foregroundStyle(T3Colors.diffAddition)
                                Text("−\(status.deletions)")
                                    .foregroundStyle(T3Colors.diffDeletion)
                            }
                        }
                        .font(.body.monospacedDigit())
                    }
                    .t3GroupedRow()
                    LabeledContent("Branch", value: status.branch ?? "Detached HEAD")
                        .t3GroupedRow()
                } footer: {
                    Text(summary)
                }
            }
            .listStyle(.insetGrouped)
            .t3GroupedListBackground()
            .navigationTitle(action.verb)
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: action.verb,
                    isEnabled: !trimmedMessage.isEmpty,
                    action: commit
                ),
                hasChanges: !trimmedMessage.isEmpty
            )
            .onAppear { isMessageFocused = true }
        }
        .presentationDetents([.medium, .large])
    }

    private var trimmedMessage: String {
        message.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var fileCount: String {
        let count = status.files.count
        return count == 1 ? "1 file" : "\(count) files"
    }

    private var summary: String {
        let branch = status.branch ?? "the current commit"
        switch action {
        case .commitAndPush:
            return "Commits all changes, then pushes \(branch) to the remote."
        case .commitPushAndCreatePullRequest:
            return "Commits all changes, pushes \(branch), and opens a pull request."
        default:
            return "Commits all changes on \(branch). Nothing leaves this machine until you push."
        }
    }

    private func commit() {
        guard !trimmedMessage.isEmpty else { return }
        onCommit(trimmedMessage)
        dismiss()
    }
}
