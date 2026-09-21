import SwiftUI
import UIKit

/// Manages linked requests and their persisted stack and host state. Pushed
/// inside Thread Details.
///
/// A linked request replaces the branch-derived one: the row shows it, and it is
/// what the merge settle rule watches. That matters for the two cases the branch
/// cannot answer — one branch backing several requests, and a thread whose
/// worktree is gone but whose request is still open.
///
/// Web offers this from a right-click on a pull request link in the transcript.
/// There is no equivalent gesture over rendered inline text on a phone, so this
/// screen is the entry point instead. It stays open after a link or unlink, so
/// several can be managed in one visit.
struct ThreadLinkedPullRequestSheet: View {
    let thread: FeatureThread
    /// The request the thread's branch currently resolves to, offered as a
    /// one-tap link because it is the one the reader is most likely to mean.
    let branchPullRequest: ThreadDetailsPullRequest?
    let client: any FeatureClient

    @State private var entry = ""
    /// The request being linked or unlinked, whose row shows the spinner.
    @State private var busyNumber: Int?
    @State private var errorMessage: String?
    @FocusState private var isFieldFocused: Bool
    @SwiftUI.Environment(\.openURL) private var openURL

    private var isBusy: Bool { busyNumber != nil }
    private var linked: FeatureLinkedPullRequest? { thread.linkedPullRequest }
    private var links: [FeatureLinkedPullRequest] { thread.allLinkedPullRequests }
    private var supportsSeveral: Bool { thread.supportsMultiplePullRequests == true }

    /// Hidden when the branch's request is already the linked one: "Link #12"
    /// under a row that says #12 is linked reads as a bug.
    private var linkableBranchPullRequest: ThreadDetailsPullRequest? {
        guard let branchPullRequest, !links.contains(where: { $0.number == branchPullRequest.number && $0.url == branchPullRequest.url }) else { return nil }
        return branchPullRequest
    }

    private var entryNumber: Int? { ThreadLinkedPullRequestInput.parse(entry) }

    private var addSectionTitle: String {
        if supportsSeveral { return "Add Pull Request" }
        return linked == nil ? "Link Pull Request" : "Replace Linked Pull Request"
    }

