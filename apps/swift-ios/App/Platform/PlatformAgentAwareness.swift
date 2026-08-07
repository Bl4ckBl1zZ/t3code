import ActivityKit
import Foundation
import WidgetKit

extension Notification.Name {
    static let platformLiveActivityChanged = Notification.Name(
        "T3PlatformLiveActivityChanged"
    )
}

/// Ported from the `AgentAwarenessOperation` literal union in
/// apps/mobile/src/features/agent-awareness/remoteRegistration.ts, narrowed to
/// the operations this client actually performs. Naming the operation is what
/// makes an ActivityKit failure diagnosable at all: every one of them surfaces
/// as the same opaque `ActivityKit` error otherwise.
enum PlatformAgentAwarenessOperation: String, Hashable, Sendable {
    case listActiveLiveActivities = "list-active-live-activities"
    case primeLiveActivity = "prime-live-activity"
    /// The foreground reconciliation: the app already holds the authoritative
    /// aggregate, so the card must not depend on a push round-trip — nor on its
    /// push token being healthy — to stop showing stale state.
    case repaintLiveActivity = "repaint-live-activity"
    case endLiveActivity = "end-live-activity"
    case readLiveActivityPushToken = "read-live-activity-push-token"
    case registerLiveActivityPushToken = "register-live-activity-push-token"
}

struct PlatformAgentAwarenessOperationError: LocalizedError {
    let operation: PlatformAgentAwarenessOperation
    let underlying: Error?

    init(operation: PlatformAgentAwarenessOperation, underlying: Error? = nil) {
        self.operation = operation
        self.underlying = underlying
    }

    var errorDescription: String? {
        "Agent awareness operation \(operation.rawValue) failed."
    }
}

/// When the lock-screen card was last armed or primed locally.
///
/// A just-armed card may see an empty relay aggregate before the environment's
/// first publish lands; ending it in that window would kill the card the user
/// just created. Mirrors the relay's freshly-armed grace.
@MainActor
enum PlatformLiveActivityArming {
    nonisolated static let gracePeriod: TimeInterval = 2 * 60

    private(set) static var armedAt: Date?

    static func markArmed(at date: Date = .now) {
        armedAt = date
    }

    /// The card is gone (ended, or never existed), so the next empty aggregate
    /// has nothing to protect.
    static func forget() {
        armedAt = nil
    }

    /// An aggregate with nothing active normally ends the card. Within the
    /// grace it must not: the relay simply has not published this device's first
    /// row yet.
    nonisolated static func shouldEndForEmptyAggregate(
        armedAt: Date?,
        now: Date,
        gracePeriod: TimeInterval = PlatformLiveActivityArming.gracePeriod
    ) -> Bool {
        guard let armedAt else { return true }
        return now.timeIntervalSince(armedAt) >= gracePeriod
    }
}

enum PlatformAgentAwarenessProjection {
    static let terminalVisibilityWindow: TimeInterval = 15 * 60
    static let maximumRows = 5

