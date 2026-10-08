import Foundation

// What a send does while a turn runs. Ports web's `followUpBehavior` setting and
// `resolveComposerDispatchMode` (apps/web/src/components/chat/composerDispatch.ts):
// the default action is the user's preference, and the other one stays a
// long-press (or ⇧⌘↩) away.

/// The device-local default for a message sent while a turn runs. Web keeps the
/// same choice in its own client settings, so it is per device there too.
enum ComposerFollowUpBehavior: String, CaseIterable, Sendable {
    case queue
    case steer

    static let storageKey = "composerFollowUpBehavior"

    var title: String {
        switch self {
        case .queue: "Queue"
        case .steer: "Steer"
        }
    }
}

/// The run a send would steer, and how the provider takes a steer.
public struct FeatureSteerTarget: Equatable, Hashable, Sendable {
    public let runID: String
    /// The provider cannot steer a live turn, only interrupt and restart it
    /// with the new message.
    public let restartsTurn: Bool

    public init(runID: String, restartsTurn: Bool) {
        self.runID = runID
        self.restartsTurn = restartsTurn
    }
}

enum ComposerFollowUp {
    /// The steer the composer can offer now, or nil when a send can only queue.
    /// Same gate the queue strip's "Steer" uses: a running provider turn on a
    /// provider that says it can take one.
    static func steerTarget(
        queueState: ThreadQueueWorkflowState,
        capabilities: ThreadTurnCapabilities?
    ) -> FeatureSteerTarget? {
        guard queueState.canPromoteToSteer, let run = queueState.activeRun else { return nil }
        return FeatureSteerTarget(
            runID: run.id,
            restartsTurn: capabilities?.supportsActiveSteering != true
        )
    }

    /// What `message.dispatch` carries. A steer only goes out while its run is
    /// still the thread's active run; once it has ended, the message is an
    /// ordinary send, which the server starts or queues as it would any other.
    static func dispatchMode(
        steer: FeatureSteerTarget?,
        liveActiveRunID: String?
    ) -> MessageDispatchMode {
        guard let steer, steer.runID == liveActiveRunID else { return .startImmediately }
        return steer.restartsTurn
            ? .restartActive(runID: steer.runID)
            : .steerActive(runID: steer.runID)
    }

    /// Whether the composer's primary action steers. `alternate` is the
    /// long-press or ⇧⌘↩ choice, which picks the other action.
    static func steers(defaultSteers: Bool, alternate: Bool) -> Bool {
        defaultSteers != alternate
    }

    static func placeholder(isWorking: Bool, defaultSteers: Bool) -> String {
        guard isWorking else { return "Ask anything…" }
        return defaultSteers ? "Message to steer…" : "Message to queue…"
    }
}

/// The composer's steer affordance while a turn runs. Nil when nothing runs or
/// the provider cannot take a steer, and the send can only queue.
struct ComposerSteering {
    /// The user's default for a send while the turn runs.
    var defaultsToSteer: Bool
    var onSteer: () -> Void
}
