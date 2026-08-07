import SwiftUI

// The thread's queued-run workflow: what is running, what is waiting behind it,
// and whether the provider lets the user reorder or steer.
//
// Ports packages/client-runtime/src/state/threadWorkflows.ts and
// apps/mobile/src/features/threads/ThreadQueueControl.tsx.
//
// Queued runs are server state. A message sent with dispatchMode "queue" becomes
// a run in `queued` status on the thread, visible from every client — it is not
// the phone's `FeatureOutboxStore`, which holds submissions that have not
// reached a server at all. The two never show the same message.
//
// As elsewhere in this folder the inputs are narrowed value types, so the
// derivation stays testable without a projection. `Core` now models every column
// this reads (`run.queuePosition`, `run.userMessageId`, `run.activeAttemptId`,
// `providerTurn.runAttemptId`, `providerSession.capabilities`), so the `init(_:)`
// adapters below are lossless; a caller that builds the narrowed values by hand
// still degrades to read-only when it cannot prove a capability.

// MARK: - Narrowed inputs

public struct ThreadWorkflowRun: Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let ordinal: Int
    public let status: String
    /// Explicit queue order when the server assigned one; ordinal otherwise.
    public let queuePosition: Int?
    public let userMessageID: String?
    public let providerThreadID: String?
    public let activeAttemptID: String?

    public init(
        id: String,
        ordinal: Int,
        status: String,
        queuePosition: Int? = nil,
        userMessageID: String? = nil,
        providerThreadID: String? = nil,
        activeAttemptID: String? = nil
    ) {
        self.id = id
        self.ordinal = ordinal
        self.status = status
        self.queuePosition = queuePosition
        self.userMessageID = userMessageID
        self.providerThreadID = providerThreadID
        self.activeAttemptID = activeAttemptID
    }

    public init(_ run: OrchestrationV2Run) {
        self.init(
            id: run.id,
            ordinal: run.ordinal,
            status: run.status,
            queuePosition: run.queuePosition,
            userMessageID: run.userMessageId,
            providerThreadID: run.providerThreadId,
            activeAttemptID: run.activeAttemptId
        )
    }
}

public struct ThreadWorkflowProviderTurn: Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let runAttemptID: String?
    public let status: String

    public init(id: String, runAttemptID: String?, status: String) {
        self.id = id
        self.runAttemptID = runAttemptID
        self.status = status
    }

    public init(_ turn: OrchestrationV2ProviderTurn) {
        self.init(id: turn.id, runAttemptID: turn.runAttemptId, status: turn.status)
    }
}

public struct ThreadWorkflowProviderThread: Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let appThreadID: String?
    public let providerSessionID: String?

    public init(id: String, appThreadID: String?, providerSessionID: String?) {
        self.id = id
        self.appThreadID = appThreadID
        self.providerSessionID = providerSessionID
    }

    public init(_ providerThread: OrchestrationV2ProviderThread) {
        self.init(
            id: providerThread.id,
            appThreadID: providerThread.appThreadId,
            providerSessionID: providerThread.providerSessionId
        )
    }
}

/// The turn-shaped provider capabilities the queue reads. Absent means the
/// client has no capability evidence, which is treated as "not supported"
/// rather than guessed — offering a steer that the provider silently drops is
/// worse than not offering it.
public struct ThreadTurnCapabilities: Equatable, Hashable, Sendable {
    public let supportsActiveSteering: Bool
    public let supportsSteeringByInterruptRestart: Bool
    public let supportsQueuedMessages: Bool

    public init(
        supportsActiveSteering: Bool,
        supportsSteeringByInterruptRestart: Bool,
        supportsQueuedMessages: Bool
    ) {
        self.supportsActiveSteering = supportsActiveSteering
        self.supportsSteeringByInterruptRestart = supportsSteeringByInterruptRestart
        self.supportsQueuedMessages = supportsQueuedMessages
    }
}

