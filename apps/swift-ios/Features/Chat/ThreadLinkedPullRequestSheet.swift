import SwiftUI

/// Manages linked requests and their persisted stack and host state.
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
    private var links: [FeatureLinkedPullRequest] { thread.allLinkedPullRequests }
    @State private var selectedLink: FeatureLinkedPullRequest?

    /// Hidden when the branch's request is already the linked one: "Link #12"
    /// under a row that says #12 is linked reads as a bug.
    private var linkableBranchPullRequest: ThreadDetailsPullRequest? {
        guard let branchPullRequest, !links.contains(where: { $0.number == branchPullRequest.number && $0.url == branchPullRequest.url }) else { return nil }
        return branchPullRequest
    }

    private var entryNumber: Int? { ThreadLinkedPullRequestInput.parse(entry) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !links.isEmpty {
                    ThreadDetailsSection(title: "Linked pull requests", footer: "The task stays active while any linked pull request is open.") {
                        let lines = FeaturePullRequestLines.resolve(links)
                        ForEach(lines) { line in
                            ThreadLinkedPullRequestRow(line: line, isBusy: isBusy,
                                open: { selectedLink = line.link }, unlink: { unlink(line.link) })
                            if line.link.identity != lines.last?.id { ThreadDetailsDivider() }
                        }
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
                    title: thread.supportsMultiplePullRequests == true ? "Add a pull request" : (linked == nil ? "Link a pull request" : "Link a different one"),
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
        .navigationTitle("Pull requests")
        .navigationDestination(item: $selectedLink) { link in
            if let manager = client as? any FeatureProjectPullRequestManaging,
               let host = link.host ?? URL(string: link.url)?.host {
                PullRequestDetailSheet(access: FeaturePullRequestAccess(manager: manager,
                    scope: FeaturePullRequestProjectScope(projectID: link.projectID, host: host, repository: link.repository)), number: link.number)
            } else {
                PullRequestDetailSheet(client: client, threadID: thread.id, number: link.number)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") { onFinished() }
                    .disabled(isBusy)
            }
        }
    }

    private func unlink(_ link: FeatureLinkedPullRequest) {
        guard !isBusy else { return }
        if thread.supportsMultiplePullRequests != true { commit(number: nil); return }
        isBusy = true; errorMessage = nil
        Task { @MainActor in
            do { try await client.removeThreadPullRequest(threadID: thread.id, link: link); onFinished() }
            catch { errorMessage = error.localizedDescription }
            isBusy = false
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
                if thread.supportsMultiplePullRequests == true, let number {
                    _ = try await client.addThreadPullRequest(threadID: thread.id, number: number)
                } else {
                    _ = try await client.setThreadLinkedPullRequest(threadID: thread.id, number: number)
                }
                onFinished()
            } catch {
                errorMessage = error.localizedDescription
            }
            isBusy = false
        }
    }
}

private struct ThreadLinkedPullRequestRow: View {
    let line: FeaturePullRequestLine
    let isBusy: Bool
    let open: () -> Void
    let unlink: () -> Void

    private var link: FeatureLinkedPullRequest { line.link }
    private var stateTitle: String {
        guard let snapshot = link.snapshot else { return "Waiting for host state" }
        return snapshot.isDraft && snapshot.state == "open" ? "Draft" : snapshot.state.capitalized
    }
    private var stateColor: Color {
        switch link.snapshot?.state {
        case "merged": T3Colors.syntaxKeyword
        case "closed": T3Colors.danger
        case "open": link.snapshot?.isDraft == true ? T3Colors.textTertiary : T3Colors.success
        default: T3Colors.textTertiary
        }
    }
    private var stateIcon: String {
        switch link.snapshot?.state {
        case "merged": "arrow.triangle.merge"
        case "closed": "xmark.circle"
        case "open" where link.snapshot?.isDraft == true: "circle.dashed"
        default: "arrow.triangle.pull"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            if line.depth > 0 {
                Rectangle().fill(T3Colors.border).frame(width: 1).padding(.vertical, 4).accessibilityHidden(true)
            }
            Button(action: open) {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: stateIcon).foregroundStyle(stateColor)
                        Text("#\(link.number)").monospacedDigit().foregroundStyle(T3Colors.textSecondary)
                        Text(stateTitle).foregroundStyle(stateColor)
                        Spacer(minLength: 0)
                    }
                    .font(.caption)
                    Text(link.snapshot?.title ?? link.repository)
                        .font(T3Typography.control).foregroundStyle(T3Colors.textPrimary)
                        .multilineTextAlignment(.leading).lineLimit(2)
                    if let snapshot = link.snapshot {
                        Text("\(snapshot.headBranch) → \(snapshot.baseBranch)")
                            .font(.caption.monospaced()).foregroundStyle(T3Colors.textTertiary).lineLimit(1)
                        HStack(spacing: 8) {
                            if let checks = snapshot.checksState {
                                Label(checks == "passing" ? "Checks pass" : checks == "failing" ? "Checks failed" : "Checks pending",
                                      systemImage: checks == "passing" ? "checkmark.circle" : checks == "failing" ? "xmark.circle" : "clock")
                                    .foregroundStyle(checks == "passing" ? T3Colors.success : checks == "failing" ? T3Colors.danger : T3Colors.textTertiary)
                            }
                            if let additions = snapshot.additions, let deletions = snapshot.deletions {
                                Text("+\(additions)").foregroundStyle(T3Colors.diffAddition)
                                Text("−\(deletions)").foregroundStyle(T3Colors.diffDeletion)
                            }
                        }
                        .font(.caption2).monospacedDigit()
                        if snapshot.state == "open", snapshot.reviewDecision == "approved" || snapshot.reviewDecision == "changes-requested" {
                            Text(snapshot.reviewDecision == "approved" ? "Approved" : "Changes requested")
                                .font(.caption2).foregroundStyle(snapshot.reviewDecision == "approved" ? T3Colors.success : T3Colors.warning)
                        }
                        if snapshot.state == "open", snapshot.mergeability == "conflicting" {
                            Text("Conflicts").font(.caption2).foregroundStyle(T3Colors.danger)
                        }
                    }
                    if let source = link.sourceLabel {
                        Text(source + (link.snapshot?.author.map { " · \($0)" } ?? ""))
                            .font(.caption2).foregroundStyle(T3Colors.textTertiary)
                    }
                    if line.depth == 0, line.chainSize > 1 {
                        Label("\(line.chainSize) \(line.isNativeStack ? "in stack" : "in branch chain")", systemImage: "square.3.layers.3d")
                            .font(.caption2).foregroundStyle(T3Colors.textSecondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Open pull request details")
            Menu {
                Button("Copy link", systemImage: "doc.on.doc") { UIPasteboard.general.string = link.url }
                if let url = URL(string: link.url) { Link("Open in browser", destination: url) }
                Button(link.source == "stack" ? "Dismiss from thread" : "Unlink from thread", systemImage: "link.badge.plus", role: .destructive, action: unlink)
                    .disabled(isBusy)
            } label: {
                Image(systemName: "ellipsis").frame(width: 36, height: 44)
            }
            .accessibilityLabel("Actions for pull request \(link.number)")
        }
        .padding(.leading, 16 + CGFloat(min(line.depth, 3)) * 12)
        .padding(.trailing, 6)
        .padding(.vertical, 12)
    }
}