    var body: some View {
        List {
            if !links.isEmpty {
                Section {
                    ForEach(FeaturePullRequestLines.resolve(links)) { line in
                        linkRow(line)
                    }
                } header: {
                    Text("Linked")
                } footer: {
                    Text("The task stays active while any linked pull request is open.")
                }
                .t3GroupedRow()
            }

            if let branch = linkableBranchPullRequest {
                Section("On This Branch") {
                    Button {
                        commit(number: branch.number)
                    } label: {
                        LabeledContent {
                            if busyNumber == branch.number {
                                ProgressView()
                            } else if !branch.state.isEmpty {
                                Text(branch.state.capitalized)
                            }
                        } label: {
                            Text("Link #\(branch.number)")
                                .foregroundStyle(T3Colors.accent)
                        }
                    }
                    .disabled(isBusy)
                }
                .t3GroupedRow()
            }

            Section {
                HStack(spacing: 10) {
                    TextField("Number or URL", text: $entry)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        // The URL keyboard has no "#", which the placeholder
                        // invites; the ASCII keyboard has both.
                        .keyboardType(.asciiCapable)
                        .submitLabel(.go)
                        .focused($isFieldFocused)
                        .disabled(isBusy)
                        .accessibilityLabel("Pull request number or URL")
                        .onSubmit { if let entryNumber { commit(number: entryNumber) } }
                    if isBusy, busyNumber == entryNumber {
                        ProgressView()
                    } else {
                        Button("Link") { commit(number: entryNumber) }
                            .buttonStyle(.bordered)
                            .tint(T3Colors.textPrimary)
                            .disabled(entryNumber == nil || isBusy)
                    }
                }
            } header: {
                Text(addSectionTitle)
            } footer: {
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(T3Colors.danger)
                } else {
                    Text("Paste a number or a pull request URL from this thread's project.")
                }
            }
            .t3GroupedRow()
        }
        .t3SheetList()
        .t3GroupedListBackground()
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(supportsSeveral ? "Linked Pull Requests" : "Linked Pull Request")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(isBusy)
        .t3NavigationChrome()
    }

    private func linkRow(_ line: FeaturePullRequestLine) -> some View {
        let link = line.link
        return NavigationLink {
            detail(for: link)
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        PullRequestStateBadge(snapshot: link.snapshot)
                        Text(ThreadLinkedPullRequestPresentation.identityLine(line))
                            .font(T3Typography.supporting)
                            .monospacedDigit()
                            .foregroundStyle(T3Colors.textTertiary)
                            .lineLimit(1)
                    }
                    Text(link.snapshot?.title ?? link.repository)
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(2)
                    if let status = ThreadLinkedPullRequestPresentation.statusLine(link.snapshot) {
                        Text(status)
                            .font(T3Typography.supporting)
                            .monospacedDigit()
                            .foregroundStyle(T3Colors.textSecondary)
                            .lineLimit(1)
                    }
                }
                .padding(.leading, CGFloat(min(line.depth, 3)) * 12)
                if busyNumber == link.number {
                    Spacer(minLength: 0)
                    ProgressView()
                }
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
                unlink(link)
            } label: {
                Label(link.source == "stack" ? "Dismiss" : "Unlink", systemImage: "xmark")
            }
            .disabled(isBusy)
        }
        .contextMenu {
            Button("Copy Link", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = link.url
                T3HUD.show("Copied", systemImage: "doc.on.doc")
            }
            if let url = URL(string: link.url) {
                Button("Open in Browser", systemImage: "safari") { openURL(url) }
            }
            Button(link.source == "stack" ? "Dismiss from Thread" : "Unlink from Thread", systemImage: "xmark", role: .destructive) {
                unlink(link)
            }
            .disabled(isBusy)
        }
        .accessibilityHint("Opens pull request details")
    }

    @ViewBuilder
    private func detail(for link: FeatureLinkedPullRequest) -> some View {
        if let manager = client as? any FeatureProjectPullRequestManaging,
           let host = link.host ?? URL(string: link.url)?.host {
            PullRequestDetailSheet(access: FeaturePullRequestAccess(manager: manager,
                scope: FeaturePullRequestProjectScope(projectID: link.projectID, host: host, repository: link.repository)), number: link.number)
        } else {
            PullRequestDetailSheet(client: client, threadID: thread.id, number: link.number)
        }
    }

    private func unlink(_ link: FeatureLinkedPullRequest) {
        guard !isBusy else { return }
        if !supportsSeveral { commit(number: nil, busy: link.number); return }
        busyNumber = link.number; errorMessage = nil
        Task { @MainActor in
            defer { busyNumber = nil }
            do {
                try await client.removeThreadPullRequest(threadID: thread.id, link: link)
                PlatformHapticEngine.shared.play(.success)
            } catch {
                errorMessage = error.localizedDescription
                PlatformHapticEngine.shared.play(.error)
            }
        }
    }

    /// `nil` unlinks. The screen stays open either way; a failure keeps the
    /// value in the field, because the failure is about that value.
    private func commit(number: Int?, busy: Int? = nil) {
        guard !isBusy, let marker = busy ?? number else { return }
        busyNumber = marker
        errorMessage = nil
        Task { @MainActor in
            defer { busyNumber = nil }
            do {
                if supportsSeveral, let number {
                    _ = try await client.addThreadPullRequest(threadID: thread.id, number: number)
                } else {
                    _ = try await client.setThreadLinkedPullRequest(threadID: thread.id, number: number)
                }
                if number != nil, number == entryNumber { entry = "" }
                isFieldFocused = false
                PlatformHapticEngine.shared.play(.success)
            } catch {
                errorMessage = error.localizedDescription
                PlatformHapticEngine.shared.play(.error)
            }
        }
    }
}