public struct ThreadWorkflowSession: Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let status: String
    public let turns: ThreadTurnCapabilities?

    public init(id: String, status: String, turns: ThreadTurnCapabilities? = nil) {
        self.id = id
        self.status = status
        self.turns = turns
    }

    /// A session whose driver descriptor predates the capability block keeps
    /// `turns` nil, which reads as "no evidence" — the same as the absent
    /// descriptor it came from, and not as a denial.
    public init(_ session: OrchestrationV2ProviderSession) {
        self.init(
            id: session.id,
            status: session.status,
            turns: session.capabilities?.turns.map {
                ThreadTurnCapabilities(
                    supportsActiveSteering: $0.supportsActiveSteering,
                    supportsSteeringByInterruptRestart: $0.supportsSteeringByInterruptRestart,
                    supportsQueuedMessages: $0.supportsQueuedMessages
                )
            }
        )
    }
}

// MARK: - Derived state

public struct QueuedThreadRun: Equatable, Hashable, Sendable, Identifiable {
    public let run: ThreadWorkflowRun
    /// The queued message's text, or a placeholder when the message row is not
    /// in this projection window.
    public let text: String
    public let attachmentCount: Int

    public init(run: ThreadWorkflowRun, text: String, attachmentCount: Int = 0) {
        self.run = run
        self.text = text
        self.attachmentCount = attachmentCount
    }

    public var id: String { run.id }
}

public struct ThreadQueueWorkflowState: Equatable, Sendable {
    public let activeRun: ThreadWorkflowRun?
    public let queuedRuns: [QueuedThreadRun]
    public let canReorder: Bool
    public let canPromoteToSteer: Bool

    public init(
        activeRun: ThreadWorkflowRun?,
        queuedRuns: [QueuedThreadRun],
        canReorder: Bool,
        canPromoteToSteer: Bool
    ) {
        self.activeRun = activeRun
        self.queuedRuns = queuedRuns
        self.canReorder = canReorder
        self.canPromoteToSteer = canPromoteToSteer
    }

    public static let empty = ThreadQueueWorkflowState(
        activeRun: nil, queuedRuns: [], canReorder: false, canPromoteToSteer: false
    )
}

public enum QueueMoveDirection: Equatable, Sendable {
    case up
    case down
}

/// A `queued-run.reorder` command's arguments. `beforeRunID` nil means "place at
/// the end of the queue".
public struct QueueReorderTarget: Equatable, Sendable {
    public let runID: String
    public let beforeRunID: String?

    public init(runID: String, beforeRunID: String?) {
        self.runID = runID
        self.beforeRunID = beforeRunID
    }
}

public enum ThreadWorkflows {
    static let activeRunStatuses: Set<String> = ["preparing", "starting", "running", "waiting"]
    static let mergeBackRunStatuses: Set<String> = ["waiting", "completed"]
    static let mergeBackBlockingRunStatuses: Set<String> = ["preparing", "starting", "running"]

    public static func resolveActiveRun(runs: [ThreadWorkflowRun]) -> ThreadWorkflowRun? {
        runs.last { activeRunStatuses.contains($0.status) }
    }

    /// A successfully finished provider turn stays in `waiting` while its
    /// checkpoint is captured. Keep that newest turn available for merge-back
    /// instead of falling through to an older fully checkpointed run.
    public static func resolveLatestMergeBackRun(runs: [ThreadWorkflowRun]) -> ThreadWorkflowRun? {
        var latest: ThreadWorkflowRun?
        for run in runs where mergeBackRunStatuses.contains(run.status) {
            if latest == nil || run.ordinal > latest!.ordinal { latest = run }
        }
        guard let latest else { return nil }
        let hasNewerActiveRun = runs.contains {
            $0.ordinal > latest.ordinal && mergeBackBlockingRunStatuses.contains($0.status)
        }
        return hasNewerActiveRun ? nil : latest
    }

