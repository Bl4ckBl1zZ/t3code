import SwiftUI

/// One pull request a row's quick action acts on, and the access that runs it.
struct PullRequestQuickActionTarget {
    /// The row's identity: its busy state and the close prompt follow it.
    let id: String
    let number: Int
    let url: String
    let access: FeaturePullRequestAccess
}

/// Runs the one-tap actions a pull request row offers, wherever the row sits:
/// the pull request list, a thread's linked pull requests, Thread Details.
/// Close asks first, the way the detail screen does; the rest run at once,
/// one at a time per row. Attach `pullRequestQuickActionPrompts(_:)` to the
/// list so the close prompt and failures have somewhere to show.
@MainActor @Observable
final class PullRequestQuickActionRunner {
    /// Rows with a quick action on its way to the host.
    private(set) var busyIDs: Set<String> = []
    fileprivate var confirmingClose: PullRequestQuickActionTarget?
    fileprivate var failure: ThreadDetailsFailure?

    func isBusy(_ id: String) -> Bool { busyIDs.contains(id) }

    func trigger(_ action: NativePullRequestAction, _ target: PullRequestQuickActionTarget) {
        if action == .close { confirmingClose = target }
        else { Task { await perform(action, target) } }
    }

    /// Runs through the same access as the detail screen, so a list row hears
    /// sent, done and failed the same way. A merge reads the detail at the tap
    /// and refuses, before anything is sent, one this viewer cannot merge or
    /// one that sits in a stack; its method is the one the merge sheet would
    /// start on.
    func perform(_ action: NativePullRequestAction, _ target: PullRequestQuickActionTarget) async {
        guard !busyIDs.contains(target.id), let run = target.access.runAction else { return }
        busyIDs.insert(target.id)
        defer { busyIDs.remove(target.id) }
        var mergeMethod: String?
        do {
            if action == .merge {
                let detail = try await target.access.overview(target.number).detail
                if let refusal = PullRequestActionLogic.quickMergeRefusal(detail) {
                    return refuse(action, refusal)
                }
                // Nil when the server cannot read stacks.
                if try await target.access.stack(target.number) != nil {
                    return refuse(action, PullRequestActionLogic.stackedQuickMergeRefusal)
                }
                mergeMethod = PullRequestActionLogic.resolveMergeMethod(allowed: PullRequestActionLogic.mergeMethods(detail),
                    current: nil, projectDefault: target.access.mergeMethodDefault(), lastUsed: PullRequestMergeMethodMemory.lastUsed())
            }
        } catch {
            return refuse(action, error.localizedDescription)
        }
        do {
            try await run(target.number, target.url, .init(action: action.rawValue, mergeMethod: mergeMethod, updateMethod: nil))
            if action == .merge { T3HUD.show("Merged #\(target.number)", systemImage: "arrow.triangle.merge") }
            else { PlatformHapticEngine.shared.play(.success) }
        } catch {
            refuse(action, error.localizedDescription)
        }
    }

    private func refuse(_ action: NativePullRequestAction, _ message: String) {
        failure = ThreadDetailsFailure(title: action.failureTitle, message: message)
        PlatformHapticEngine.shared.play(.error)
    }
}

/// A row's quick actions as buttons, for its leading swipe or the top of its
/// menu. Close reads as destructive only in the menu: a destructive swipe
/// button removes the row before the host has answered.
struct PullRequestQuickActionButtons: View {
    enum Placement { case swipe, menu }

    let actions: [NativePullRequestAction]
    let placement: Placement
    let trigger: (NativePullRequestAction) -> Void

    var body: some View {
        ForEach(actions) { action in
            Button(Self.label(action), systemImage: action.systemImage,
                   role: placement == .menu && action == .close ? .destructive : nil) { trigger(action) }
                .tint(placement == .swipe ? Self.tint(action) : nil)
        }
    }

    private static func label(_ action: NativePullRequestAction) -> String {
        action == .close ? "Close" : action.primaryLabel
    }

    private static func tint(_ action: NativePullRequestAction) -> Color {
        switch action {
        case .merge: T3Colors.success
        case .ready: T3Colors.statusRunning
        case .close: T3Colors.danger
        default: T3Colors.textSecondary
        }
    }
}

extension View {
    /// The close confirmation and the failure alert a row's quick action can raise.
    func pullRequestQuickActionPrompts(_ runner: PullRequestQuickActionRunner) -> some View {
        confirmationDialog(
            "Close #\(runner.confirmingClose?.number ?? 0)?",
            isPresented: Binding(get: { runner.confirmingClose != nil }, set: { if !$0 { runner.confirmingClose = nil } }),
            titleVisibility: .visible,
            presenting: runner.confirmingClose
        ) { target in
            Button("Close Pull Request", role: .destructive) { Task { await runner.perform(.close, target) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text(NativePullRequestAction.close.explanation)
        }
        .alert(
            runner.failure?.title ?? "",
            isPresented: Binding(get: { runner.failure != nil }, set: { if !$0 { runner.failure = nil } }),
            presenting: runner.failure
        ) { _ in
            Button("OK") {}
        } message: { failure in
            Text(failure.message)
        }
    }
}

extension FeaturePullRequestAccess {
    /// Reaches a thread's linked pull request through its own project and
    /// repository where the client can, which a link from another repository
    /// needs; otherwise through the thread.
    init(link: FeatureLinkedPullRequest, client: any FeatureClient, threadID: String) {
        if let manager = client as? any FeatureProjectPullRequestManaging,
           let host = link.host ?? URL(string: link.url)?.host {
            self.init(manager: manager, scope: FeaturePullRequestProjectScope(projectID: link.projectID, host: host, repository: link.repository))
        } else {
            self.init(client: client, threadID: threadID)
        }
    }
}