    static func aggregate(
        snapshot: FeatureSnapshot,
        now: Date = .now
    ) -> T3RelayAgentActivityAggregateState {
        // Defensive against duplicate project IDs in aggregate snapshots; this
        // runs on every snapshot revision, so it must never trap.
        let projects = snapshot.projects.reduce(into: [String: FeatureProject]()) {
            $0[$1.id] = $0[$1.id] ?? $1
        }
        let eligible = snapshot.threads.filter { thread in
            guard !thread.isArchived else { return false }
            if isActive(thread.state) { return true }
            guard thread.state == .completed || thread.state == .failed else { return false }
            return now.timeIntervalSince(thread.updatedAt) <= terminalVisibilityWindow
        }
        let rows = eligible.compactMap { thread -> T3RelayAgentActivityAggregateRow? in
            guard let project = projects[thread.projectID] else { return nil }
            let environmentID = thread.environmentID ?? project.environmentID
            let threadID = thread.wireID ?? thread.id
            let phase = phase(for: thread.state)
            return T3RelayAgentActivityAggregateRow(
                environmentId: environmentID,
                threadId: threadID,
                projectTitle: project.name,
                threadTitle: thread.title,
                modelTitle: modelTitle(
                    for: thread,
                    environmentID: environmentID,
                    snapshot: snapshot
                ),
                phase: phase,
                status: status(for: thread.state),
                updatedAt: thread.updatedAt.ISO8601Format(),
                deepLink: PlatformRoute.thread(
                    environmentID: environmentID,
                    threadID: threadID
                ).url?.absoluteString ?? "/"
            )
        }
        .sorted { left, right in
            let leftPriority = priority(left.phase)
            let rightPriority = priority(right.phase)
            if leftPriority != rightPriority { return leftPriority < rightPriority }
            return left.updatedAt > right.updatedAt
        }
        let visibleRows = Array(rows.prefix(maximumRows))
        let activeCount = eligible.count { isActive($0.state) }
        let attentionCount = eligible.count {
            $0.state == .waitingForApproval || $0.state == .waitingForInput
        }
        let subtitle: String
        if attentionCount > 0 {
            subtitle = attentionCount == 1
                ? "1 task needs attention"
                : "\(attentionCount) tasks need attention"
        } else if activeCount > 0 {
            subtitle = activeCount == 1 ? "1 active task" : "\(activeCount) active tasks"
        } else if visibleRows.contains(where: { $0.phase == .failed }) {
            subtitle = "Agent work failed"
        } else if !visibleRows.isEmpty {
            subtitle = "Agent work completed"
        } else {
            subtitle = "Ready for a task"
        }
        return T3RelayAgentActivityAggregateState(
            title: "T3 Code",
            subtitle: subtitle,
            activeCount: activeCount,
            updatedAt: now.ISO8601Format(),
            activities: visibleRows
        )
    }

    static func widgetSnapshot(
        snapshot: FeatureSnapshot,
        now: Date = .now
    ) -> T3TaskWidgetSnapshot {
        let aggregate = aggregate(snapshot: snapshot, now: now)
        return T3TaskWidgetSnapshot(
            updatedAt: aggregate.updatedAt,
            tasks: aggregate.activities
        )
    }

    private static func isActive(_ state: FeatureThreadState) -> Bool {
        switch state {
        case .queued, .working, .waitingForApproval, .waitingForInput:
            true
        case .idle, .failed, .completed:
            false
        }
    }

    private static func phase(for state: FeatureThreadState) -> T3AgentActivityPhase {
        switch state {
        case .queued: .starting
        case .working: .running
        case .waitingForApproval: .waitingForApproval
        case .waitingForInput: .waitingForInput
        case .failed: .failed
        case .completed: .completed
        case .idle: .stale
        }
    }

    private static func status(for state: FeatureThreadState) -> String {
        switch state {
        case .queued: "Starting"
        case .working: "Working"
        case .waitingForApproval: "Approval"
        case .waitingForInput: "Input"
        case .failed: "Failed"
        case .completed: "Done"
        case .idle: "Idle"
        }
    }

    private static func priority(_ phase: T3AgentActivityPhase) -> Int {
        switch phase {
        case .waitingForApproval, .waitingForInput: 0
        case .failed: 1
        case .starting, .running: 2
        case .completed, .stale: 3
        }
    }

    private static func modelTitle(
        for thread: FeatureThread,
        environmentID: String,
        snapshot: FeatureSnapshot
    ) -> String {
        let providers = snapshot.providersByEnvironment?[environmentID] ?? snapshot.providers
        let provider = thread.providerID.flatMap { providerID in
            providers.first { $0.id == providerID }
        }
        if let modelID = thread.modelID,
           let model = provider?.models.first(where: { $0.id == modelID })
        {
            return model.name
        }
        return thread.modelID ?? provider?.name ?? thread.providerName ?? ""
    }
}

@MainActor
final class PlatformAgentAwarenessCoordinator {
    static let shared = PlatformAgentAwarenessCoordinator()