    public static func resolveProviderSession(
        appThreadID: String,
        threadActiveProviderThreadID: String?,
        runs: [ThreadWorkflowRun],
        providerThreads: [ThreadWorkflowProviderThread],
        providerSessions: [ThreadWorkflowSession]
    ) -> ThreadWorkflowSession? {
        let activeRun = resolveActiveRun(runs: runs)
        let providerThreadID = activeRun?.providerThreadID ?? threadActiveProviderThreadID
        let activeProviderThread = providerThreadID.flatMap { id in
            providerThreads.first { $0.id == id }
        }
        let attachedProviderThread =
            activeProviderThread
            ?? providerThreads.first {
                $0.appThreadID == appThreadID && $0.providerSessionID != nil
            }
        if let sessionID = attachedProviderThread?.providerSessionID {
            return providerSessions.first { $0.id == sessionID }
        }
        return providerSessions.last { $0.status != "stopped" && $0.status != "error" }
    }

    public static func canDetachProviderSession(_ session: ThreadWorkflowSession?) -> Bool {
        guard let session else { return false }
        return session.status != "stopped" && session.status != "error"
    }

    public static func deriveQueueWorkflowState(
        runs: [ThreadWorkflowRun],
        providerTurns: [ThreadWorkflowProviderTurn] = [],
        session: ThreadWorkflowSession? = nil,
        messageTexts: [String: String] = [:],
        messageAttachmentCounts: [String: Int] = [:]
    ) -> ThreadQueueWorkflowState {
        let activeRun = resolveActiveRun(runs: runs)
        let capabilities = session?.turns
        let hasSteerableProviderTurn: Bool
        if let activeRun, activeRun.status == "running", let attemptID = activeRun.activeAttemptID {
            hasSteerableProviderTurn = providerTurns.contains {
                $0.runAttemptID == attemptID && $0.status == "running"
            }
        } else {
            hasSteerableProviderTurn = false
        }

        let queuedRuns =
            runs
            .filter { $0.status == "queued" }
            .sorted { left, right in
                let leftPosition = left.queuePosition ?? left.ordinal
                let rightPosition = right.queuePosition ?? right.ordinal
                if leftPosition != rightPosition { return leftPosition < rightPosition }
                return left.ordinal < right.ordinal
            }
            .map { run -> QueuedThreadRun in
                let messageID = run.userMessageID
                return QueuedThreadRun(
                    run: run,
                    text: messageID.flatMap { messageTexts[$0] } ?? "Queued message",
                    attachmentCount: messageID.flatMap { messageAttachmentCounts[$0] } ?? 0
                )
            }

        return ThreadQueueWorkflowState(
            activeRun: activeRun,
            queuedRuns: queuedRuns,
            canReorder: capabilities?.supportsQueuedMessages == true,
            canPromoteToSteer: hasSteerableProviderTurn
                && (capabilities?.supportsActiveSteering == true
                    || capabilities?.supportsSteeringByInterruptRestart == true)
        )
    }

    /// The `queued-run.reorder` arguments for nudging one row.
    ///
    /// Reorder is expressed as "put this run before that one", so moving down
    /// targets the run two places along — the neighbour below has to end up
    /// above the moved run, which means anchoring on whatever follows it.
    /// Moving the last row down, or the first row up, has no target and is
    /// rejected rather than sent as a no-op.
    public static func reorderTarget(
        queuedRuns: [QueuedThreadRun],
        index: Int,
        direction: QueueMoveDirection
    ) -> QueueReorderTarget? {
        guard queuedRuns.indices.contains(index) else { return nil }
        let runID = queuedRuns[index].run.id
        switch direction {
        case .up:
            guard index > 0 else { return nil }
            return QueueReorderTarget(runID: runID, beforeRunID: queuedRuns[index - 1].run.id)
        case .down:
            guard index < queuedRuns.count - 1 else { return nil }
            let anchorIndex = index + 2
            let beforeRunID =
                queuedRuns.indices.contains(anchorIndex) ? queuedRuns[anchorIndex].run.id : nil
            return QueueReorderTarget(runID: runID, beforeRunID: beforeRunID)
        }
    }

