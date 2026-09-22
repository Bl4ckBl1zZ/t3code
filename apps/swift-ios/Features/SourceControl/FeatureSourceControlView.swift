import SwiftUI
import UIKit

/// The workspace's git state and the actions that move it: commit, push, pull
/// and pull requests. Pushed inside Thread Details and also presented as a
/// sheet root, so it carries no close button of its own.
public struct FeatureSourceControlView: View {
    let client: any FeatureClient
    let threadID: String
    /// Lets file rows open Review at that file. Without it rows are plain.
    let reviewSelection: ReviewSelectionStore?

    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @State private var status: FeatureSourceControlStatus?
    @State private var isLoading = true
    /// Why the first load failed; the screen has nothing else to show.
    @State private var loadError: String?
    /// Why a later refresh failed; the last status stays on screen under it.
    @State private var refreshError: String?
    @State private var runningAction: FeatureSourceControlAction?
    @State private var progress: FeatureSourceControlProgress?
    @State private var failure: SourceControlFailure?
    @State private var commitAction: FeatureSourceControlAction?
    @State private var pendingDefaultBranchAction: FeatureSourceControlAction?
    @State private var reviewFilePath: String?
    @State private var isAskingAgent = false

    public init(
        client: any FeatureClient,
        threadID: String,
        reviewSelection: ReviewSelectionStore? = nil
    ) {
        self.client = client
        self.threadID = threadID
        self.reviewSelection = reviewSelection
    }

