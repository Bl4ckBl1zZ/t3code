import Observation
import SwiftUI

/// The transcript's per-message state that must outlive recycled cells: each
/// message's resolved meta and whether its long body is expanded.
///
/// One observable row per message, so a change re-renders only that message.
/// Owned by the thread screen and handed to the transcript coordinator, which
/// applies each detail revision and injects the store into every cell.
@MainActor @Observable
final class ThreadMessageActionsStore {
    @MainActor @Observable
    final class Row {
        var meta = ThreadMessageMeta()
        var isExpanded = false
    }

    struct Handlers {
        var restore: (CheckpointRestoreRequest) -> Void = { _ in }
        /// Dispatches the fork and returns the new thread's feature-scoped id.
        var fork: (ThreadMessageForkPoint) async throws -> String = { _ in throw FeatureCapabilityUnavailable("Forking") }
        var isThreadReady: (String) -> Bool = { _ in false }
        var openThread: (String) -> Void = { _ in }
    }

    struct Failure: Identifiable, Equatable {
        let id = UUID()
        let title: String
        let message: String
    }

    /// A turn is running or queued: restoring would race the agent's writes.
    private(set) var isWorking = false
    /// The thread's environment is connected. Rows read it only when they
    /// offer an action, so a reconnect re-renders just those.
    var isReachable = true
    private(set) var forkingMessageID: String?
    var failure: Failure?

    @ObservationIgnored var handlers = Handlers()
    /// Set by the transcript: runs `change` while keeping the message's top
    /// where the reader left it (`collapsing` pulls it back into view).
    @ObservationIgnored var keepTop: ((_ messageID: String, _ collapsing: Bool, _ change: () -> Void) -> Void)?
    @ObservationIgnored private var rows: [String: Row] = [:]
    @ObservationIgnored private var threadID: String?
    @ObservationIgnored private var timelineItems: [OrchestrationV2ProjectedTurnItem] = []
    @ObservationIgnored private var checkpoints: [OrchestrationV2Checkpoint] = []

    func row(_ messageID: String) -> Row {
        if let row = rows[messageID] { return row }
        let row = Row()
        rows[messageID] = row
        return row
    }

    /// Writes only what changed, so a streaming revision that leaves every
    /// message's meta alone re-renders nothing.
    func apply(_ detail: FeatureThreadDetail, now: Date = .now) {
        if threadID != detail.thread.id {
            threadID = detail.thread.id
            rows = [:]
        }
        timelineItems = detail.timelineItems
        checkpoints = detail.checkpoints
        let working = detail.thread.state == .working || detail.thread.state == .queued
        if isWorking != working { isWorking = working }
        let metas = ThreadMessageMetaResolver.resolve(detail, now: now)
        for (id, row) in rows where metas[id] == nil && row.meta != ThreadMessageMeta() {
            row.meta = ThreadMessageMeta()
        }
        for (id, meta) in metas {
            let row = row(id)
            if row.meta != meta { row.meta = meta }
        }
    }

    func toggleExpansion(_ messageID: String) {
        let row = row(messageID)
        let collapsing = row.isExpanded
        if let keepTop {
            keepTop(messageID, collapsing) { row.isExpanded.toggle() }
        } else {
            row.isExpanded.toggle()
        }
    }

    func restore(_ point: ThreadMessageRestorePoint) {
        handlers.restore(.beforeMessage(point, timelineItems: timelineItems, checkpoints: checkpoints))
    }

    func fork(_ point: ThreadMessageForkPoint) {
        guard forkingMessageID == nil else { return }
        forkingMessageID = point.messageID
        let handlers = handlers
        Task { @MainActor in
            defer { forkingMessageID = nil }
            do {
                let threadID = try await handlers.fork(point)
                // Accepted is not navigable: the shell has to reach this
                // device first, or the new screen opens on nothing.
                let ready = await ThreadForkNavigation.waitForThreadShellReady(timeout: .seconds(5)) {
                    handlers.isThreadReady(threadID)
                }
                if ready {
                    PlatformHapticEngine.shared.play(.success)
                    handlers.openThread(threadID)
                } else {
                    failure = Failure(
                        title: "Fork Created",
                        message: "The fork was created, but it hasn’t reached this device yet. Reconnect and open it from the thread list."
                    )
                }
            } catch {
                failure = Failure(title: "Couldn’t Fork", message: error.localizedDescription)
            }
        }
    }
}

private struct ThreadMessageActionsKey: EnvironmentKey {
    static let defaultValue: ThreadMessageActionsStore? = nil
}

extension EnvironmentValues {
    var threadMessageActions: ThreadMessageActionsStore? {
        get { self[ThreadMessageActionsKey.self] }
        set { self[ThreadMessageActionsKey.self] = newValue }
    }
}

extension View {
    /// Connects the store to the screen that owns it: what restore and fork do,
    /// whether the environment is reachable, and the fork failure alert.
    func threadMessageActions(
        _ store: ThreadMessageActionsStore,
        threadID: String,
        isReachable: Bool,
        handlers: @escaping () -> ThreadMessageActionsStore.Handlers
    ) -> some View {
        onChange(of: threadID, initial: true) { store.handlers = handlers() }
            .onChange(of: isReachable, initial: true) { store.isReachable = isReachable }
            .alert(
                store.failure?.title ?? "",
                isPresented: Binding(get: { store.failure != nil }, set: { if !$0 { store.failure = nil } })
            ) {
                Button("OK") { store.failure = nil }
            } message: {
                Text(store.failure?.message ?? "")
            }
    }
}