    public static func canMove(
        queuedRuns: [QueuedThreadRun],
        index: Int,
        direction: QueueMoveDirection
    ) -> Bool {
        reorderTarget(queuedRuns: queuedRuns, index: index, direction: direction) != nil
    }
}

// MARK: - View

/// The queue readout above the composer: position, preview, reorder and steer.
///
/// Editing and deleting live in `QueuedMessageStripView`; this control is the
/// ordering surface, and both read the same `ThreadQueueWorkflowState`.
struct ThreadQueueControlView: View {
    let state: ThreadQueueWorkflowState
    let busyRunID: String?
    let onReorder: (QueueReorderTarget) -> Void
    let onPromoteToSteer: (_ queuedRunID: String, _ targetRunID: String) -> Void

    var body: some View {
        if !state.queuedRuns.isEmpty {
            VStack(spacing: 0) {
                header
                Divider().overlay(T3Colors.separator)
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(state.queuedRuns.enumerated()), id: \.element.id) {
                            index, queued in
                            row(queued, at: index)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .frame(maxHeight: 168)
                .scrollBounceBehavior(.basedOnSize)
            }
            .background(T3Colors.surface, in: shape)
            .overlay { shape.stroke(T3Colors.border, lineWidth: 1) }
            .clipShape(shape)
            .accessibilityIdentifier("thread-queue-control")
        }
    }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "list.number")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(T3Colors.textTertiary)
            Text("Queue")
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textPrimary)
            Spacer(minLength: 6)
            Text("\(state.queuedRuns.count)")
                .font(T3Typography.supporting)
                .monospacedDigit()
                .foregroundStyle(T3Colors.textTertiary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Queue, \(state.queuedRuns.count) waiting")
    }

    private func row(_ queued: QueuedThreadRun, at index: Int) -> some View {
        HStack(spacing: 4) {
            Text("\(index + 1)")
                .font(T3Typography.supporting)
                .monospacedDigit()
                .foregroundStyle(T3Colors.textTertiary)
                .frame(width: 20, alignment: .trailing)

            Text(queued.text)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)

            moveButton(at: index, direction: .up)
            moveButton(at: index, direction: .down)

            Button {
                guard let targetRunID = state.activeRun?.id else { return }
                onPromoteToSteer(queued.run.id, targetRunID)
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "arrow.turn.left.up")
                        .font(.system(size: 10, weight: .semibold))
                    Text("Steer")
                        .font(T3Typography.supporting)
                }
                .foregroundStyle(T3Colors.textPrimary)
                .padding(.horizontal, 8)
                .frame(minHeight: 30)
                .overlay {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .stroke(T3Colors.inputBorder, lineWidth: 1)
                }
            }
            .buttonStyle(.plain)
            .disabled(steerDisabled)
            .opacity(steerDisabled ? 0.3 : 1)
            .accessibilityLabel("Promote queued message to steer")
        }
        .padding(.horizontal, 8)
        .frame(minHeight: T3Metrics.minimumTapTarget)
    }

    private func moveButton(at index: Int, direction: QueueMoveDirection) -> some View {
        let target = ThreadWorkflows.reorderTarget(
            queuedRuns: state.queuedRuns, index: index, direction: direction
        )
        let disabled = busyRunID != nil || !state.canReorder || target == nil
        return Button {
            guard let target else { return }
            onReorder(target)
        } label: {
            Image(systemName: direction == .up ? "arrow.up" : "arrow.down")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(T3Colors.textTertiary)
                .frame(width: 34, height: 34)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.3 : 1)
        .accessibilityLabel(
            direction == .up ? "Move queued message up" : "Move queued message down"
        )
    }

    private var steerDisabled: Bool {
        busyRunID != nil || !state.canPromoteToSteer || state.activeRun == nil
    }
}