    public var body: some View {
        Group {
            if isLoading, status == nil {
                ProgressView("Loading repository…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let status, status.isRepository {
                statusList(status)
            } else if status?.isRepository == false {
                ContentUnavailableView(
                    "Not a Git Repository",
                    systemImage: "arrow.triangle.branch",
                    description: Text("This workspace isn't tracked by Git, so there's nothing to commit or push.")
                )
            } else {
                ContentUnavailableView {
                    Label("Couldn't Load Status", systemImage: "arrow.triangle.branch")
                } description: {
                    Text(loadError ?? "The repository status could not be loaded.")
                } actions: {
                    Button("Try Again") { Task { await load() } }
                }
            }
        }
        .background(T3Colors.background)
        .t3ToolTitle(
            "Source Control",
            subtitle: status.map { SourceControlBranchSummary.subtitle($0, step: runningStep) },
            subtitleColor: status?.isDefaultRef == true && runningAction == nil ? T3Colors.warning : nil
        )
        .t3NavigationChrome()
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        Task { await load() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    if let branch = status?.branch {
                        Button {
                            UIPasteboard.general.string = branch
                            T3HUD.show("Copied", systemImage: "doc.on.doc")
                        } label: {
                            Label("Copy Branch Name", systemImage: "doc.on.doc")
                        }
                    }
                } label: {
                    Label("More", systemImage: "ellipsis")
                }
                .disabled(runningAction != nil)
            }
        }
        .sheet(item: $commitAction) { action in
            if let status {
                SourceControlCommitSheet(action: action, status: status) { message in
                    Task { await perform(action, message: message) }
                }
            }
        }
        .confirmationDialog(
            "Publish to \(status?.branch ?? "the default branch")?",
            isPresented: Binding(
                get: { pendingDefaultBranchAction != nil },
                set: { if !$0 { pendingDefaultBranchAction = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingDefaultBranchAction
        ) { action in
            Button("Continue on This Branch", role: .destructive) {
                pendingDefaultBranchAction = nil
                proceed(action)
            }
            Button("Cancel", role: .cancel) { pendingDefaultBranchAction = nil }
        } message: { _ in
            Text(
                "This publishes straight to \(status?.branch ?? "the default branch"), "
                    + "which has no undo on the other side."
            )
        }
        .navigationDestination(item: $reviewFilePath) { path in
            if let reviewSelection {
                FeatureReviewView(
                    client: client,
                    threadID: threadID,
                    selection: reviewSelection,
                    initialFilePath: path
                )
            }
        }
        .task { await load() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, status != nil, !isLoading, runningAction == nil else { return }
            Task { await load() }
        }
    }

    private var runningStep: String? {
        guard let runningAction else { return nil }
        return progress?.stepText ?? runningAction.pendingStepText
    }

    // MARK: - List

    private func statusList(_ status: FeatureSourceControlStatus) -> some View {
        let actions = visibleActions(status)
        let conflicted = status.files.filter { $0.state == .conflicted }
        let changed = status.files.filter { $0.state != .conflicted }
        let isClean = status.files.isEmpty && !status.hasWorkingTreeChanges

        return List {
            if let failure {
                bannerSection {
                    T3ToolBanner(
                        tone: .error,
                        title: failure.title,
                        message: failure.message,
                        actionTitle: failure.nextStep.map { $0.title(for: status) },
                        action: failure.nextStep.map { next in { begin(next) } },
                        onDismiss: { self.failure = nil }
                    )
                }
            } else if let refreshError {
                bannerSection {
                    T3ToolBanner(
                        tone: .warning,
                        title: "Couldn't Refresh",
                        message: refreshError,
                        actionTitle: "Retry",
                        action: { Task { await load() } }
                    )
                }
            }

            if !conflicted.isEmpty {
                bannerSection {
                    T3ToolBanner(
                        tone: .warning,
                        title: conflicted.count == 1
                            ? "1 file has conflicts"
                            : "\(conflicted.count) files have conflicts",
                        message: "Resolve them before committing.",
                        actionTitle: isAskingAgent ? "Sending…" : "Ask Agent to Resolve",
                        action: { Task { await askAgentToResolve(conflicted) } }
                    )
                    .disabled(isAskingAgent)
                }
            }

            Section {
                branchRow(status)
                if let pullRequest = status.pullRequest {
                    pullRequestRow(pullRequest)
                }
            } footer: {
                if let footer = repositoryFooter(status, isClean: isClean) {
                    Text(footer)
                }
            }

            if !actions.isEmpty {
                Section {
                    ForEach(actions, id: \.self) { action in
                        actionRow(action, status: status)
                    }
                }
            }

            if !conflicted.isEmpty {
                Section("Conflicts") {
                    ForEach(conflicted) { fileRow($0) }
                }
            }

            if !changed.isEmpty {
                Section {
                    ForEach(changed) { fileRow($0) }
                } header: {
                    changesHeader(status)
                }
            }
        }
        .listStyle(.insetGrouped)
        .t3GroupedListBackground()
        .refreshable { await load() }
    }

    private func bannerSection(@ViewBuilder content: () -> some View) -> some View {
        Section {
            content()
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
        }
    }

    private func branchRow(_ status: FeatureSourceControlStatus) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(status.branch ?? "Detached HEAD")
                    .foregroundStyle(T3Colors.textPrimary)
                Text(SourceControlBranchSummary.detail(status))
                    .font(.footnote)
                    .foregroundStyle(T3Colors.textSecondary)
            }
        } icon: {
            Image(systemName: status.branch == nil ? "exclamationmark.triangle.fill" : "arrow.triangle.branch")
                .foregroundStyle(status.branch == nil ? T3Colors.warning : T3Colors.textSecondary)
        }
        .t3GroupedRow()
    }

    @ViewBuilder
    private func pullRequestRow(_ pullRequest: FeaturePullRequest) -> some View {
        let label = Label {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("#\(String(pullRequest.number)) \(pullRequest.title)")
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    Text(pullRequest.stateLabel)
                        .font(.footnote)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                Spacer(minLength: 0)
            }
        } icon: {
            Image(T3Symbol.pullRequest)
                .foregroundStyle(T3Colors.textSecondary)
        }
        NavigationLink {
            PullRequestDetailSheet(client: client, threadID: threadID, number: pullRequest.number)
        } label: {
            label
        }
        .t3GroupedRow()
    }

    private func actionRow(_ action: FeatureSourceControlAction, status: FeatureSourceControlStatus) -> some View {
        let isRunning = runningAction == action
        return Button {
            begin(action)
        } label: {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(action.title(for: status))
                        .foregroundStyle(isRunning ? T3Colors.textPrimary : T3Colors.accent)
                    if isRunning, let runningStep {
                        Text(runningStep)
                            .font(.footnote)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                }
            } icon: {
                if isRunning {
                    ProgressView()
                } else {
                    Image(symbol: action.icon)
                        .foregroundStyle(T3Colors.accent)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .disabled(runningAction != nil)
        .opacity(runningAction != nil && !isRunning ? 0.45 : 1)
        .t3GroupedRow()
    }

    private func changesHeader(_ status: FeatureSourceControlStatus) -> some View {
        HStack(spacing: 6) {
            Text("Changes")
            if status.insertions > 0 {
                Text("+\(status.insertions)")
                    .foregroundStyle(T3Colors.diffAddition)
            }
            if status.deletions > 0 {
                Text("−\(status.deletions)")
                    .foregroundStyle(T3Colors.diffDeletion)
            }
        }
        .monospacedDigit()
    }

    @ViewBuilder
    private func fileRow(_ file: FeatureSourceControlFile) -> some View {
        let row = SourceControlFileRow(file: file)
            .contextMenu {
                Button {
                    UIPasteboard.general.string = file.path
                    T3HUD.show("Copied", systemImage: "doc.on.doc")
                } label: {
                    Label("Copy Path", systemImage: "doc.on.doc")
                }
            }
        if reviewSelection != nil, file.state != .deleted {
            Button {
                openReview(at: file.path)
            } label: {
                HStack {
                    row
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(T3Colors.textTertiary)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .t3GroupedRow()
        } else {
            row.t3GroupedRow()
        }
    }

    private func repositoryFooter(_ status: FeatureSourceControlStatus, isClean: Bool) -> String? {
        var lines: [String] = []
        if isClean { lines.append("No uncommitted changes.") }
        if !status.hasPrimaryRemote { lines.append("Add a remote to push.") }
        return lines.isEmpty ? nil : lines.joined(separator: " ")
    }

    /// The available actions, plus the running one if a follow-up (Pull from a
    /// failure banner) started something the status did not list.
    private func visibleActions(_ status: FeatureSourceControlStatus) -> [FeatureSourceControlAction] {
        var actions = status.availableActions
        if let runningAction, !actions.contains(runningAction) {
            actions.append(runningAction)
        }
        return actions
    }

    // MARK: - Actions

    private func begin(_ action: FeatureSourceControlAction) {
        guard runningAction == nil else { return }
        if action.requiresDefaultBranchConfirmation(isDefaultBranch: status?.isDefaultRef ?? false) {
            pendingDefaultBranchAction = action
        } else {
            proceed(action)
        }
    }

    private func proceed(_ action: FeatureSourceControlAction) {
        if action.requiresMessage {
            commitAction = action
        } else {
            Task { await perform(action, message: nil) }
        }
    }

    private func openReview(at path: String) {
        // Source Control lists the working tree, so Review opens on it too
        // rather than on whichever checkpoint it showed last.
        reviewSelection?.selectSection(ReviewSectionID.workingTree.rawValue, for: threadID)
        reviewFilePath = path
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            status = try await client.sourceControlStatus(threadID: threadID)
            loadError = nil
            refreshError = nil
        } catch is CancellationError {
            return
        } catch {
            if status == nil {
                loadError = error.localizedDescription
            } else {
                refreshError = error.localizedDescription
            }
        }
    }

    private func perform(_ action: FeatureSourceControlAction, message: String?) async {
        guard runningAction == nil else { return }
        runningAction = action
        progress = nil
        failure = nil
        defer {
            runningAction = nil
            progress = nil
        }
        do {
            status = try await client.performSourceControlAction(
                threadID: threadID,
                action: action,
                message: message,
                onProgress: { progress = $0 }
            )
            refreshError = nil
            PlatformHapticEngine.shared.play(.success)
        } catch {
            failure = SourceControlFailure(action: action, message: error.localizedDescription)
            PlatformHapticEngine.shared.play(.error)
            await load()
        }
    }

    private func askAgentToResolve(_ files: [FeatureSourceControlFile]) async {
        isAskingAgent = true
        defer { isAskingAgent = false }
        let paths = files.map { "- `\($0.path)`" }.joined(separator: "\n")
        let prompt = """
        Resolve the merge conflicts in these files:
        \(paths)

        Keep the intent of both sides, remove every conflict marker, and make sure the project still builds.
        """
        do {
            try await client.sendMessage(threadID: threadID, text: prompt, selection: nil)
            T3HUD.show("Sent to Agent", systemImage: "paperplane.fill")
        } catch {
            PlatformHapticEngine.shared.play(.error)
            refreshError = error.localizedDescription
        }
    }
}

/// A changed file: its status letter, name, and the folder it lives in.
private struct SourceControlFileRow: View {
    let file: FeatureSourceControlFile

    @ScaledMetric(relativeTo: .footnote) private var letterWidth: CGFloat = 18

    var body: some View {
        HStack(spacing: 12) {
            if file.state == .conflicted {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(T3Colors.warning)
                    .frame(width: letterWidth)
            } else {
                Text(file.state.shortLabel)
                    .font(.footnote.monospaced().weight(.bold))
                    .foregroundStyle(file.state.color)
                    .frame(width: letterWidth)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(location)
                    .font(.footnote)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer(minLength: 8)
            if file.isStaged {
                Text("Staged")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(T3Colors.diffAddition)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(T3Colors.diffAddition.opacity(0.14), in: Capsule())
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var name: String {
        (file.path as NSString).lastPathComponent
    }

    private var location: String {
        if let previousPath = file.previousPath {
            return "Renamed from \(previousPath)"
        }
        if file.state == .untracked { return "Untracked" }
        let folder = (file.path as NSString).deletingLastPathComponent
        return folder.isEmpty ? "Workspace root" : folder
    }

    private var accessibilityText: String {
        var parts = [file.path, file.state.accessibilityName]
        if let previousPath = file.previousPath { parts.append("from \(previousPath)") }
        if file.isStaged { parts.append("staged") }
        return parts.joined(separator: ", ")
    }
}

/// The commit sheet is item-presented on the action that opened it.
extension FeatureSourceControlAction: Identifiable {
    public var id: String { rawValue }
}

private extension FeatureSourceControlAction {
    /// What the row says, naming the result where the status knows it.
    func title(for status: FeatureSourceControlStatus) -> String {
        switch self {
        case .commit: "Commit…"
        case .commitAndPush: "Commit & Push…"
        case .commitPushAndCreatePullRequest: "Commit, Push & Create PR…"
        case .push:
            if !status.hasUpstream {
                "Publish Branch"
            } else if status.aheadCount > 0 {
                "Push \(SourceControlBranchSummary.commits(status.aheadCount).capitalized)"
            } else {
                "Push"
            }
        case .pull:
            status.behindCount > 0
                ? "Pull \(SourceControlBranchSummary.commits(status.behindCount).capitalized)"
                : "Pull Latest"
        case .createPullRequest: "Create Pull Request"
        }
    }

    /// Shown in the running row until the server reports its first step.
    var pendingStepText: String {
        switch self {
        case .commit, .commitAndPush, .commitPushAndCreatePullRequest: "Committing…"
        case .push: "Pushing…"
        case .pull: "Pulling…"
        case .createPullRequest: "Creating pull request…"
        }
    }

    var icon: String {
        switch self {
        case .commit: "checkmark.circle"
        case .commitAndPush: "arrow.up.circle"
        case .commitPushAndCreatePullRequest, .createPullRequest: T3Symbol.pullRequest
        case .push: "arrow.up"
        case .pull: "arrow.down"
        }
    }
}

private extension FeaturePullRequest {
    var stateLabel: String {
        if isDraft == true { return "Draft" }
        return state.prefix(1).uppercased() + state.dropFirst()
    }
}

private extension FeatureSourceControlFileState {
    var shortLabel: String {
        switch self {
        case .added: "A"
        case .modified: "M"
        case .deleted: "D"
        case .renamed: "R"
        case .untracked: "?"
        case .conflicted: "!"
        }
    }

    /// Theme tokens, so the color-blind diff palette reads the same here as in
    /// Review.
    var color: Color {
        switch self {
        case .added: T3Colors.diffAddition
        case .modified: T3Colors.warning
        case .deleted: T3Colors.diffDeletion
        case .renamed: T3Colors.accent
        case .conflicted: T3Colors.warning
        case .untracked: T3Colors.textTertiary
        }
    }

    var accessibilityName: String {
        switch self {
        case .added: "added"
        case .modified: "modified"
        case .deleted: "deleted"
        case .renamed: "renamed"
        case .untracked: "untracked"
        case .conflicted: "has conflicts"
        }
    }
}
