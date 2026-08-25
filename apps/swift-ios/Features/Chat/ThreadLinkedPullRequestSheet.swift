import SwiftUI

/// Pins a pull request to a thread, or clears the pin.
///
/// A linked request replaces the branch-derived one: the row shows it, and it is
/// what the merge settle rule watches. That matters for the two cases the branch
/// cannot answer — one branch backing several requests, and a thread whose
/// worktree is gone but whose request is still open.
///
/// Web offers this from a right-click on a pull request link in the transcript.
/// There is no equivalent gesture over rendered inline text on a phone, so this
/// sheet is the entry point instead, reachable from Thread Details.
struct ThreadLinkedPullRequestSheet: View {
    let thread: FeatureThread
    /// The request the thread's branch currently resolves to, offered as a
    /// one-tap link because it is the one the reader is most likely to mean.
    let branchPullRequest: ThreadDetailsPullRequest?
    let client: any FeatureClient
    let onFinished: () -> Void

    @State private var entry = ""
    @State private var isBusy = false
    @State private var errorMessage: String?
    @FocusState private var isFieldFocused: Bool

    private var linked: FeatureLinkedPullRequest? { thread.linkedPullRequest }

    /// Hidden when the branch's request is already the linked one: "Link #12"
    /// under a row that says #12 is linked reads as a bug.
    private var linkableBranchPullRequest: ThreadDetailsPullRequest? {
        guard let branchPullRequest, branchPullRequest.number != linked?.number else { return nil }
        return branchPullRequest
    }

    private var entryNumber: Int? { ThreadLinkedPullRequestInput.parse(entry) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let linked {
                    ThreadDetailsSection(
                        title: "Linked",
                        footer: """
                        This thread follows pull request #\(linked.number) instead of whatever \
                        its branch points at.
                        """
                    ) {
                        ThreadDetailsRow(
                            systemImage: "arrow.triangle.pull",
                            title: "#\(linked.number)",
                            subtitle: linked.repository,
                            showsChevron: false
                        )
                        ThreadDetailsDivider()
                        ThreadDetailsRow(
                            systemImage: "link.badge.plus",
                            iconTint: T3Colors.danger,
                            title: "Unlink",
                            subtitle: "Go back to following the branch",
                            isDisabled: isBusy,
                            showsChevron: false,
                            action: { commit(number: nil) }
                        )
                    }
                }

                if let branch = linkableBranchPullRequest {
                    ThreadDetailsSection(title: "On this branch") {
                        ThreadDetailsRow(
                            systemImage: "arrow.triangle.pull",
                            title: "Link #\(branch.number)",
                            subtitle: branch.state.capitalized,
                            isDisabled: isBusy,
                            showsChevron: false,
                            action: { commit(number: branch.number) }
                        )
                    }
                }

                ThreadDetailsSection(
                    title: linked == nil ? "Link a pull request" : "Link a different one",
                    footer: """
                    Enter a number or paste a pull request URL. It has to belong to this \
                    thread's project.
                    """
                ) {
                    VStack(alignment: .leading, spacing: 12) {
                        TextField("#123 or a pull request URL", text: $entry)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .submitLabel(.done)
                            .focused($isFieldFocused)
                            .disabled(isBusy)
                            .settingsInputField()
                            .accessibilityLabel("Pull request number or URL")
                            .onSubmit { if entryNumber != nil { commit(number: entryNumber) } }

                        if let errorMessage {
                            SettingsErrorBanner(message: errorMessage)
                        }

                        SettingsActionButton(
                            title: "Link",
                            systemImage: "link",
                            tone: .primary,
                            isBusy: isBusy,
                            isDisabled: entryNumber == nil,
                            action: { commit(number: entryNumber) }
                        )
                        .padding(.horizontal, 16)
                    }
                    .padding(.vertical, 12)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 16)
        }
        .scrollDismissesKeyboard(.interactively)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .navigationTitle("Pull request")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") { onFinished() }
                    .disabled(isBusy)
            }
        }
    }

    /// `nil` unlinks. Either way the sheet closes on success and stays open on
    /// failure, because the failure is about the value still in the field.
    private func commit(number: Int?) {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        Task { @MainActor in
            do {
                _ = try await client.setThreadLinkedPullRequest(
                    threadID: thread.id,
                    number: number
                )
                onFinished()
            } catch {
                errorMessage = error.localizedDescription
            }
            isBusy = false
        }
    }
}
