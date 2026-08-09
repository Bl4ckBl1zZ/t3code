import Foundation

/// Holds the Hermes inbox for every environment while Settings is open.
///
/// Owned one level above the runs screen so the badge on the Settings row and
/// the list itself read the same subscription. Subscribing twice would open two
/// gateway streams per environment and let the badge and the list disagree
/// about what is unread.
@MainActor
@Observable
public final class HermesInboxStore {
    public private(set) var inboxes: [String: FeatureHermesInbox] = [:]
    public private(set) var failures: [String: String] = [:]
    /// True until every environment has either delivered a first snapshot or
    /// failed, so the screen can tell "still connecting" from "nothing ran".
    public private(set) var isLoading = true
    public var actionFailure: String?

    private var busyIDs: Set<String> = []
    /// Environments that have not yet produced a first snapshot or a failure.
    private var pendingFirstResult: Set<String> = []
    private let retryDelay: Duration
    private let maxRetries: Int

    /// `maxRetries` bounds the reconnect loop so an environment that is simply
    /// down leaves its failure on screen instead of retrying for as long as the
    /// sheet stays open. Closing and reopening Settings tries again.
    public init(retryDelay: Duration = .seconds(5), maxRetries: Int = 3) {
        self.retryDelay = retryDelay
        self.maxRetries = maxRetries
    }

    public var totalUnreadCount: Int {
        inboxes.values.reduce(0) { $0 + $1.unreadCount }
    }

    public var totalDeadLetterCount: Int {
        inboxes.values.reduce(0) { $0 + $1.deadLetterCount }
    }

    public func inbox(for environmentID: String) -> FeatureHermesInbox {
        inboxes[environmentID] ?? .empty
    }

    public func isBusy(_ notificationID: String) -> Bool {
        busyIDs.contains(notificationID)
    }

    /// Runs for as long as the caller's task lives, one child per environment.
    /// One unreachable environment records its own failure rather than blanking
    /// the others.
    public func observe(
        environments: [FeatureEnvironment],
        manager: any FeatureHermesInboxManaging
    ) async {
        guard !environments.isEmpty else {
            isLoading = false
            return
        }
        pendingFirstResult = Set(environments.map(\.id))
        isLoading = true
        await withTaskGroup(of: Void.self) { group in
            for environment in environments {
                group.addTask { @MainActor in
                    await self.follow(environmentID: environment.id, manager: manager)
                }
            }
        }
    }

    /// Reconnects after the stream ends, because a settings sheet can outlive a
    /// websocket blip and a badge that silently stopped updating is worse than
    /// one that is briefly stale.
    private func follow(
        environmentID: String,
        manager: any FeatureHermesInboxManaging
    ) async {
        var attemptsLeft = maxRetries
        while !Task.isCancelled {
            do {
                for try await inbox in await manager.hermesInboxUpdates(environmentID: environmentID) {
                    inboxes[environmentID] = inbox
                    failures[environmentID] = nil
                    // A stream that delivered is worth reconnecting for again,
                    // however long it had been running.
                    attemptsLeft = maxRetries
                    settleLoading(environmentID)
                }
                // A stream that finishes without error is a client that cannot
                // answer for this environment; retrying it would spin.
                settleLoading(environmentID)
                return
            } catch {
                if Task.isCancelled { return }
                failures[environmentID] = error.localizedDescription
                settleLoading(environmentID)
            }
            attemptsLeft -= 1
            guard attemptsLeft > 0 else { return }
            try? await Task.sleep(for: retryDelay)
        }
    }

    /// The spinner clears only once every environment has answered one way or
    /// the other. Clearing on the first one would flash "nothing has run" while
    /// a slower environment was still connecting.
    private func settleLoading(_ environmentID: String) {
        pendingFirstResult.remove(environmentID)
        if pendingFirstResult.isEmpty { isLoading = false }
    }

    /// Applies the server's post-change snapshot rather than editing rows in
    /// place, so the unread count and the row statuses can never drift apart.
    public func mark(
        environmentID: String,
        ids: [String],
        status: FeatureHermesRunStatus,
        manager: any FeatureHermesInboxManaging
    ) async {
        let pending = ids.filter { !busyIDs.contains($0) }
        guard !pending.isEmpty else { return }
        busyIDs.formUnion(pending)
        defer { busyIDs.subtract(pending) }
        do {
            inboxes[environmentID] = try await manager.markHermesRuns(
                environmentID: environmentID,
                ids: pending,
                status: status
            )
        } catch {
            actionFailure = error.localizedDescription
        }
    }
}