    private let updateLiveActivity: @MainActor (
        T3RelayAgentActivityAggregateState,
        Bool,
        Date
    ) async throws -> Void
    private let endLiveActivities: @MainActor () async -> Void

    private struct Signature: Equatable {
        let activeCount: Int
        let subtitle: String
        let rows: [T3RelayAgentActivityAggregateRow]
        let enabled: Bool
    }

    private struct Synchronization {
        let signature: Signature
        let aggregate: T3RelayAgentActivityAggregateState
        let enabled: Bool
        var now: Date
        var operation: PlatformAgentAwarenessOperation = .primeLiveActivity
    }

    private var activityUpdateTask: Task<Void, Never>?
    private var lastSignature: Signature?
    private var inFlightSignature: Signature?
    private var synchronizationGeneration = 0
    /// The most recent authoritative projection, kept so a foreground repaint
    /// has something to re-apply without waiting for the next snapshot revision.
    private var lastSynchronization: Synchronization?
    /// Surfaced for diagnostics and tests; ActivityKit failures are otherwise
    /// invisible because every path here deliberately swallows them.
    private(set) var lastOperationError: PlatformAgentAwarenessOperationError?

    init(
        updateLiveActivity: @escaping @MainActor (
            T3RelayAgentActivityAggregateState,
            Bool,
            Date
        ) async throws -> Void = { aggregate, enabled, now in
            try await PlatformAgentAwarenessCoordinator.synchronizeLiveActivity(
                aggregate: aggregate,
                enabled: enabled,
                now: now
            )
        },
        endLiveActivities: @escaping @MainActor () async -> Void = {
            await PlatformAgentAwarenessCoordinator.endAllLiveActivities()
        }
    ) {
        self.updateLiveActivity = updateLiveActivity
        self.endLiveActivities = endLiveActivities
    }

    func synchronize(snapshot: FeatureSnapshot, liveActivitiesEnabled: Bool) {
        let now = Date.now
        let aggregate = PlatformAgentAwarenessProjection.aggregate(
            snapshot: snapshot,
            now: now
        )
        let signature = Signature(
            activeCount: aggregate.activeCount,
            subtitle: aggregate.subtitle,
            rows: aggregate.activities,
            enabled: liveActivitiesEnabled
        )
        let synchronization = Synchronization(
            signature: signature,
            aggregate: aggregate,
            enabled: liveActivitiesEnabled,
            now: now
        )
        lastSynchronization = synchronization
        if signature == lastSignature {
            if inFlightSignature != nil {
                activityUpdateTask?.cancel()
                synchronizationGeneration &+= 1
                inFlightSignature = nil
                activityUpdateTask = nil
            }
            return
        }
        guard signature != inFlightSignature else { return }

        let widgetSnapshot = T3TaskWidgetSnapshot(
            updatedAt: aggregate.updatedAt,
            tasks: aggregate.activities
        )
        try? T3TaskWidgetSnapshotStore.save(widgetSnapshot)
        WidgetCenter.shared.reloadTimelines(ofKind: "T3RecentTasksWidget")

        schedule(synchronization)
    }

    /// Re-applies the last authoritative projection to the card.
    ///
    /// Content normally arrives via APNs, but a foregrounded app already holds
    /// the aggregate, so the card must not depend on a push round-trip — nor on
    /// its push token being healthy — to stop showing stale state. Deliberately
    /// bypasses the signature dedupe: repainting an *unchanged* aggregate is the
    /// entire point, and that is exactly what `synchronize` skips.
    func repaintLiveActivity() {
        guard var synchronization = lastSynchronization else { return }
        synchronization.operation = .repaintLiveActivity
        // A fresh clock, so the repainted content carries a live stale date
        // rather than the one the original projection was scheduled with.
        synchronization.now = .now
        lastSignature = nil
        schedule(synchronization)
    }

