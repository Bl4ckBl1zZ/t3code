import Foundation

// Presentation for the turn items that render as first-class timeline rows
// rather than work-log entries. Ported from apps/mobile/src/lib/threadLifecycle.ts
// so both clients divide the timeline the same way; checkpoints deliberately
// stay in the work log in both.

/// The subset of a run that handoff rows read to recover models.
public struct LifecycleTimelineRun: Equatable, Sendable {
    public let id: String
    public let ordinal: Int
    public let providerInstanceID: String
    public let model: String

    public init(id: String, ordinal: Int, providerInstanceID: String, model: String) {
        self.id = id
        self.ordinal = ordinal
        self.providerInstanceID = providerInstanceID
        self.model = model
    }
}

public enum LifecyclePresentation: Equatable, Sendable {
    case divider(Divider)
    case relatedThread(RelatedThread)

    public struct Divider: Equatable, Sendable {
        public enum Tone: Equatable, Sendable { case neutral, danger }
        /// Detail on its own line under the label. Handoffs need it; the
        /// endpoint list is too long to read inline.
        public enum Layout: Equatable, Sendable { case inline, stacked }

        public let label: String
        public let detail: String?
        public let tone: Tone
        public let symbol: String
        public let layout: Layout
        /// In-flight system work, e.g. a handoff summary still being generated.
        public let busy: Bool
        public let actionLabel: String?
        public let openThreadID: String?
    }

    public struct RelatedThread: Equatable, Sendable {
        public enum BadgeTone: Equatable, Sendable { case neutral, success, danger }
        public enum OrbState: Equatable, Sendable { case active, done, failed }

        public let symbol: String
        public let title: String
        public let detail: String?
        public let badge: String
        public let badgeTone: BadgeTone
        public let threadID: String?
        /// Stable per-agent seed; present means the card renders an orb.
        public let orbSeed: String?
        public let orbState: OrbState?
    }
}

public enum ThreadLifecycle {
    /// Turn items that become dividers or related-thread cards.
    static let lifecycleTypes: Set<String> = [
        "run_interrupt_request",
        "run_interrupt_result",
        "checkpoint_rollback",
        "compaction",
        "handoff",
        "fork",
        "subagent",
        "thread_created",
    ]

    public static func isLifecycleTimelineItem(_ item: OrchestrationV2TurnItem) -> Bool {
        lifecycleTypes.contains(item.type)
    }

    /// A handoff streams in non-terminal while the orchestrator generates the
    /// summary for the target model, which can be an AI call.
    private static func isHandoffInFlight(_ status: OrchestrationV2TurnItemStatus) -> Bool {
        switch status {
        case .pending, .running, .waiting: true
        default: false
        }
    }

    static func rollbackDetail(rolledBackRunCount: Int, restoredFileCount: Int) -> String? {
        var parts: [String] = []
        if rolledBackRunCount > 0 {
            parts.append("\(rolledBackRunCount) \(rolledBackRunCount == 1 ? "turn" : "turns")")
        }
        if restoredFileCount > 0 {
            parts.append(
                "\(restoredFileCount) \(restoredFileCount == 1 ? "file" : "files") restored"
            )
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func endpointLabel(instanceID: String, model: String?) -> String {
        guard let model, !model.isEmpty else { return instanceID }
        return model
    }

    /// Newest run on an instance strictly before `beforeOrdinal`. Handoff items
    /// persisted before models were stamped only carry instance ids, so the
    /// origin model is recovered from the run history.
    private static func latestRunModelBefore(
        _ runs: [LifecycleTimelineRun],
        instanceID: String,
        beforeOrdinal: Int?
    ) -> String? {
        var best: LifecycleTimelineRun?
        for run in runs where run.providerInstanceID == instanceID {
            if let beforeOrdinal, run.ordinal >= beforeOrdinal { continue }
            if best == nil || run.ordinal > best!.ordinal { best = run }
        }
        return best?.model
    }

    private static func subagentOrbState(
        _ status: OrchestrationV2TurnItemStatus
    ) -> LifecyclePresentation.RelatedThread.OrbState {
        if status == .failed { return .failed }
        return status.isTerminal ? .done : .active
    }

    private static func subagentBadgeTone(
        _ status: OrchestrationV2TurnItemStatus
    ) -> LifecyclePresentation.RelatedThread.BadgeTone {
        switch status {
        case .completed: .success
        case .failed: .danger
        default: .neutral
        }
    }

    public static func resolvePresentation(
        _ item: OrchestrationV2TurnItem,
        runs: [LifecycleTimelineRun] = []
    ) -> LifecyclePresentation? {
        switch item.payload {
        case let .runInterruptRequest(message):
            return .divider(
                .init(
                    label: "Interrupt requested",
                    detail: message.isEmpty ? nil : message,
                    tone: .danger,
                    symbol: "stop.fill",
                    layout: .inline,
                    busy: false,
                    actionLabel: nil,
                    openThreadID: nil
                )
            )

        case let .runInterruptResult(message):
            return .divider(
                .init(
                    label: "Run interrupted",
                    detail: message.isEmpty ? nil : message,
                    tone: .danger,
                    symbol: "xmark",
                    layout: .inline,
                    busy: false,
                    actionLabel: nil,
                    openThreadID: nil
                )
            )

        case let .checkpointRollback(_, _, restoredFileCount, rolledBackRunCount):
            return .divider(
                .init(
                    label: "Rolled back",
                    detail: rollbackDetail(
                        rolledBackRunCount: rolledBackRunCount,
                        restoredFileCount: restoredFileCount
                    ),
                    tone: .neutral,
                    symbol: "arrow.uturn.backward",
                    layout: .inline,
                    busy: false,
                    actionLabel: nil,
                    openThreadID: nil
                )
            )

        case let .compaction(_, summary, beforeTokenCount, afterTokenCount):
            let tokenDetail: String? =
                (beforeTokenCount == nil && afterTokenCount == nil)
                ? nil
                : "\(beforeTokenCount.map(String.init) ?? "?") → \(afterTokenCount.map(String.init) ?? "?") tokens"
            return .divider(
                .init(
                    label: "Chat compacted",
                    detail: summary ?? tokenDetail,
                    tone: .neutral,
                    symbol: "minus",
                    layout: .inline,
                    busy: false,
                    actionLabel: nil,
                    openThreadID: nil
                )
            )

        case let .handoff(_, fromInstanceIDs, fromModelSelections, _, toInstanceID, toModel, _, _):
            let handoffRun = item.base.runId.flatMap { runID in
                runs.first { $0.id == runID }
            }
            let resolvedToModel =
                toModel
                ?? (handoffRun?.providerInstanceID == toInstanceID ? handoffRun?.model : nil)

            let fromEndpoints: [String]
            if let fromModelSelections, !fromModelSelections.isEmpty {
                fromEndpoints = fromModelSelections.map {
                    endpointLabel(instanceID: $0.instanceId, model: $0.model)
                }
            } else {
                fromEndpoints = fromInstanceIDs.map { instanceID in
                    endpointLabel(
                        instanceID: instanceID,
                        model: latestRunModelBefore(
                            runs, instanceID: instanceID, beforeOrdinal: handoffRun?.ordinal
                        )
                    )
                }
            }

            let target = endpointLabel(instanceID: toInstanceID, model: resolvedToModel)
            let preparing = isHandoffInFlight(item.status)
            let label =
                preparing
                ? "Preparing context handoff"
                : (item.status == .failed ? "Context handoff failed" : "Context handoff")
            return .divider(
                .init(
                    label: label,
                    detail: fromEndpoints.isEmpty
                        ? target
                        : "\(fromEndpoints.joined(separator: ", ")) → \(target)",
                    tone: item.status == .failed ? .danger : .neutral,
                    symbol: "bolt",
                    layout: .stacked,
                    busy: preparing,
                    actionLabel: nil,
                    openThreadID: nil
                )
            )

        case let .fork(source, targetThreadID, _):
            let sourceThreadID: String? = if case let .run(threadID, _) = source { threadID } else { nil }
            return .divider(
                .init(
                    label: sourceThreadID != nil ? "Forked from conversation" : "Conversation fork",
                    detail: nil,
                    tone: .neutral,
                    symbol: "arrow.triangle.branch",
                    layout: .inline,
                    busy: false,
                    actionLabel: sourceThreadID != nil
                        ? "Open source conversation"
                        : "Open fork",
                    openThreadID: sourceThreadID ?? targetThreadID
                )
            )

        case let .threadCreated(targetThreadID, _, targetProviderInstanceID, targetModel):
            return .relatedThread(
                .init(
                    symbol: "message",
                    title: item.base.title ?? "Created thread",
                    detail: "\(targetProviderInstanceID) · \(targetModel)",
                    badge: "created",
                    badgeTone: .neutral,
                    threadID: targetThreadID,
                    orbSeed: nil,
                    orbState: nil
                )
            )

        case let .subagent(subagentID, _, _, _, childThreadID, prompt, progress, result):
            let streamedResult = result?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                ? result
                : nil
            // Once it stops, the last streamed result says more than a stale
            // progress line; while it runs, live progress comes first.
            let detail = item.status.isTerminal
                ? (streamedResult ?? progress ?? prompt)
                : (progress ?? streamedResult ?? prompt)
            let title = (item.base.title ?? "Subagent").trimmingCharacters(in: .whitespacesAndNewlines)
            return .relatedThread(
                .init(
                    symbol: "sparkles",
                    title: title.isEmpty ? "Subagent" : title,
                    detail: detail,
                    badge: item.status.rawValue,
                    badgeTone: subagentBadgeTone(item.status),
                    threadID: childThreadID,
                    // Child thread id first: the relationship surfaces only know
                    // thread ids, so this keeps one agent the same colour
                    // everywhere it appears.
                    orbSeed: childThreadID ?? subagentID,
                    orbState: subagentOrbState(item.status)
                )
            )

        default:
            return nil
        }
    }
}