    /// Account sign-out invalidates the cached account-scoped projection before
    /// removing its activity. Only a later snapshot may publish new content.
    func resetAndResynchronizeLiveActivity() {
        activityUpdateTask?.cancel()
        synchronizationGeneration &+= 1
        let generation = synchronizationGeneration
        lastSignature = nil
        inFlightSignature = nil
        lastSynchronization = nil
        PlatformLiveActivityArming.forget()
        try? T3TaskWidgetSnapshotStore.save(.empty)
        WidgetCenter.shared.reloadTimelines(ofKind: "T3RecentTasksWidget")
        activityUpdateTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await endLiveActivities()
            guard synchronizationGeneration == generation else { return }
            activityUpdateTask = nil
        }
    }

    private func schedule(_ synchronization: Synchronization) {
        activityUpdateTask?.cancel()
        synchronizationGeneration &+= 1
        let generation = synchronizationGeneration
        inFlightSignature = synchronization.signature
        activityUpdateTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await updateLiveActivity(
                    synchronization.aggregate,
                    synchronization.enabled,
                    synchronization.now
                )
                try Task.checkCancellation()
                guard synchronizationGeneration == generation,
                      inFlightSignature == synchronization.signature else { return }
                lastSignature = synchronization.signature
                inFlightSignature = nil
                activityUpdateTask = nil
                lastOperationError = nil
            } catch {
                guard synchronizationGeneration == generation,
                      inFlightSignature == synchronization.signature else { return }
                // Keep the completed signature unchanged so the next identical
                // snapshot retries a failed or cancelled ActivityKit operation.
                inFlightSignature = nil
                activityUpdateTask = nil
                if !(error is CancellationError) {
                    lastOperationError = PlatformAgentAwarenessOperationError(
                        operation: synchronization.operation,
                        underlying: error
                    )
                }
            }
        }
    }

    private static func synchronizeLiveActivity(
        aggregate: T3RelayAgentActivityAggregateState,
        enabled: Bool,
        now: Date
    ) async throws {
        try Task.checkCancellation()
        let activities = Activity<LiveActivityAttributes>.activities

        guard enabled, ActivityAuthorizationInfo().areActivitiesEnabled else {
            for activity in activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
            PlatformLiveActivityArming.forget()
            try Task.checkCancellation()
            notifyActivityChanged()
            return
        }

        let state = try LiveActivityAttributes.ContentState(aggregate: aggregate)
        let content = ActivityContent(
            state: state,
            staleDate: now.addingTimeInterval(10 * 60)
        )

        if aggregate.activeCount == 0 {
            guard PlatformLiveActivityArming.shouldEndForEmptyAggregate(
                armedAt: PlatformLiveActivityArming.armedAt,
                now: now
            ) else {
                // Freshly armed: the projection has nothing active yet only
                // because the environment's first publish has not landed.
                // Repaint rather than killing the card the user just created.
                for activity in activities {
                    await activity.update(content)
                }
                try Task.checkCancellation()
                notifyActivityChanged()
                return
            }
            for activity in activities {
                await activity.end(
                    content,
                    dismissalPolicy: .after(now.addingTimeInterval(5 * 60))
                )
            }
            PlatformLiveActivityArming.forget()
            try Task.checkCancellation()
            notifyActivityChanged()
            return
        }

        if let primary = activities.first {
            await primary.update(content)
            // The relay tracks exactly one card per device; if concurrent
            // arming ever produced extras, end them so only one keeps
            // receiving updates.
            for duplicate in activities.dropFirst() {
                await duplicate.end(nil, dismissalPolicy: .immediate)
            }
        } else {
            _ = try Activity.request(
                attributes: LiveActivityAttributes(),
                content: content,
                pushType: .token
            )
            PlatformLiveActivityArming.markArmed(at: now)
        }
        try Task.checkCancellation()
        notifyActivityChanged()
    }

    private static func endAllLiveActivities() async {
        for activity in Activity<LiveActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        PlatformLiveActivityArming.forget()
        notifyActivityChanged()
    }

    private static func notifyActivityChanged() {
        NotificationCenter.default.post(name: .platformLiveActivityChanged, object: nil)
    }
}
