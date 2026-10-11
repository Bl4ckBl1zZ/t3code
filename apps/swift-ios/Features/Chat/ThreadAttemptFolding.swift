import SwiftUI

/// The run attempt that produced an item, narrowed to what the transcript
/// folds on.
public struct ThreadTimelineAttempt: Equatable, Sendable {
    public let id: String
    public let runID: String
    /// `superseded` once a steer or retry replaced the attempt mid-run.
    public let status: String
    /// When the attempt ended. A steer stamps it as it is dispatched.
    public let completedAt: Date?

    public init(id: String, runID: String, status: String, completedAt: Date? = nil) {
        self.id = id
        self.runID = runID
        self.status = status
        self.completedAt = completedAt
    }
}

/// Ported from `resolveOrchestrationV2ItemAttempt` in
/// packages/shared/src/orchestrationV2Timeline.ts: walk up from the item's
/// execution node until a node is some attempt of the item's own run's root.
struct ThreadTimelineAttemptResolver {
    private let attemptByRootNodeID: [String: OrchestrationV2RunAttempt]
    private let nodeByID: [String: OrchestrationV2ExecutionNode]

    init(attempts: [OrchestrationV2RunAttempt], nodes: [OrchestrationV2ExecutionNode]) {
        // Later rows win, as building a JS `Map` from the same arrays does.
        var attemptByRootNodeID: [String: OrchestrationV2RunAttempt] = [:]
        for attempt in attempts {
            if let root = attempt.rootNodeId { attemptByRootNodeID[root] = attempt }
        }
        self.attemptByRootNodeID = attemptByRootNodeID
        nodeByID = attemptByRootNodeID.isEmpty
            ? [:]
            : Dictionary(nodes.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    }

    func attempt(for item: OrchestrationV2TurnItem) -> ThreadTimelineAttempt? {
        guard !attemptByRootNodeID.isEmpty,
              let runID = item.base.runId else { return nil }
        var nodeID = item.base.nodeId
        var visited = Set<String>()
        while let current = nodeID, visited.insert(current).inserted {
            if let direct = attemptByRootNodeID[current], direct.runId == runID {
                return Self.timelineAttempt(direct)
            }
            guard let node = nodeByID[current] else { return nil }
            if let root = node.rootNodeId,
               let rootAttempt = attemptByRootNodeID[root], rootAttempt.runId == runID {
                return Self.timelineAttempt(rootAttempt)
            }
            nodeID = node.parentNodeId
        }
        return nil
    }

    private static func timelineAttempt(_ attempt: OrchestrationV2RunAttempt) -> ThreadTimelineAttempt {
        ThreadTimelineAttempt(
            id: attempt.id,
            runID: attempt.runId,
            status: attempt.status,
            completedAt: attempt.completedAt.flatMap { ThreadTimelineDay.date(fromISO8601: $0) }
        )
    }
}

/// "Superseded attempt": the partial output of an attempt a steer or retry
/// cut off, folded behind one row. Expansion shares the coordinator's set of
/// open folds under a key no run id can collide with.
struct ThreadAttemptFold: Equatable, Sendable {
    let attemptID: String
    let runID: String
    let date: Date?
    var isExpanded: Bool

    var id: String { "attempt-fold:\(attemptID)" }
    var expansionKey: String { Self.expansionKey(attemptID) }

    static func expansionKey(_ attemptID: String) -> String { "attempt:\(attemptID)" }
}

/// Ported from `deriveSupersededAttemptFolds` in MessagesTimeline.logic.ts.
/// Applies even when activity is always expanded: these entries were replaced,
/// not merely finished.
enum ThreadAttemptFolding {
    /// One feed entry as the fold sees it. `attempt` is nil for an entry that
    /// never folds: user input, persistent resources, live work, and rows that
    /// span more than one attempt.
    struct Candidate: Equatable {
        let entryID: String
        let attempt: ThreadTimelineAttempt?
    }

    /// One piece of provider output as the complete-reply check sees it.
    /// `replyCompletedAt` is set only on a finished assistant reply: not
    /// streaming, its item `completed`, with a completion time.
    struct Output: Equatable {
        let entryID: String
        let attempt: ThreadTimelineAttempt
        let replyCompletedAt: Date?
    }

    /// Ported from `completeSupersededReplyEntryIds`: final replies of
    /// superseded attempts that finished before the steer replaced them. The
    /// provider closes a reply it cut off only after the steer stamped the
    /// attempt's `completedAt`, so a reply that completed earlier was whole.
    /// Item status alone cannot tell: an interrupted stream also closes as
    /// `completed`. The reply must be the attempt's last output; trailing tool
    /// or reasoning work means the attempt was still going.
    static func completeReplyEntryIDs(outputs: [Output]) -> Set<String> {
        var lastByAttemptID: [String: Output] = [:]
        for output in outputs where output.attempt.status == "superseded" {
            lastByAttemptID[output.attempt.id] = output
        }
        return Set(lastByAttemptID.values.compactMap { output in
            guard let replyAt = output.replyCompletedAt,
                  let supersededAt = output.attempt.completedAt,
                  replyAt < supersededAt else { return nil }
            return output.entryID
        })
    }

    /// Fold per anchor entry id, with every entry id the fold hides. An
    /// attempt in `completeAttemptIDs` had finished its reply, so it stays in
    /// the timeline like any other turn output.
    static func folds(
        candidates: [Candidate],
        failedRunIDs: Set<String>,
        completeAttemptIDs: Set<String> = [],
        expandedKeys: Set<String>
    ) -> (byAnchorID: [String: ThreadAttemptFold], hiddenIDs: [String: ThreadAttemptFold]) {
        var byAnchorID: [String: ThreadAttemptFold] = [:]
        var anchorByAttemptID: [String: String] = [:]
        var hiddenIDs: [String: ThreadAttemptFold] = [:]
        for candidate in candidates {
            // A failed run stays readable in place, the failure in context.
            guard let attempt = candidate.attempt, attempt.status == "superseded",
                  !completeAttemptIDs.contains(attempt.id),
                  !failedRunIDs.contains(attempt.runID) else { continue }
            let anchorID = anchorByAttemptID[attempt.id] ?? candidate.entryID
            anchorByAttemptID[attempt.id] = anchorID
            let fold = byAnchorID[anchorID] ?? ThreadAttemptFold(
                attemptID: attempt.id,
                runID: attempt.runID,
                date: nil,
                isExpanded: expandedKeys.contains(ThreadAttemptFold.expansionKey(attempt.id))
            )
            byAnchorID[anchorID] = fold
            hiddenIDs[candidate.entryID] = fold
        }
        return (byAnchorID, hiddenIDs)
    }

    struct Result {
        let entries: [ThreadTimelineEntry]
        /// Message id to the expansion key that reveals it, for citations.
        let hiddenCitationKeys: [String: String]
        /// Finished replies a steer superseded. They answer their prompt, so
        /// a turn fold keeps them out too.
        var completeReplyEntryIDs: Set<String> = []
    }

    static func apply(
        entries: [ThreadTimelineEntry],
        detail: FeatureThreadDetail,
        expandedKeys: Set<String>
    ) -> Result {
        var attemptByItemID: [String: ThreadTimelineAttempt] = [:]
        var failedRunIDs = Set<String>()
        for projected in detail.timelineItems {
            if let attempt = detail.itemSupport[projected.id]?.attempt {
                attemptByItemID[projected.item.id] = attempt
            }
            let item = projected.item
            if item.type == "error", item.status == .failed, item.base.parentItemId == nil,
               let runID = item.base.runId {
                failedRunIDs.insert(runID)
            }
        }
        guard attemptByItemID.values.contains(where: { $0.status == "superseded" }) else {
            return Result(entries: entries, hiddenCitationKeys: [:])
        }
        for run in detail.workflow.runs where run.status == "failed" { failedRunIDs.insert(run.id) }

        let candidates = entries.map { entry in
            Candidate(entryID: entry.id, attempt: attempt(of: entry, detail: detail, byItemID: attemptByItemID))
        }
        let completeReplyIDs = completeReplyEntryIDs(
            outputs: outputs(entries: entries, detail: detail, byItemID: attemptByItemID)
        )
        let completeAttemptIDs = Set(candidates.compactMap { candidate in
            completeReplyIDs.contains(candidate.entryID) ? candidate.attempt?.id : nil
        })
        let (byAnchorID, hiddenIDs) = folds(
            candidates: candidates,
            failedRunIDs: failedRunIDs,
            completeAttemptIDs: completeAttemptIDs,
            expandedKeys: expandedKeys
        )
        guard !byAnchorID.isEmpty else {
            return Result(entries: entries, hiddenCitationKeys: [:], completeReplyEntryIDs: completeReplyIDs)
        }

        var result: [ThreadTimelineEntry] = []
        var hiddenCitationKeys: [String: String] = [:]
        // A day divider waits for the first entry under it that stays, so a
        // folded day never leaves an orphaned divider behind.
        var pendingDivider: ThreadTimelineEntry?
        func append(_ entry: ThreadTimelineEntry) {
            if let divider = pendingDivider { result.append(divider); pendingDivider = nil }
            result.append(entry)
        }
        for entry in entries {
            if case .dayDivider = entry { pendingDivider = entry; continue }
            if var fold = byAnchorID[entry.id] {
                fold = ThreadAttemptFold(attemptID: fold.attemptID, runID: fold.runID,
                    date: entry.date, isExpanded: fold.isExpanded)
                append(.structural(.attemptFold(fold)))
            }
            if let fold = hiddenIDs[entry.id], !fold.isExpanded {
                if case let .message(message, _) = entry {
                    hiddenCitationKeys[message.wireMessageID ?? message.id] = fold.expansionKey
                    hiddenCitationKeys[message.id] = fold.expansionKey
                }
                continue
            }
            append(entry)
        }
        return Result(
            entries: result,
            hiddenCitationKeys: hiddenCitationKeys,
            completeReplyEntryIDs: completeReplyIDs
        )
    }

    /// Assistant replies and work in feed order, each with its attempt. Unlike
    /// fold candidates, running work counts: it means the attempt was still
    /// going when it was replaced.
    private static func outputs(
        entries: [ThreadTimelineEntry],
        detail: FeatureThreadDetail,
        byItemID: [String: ThreadTimelineAttempt]
    ) -> [Output] {
        var itemsByID: [String: OrchestrationV2TurnItem] = [:]
        for projected in detail.timelineItems { itemsByID[projected.item.id] = projected.item }
        var outputs: [Output] = []
        for entry in entries {
            switch entry {
            case let .message(message, _):
                guard message.role == .assistant, let attempt = byItemID[message.id] else { continue }
                let item = itemsByID[message.id]
                let finished = message.state != .streaming
                    && item?.type == "assistant_message"
                    && item?.status == .completed
                let replyAt = finished
                    ? item?.base.completedAt.flatMap { ThreadTimelineDay.date(fromISO8601: $0) }
                    : nil
                outputs.append(Output(entryID: entry.id, attempt: attempt, replyCompletedAt: replyAt))
            case let .workLog(work):
                for row in work.rows {
                    guard let attempt = detail.itemSupport[row.projectedItem.id]?.attempt else { continue }
                    outputs.append(Output(entryID: entry.id, attempt: attempt, replyCompletedAt: nil))
                }
            case .lifecycle, .turnFold, .mcpApp, .dayDivider, .structural, .proposedPlan:
                continue
            }
        }
        return outputs
    }

    private static let persistentLifecycleTypes: Set<String> = ["fork", "subagent", "thread_created"]

    private static func attempt(
        of entry: ThreadTimelineEntry,
        detail: FeatureThreadDetail,
        byItemID: [String: ThreadTimelineAttempt]
    ) -> ThreadTimelineAttempt? {
        switch entry {
        case let .message(message, _):
            // User messages are the run's inputs, including the steer that
            // started the replacement attempt.
            guard message.role == .assistant else { return nil }
            return byItemID[message.id]
        case let .workLog(work):
            // A command still running keeps its row, as it does in a turn fold.
            guard !work.rows.contains(where: \.isRunning) else { return nil }
            return shared(work.rows.map { detail.itemSupport[$0.projectedItem.id]?.attempt })
        case let .lifecycle(lifecycle):
            guard !lifecycle.rows.contains(where: { persistentLifecycleTypes.contains($0.item.type) }) else {
                return nil
            }
            return shared(lifecycle.rows.map { detail.itemSupport[$0.id]?.attempt })
        case .turnFold, .mcpApp, .dayDivider, .structural, .proposedPlan:
            return nil
        }
    }

    /// The one attempt every row belongs to, or nil when they differ.
    private static func shared(_ attempts: [ThreadTimelineAttempt?]) -> ThreadTimelineAttempt? {
        guard let first = attempts.first ?? nil else { return nil }
        return attempts.allSatisfy { $0 == first } ? first : nil
    }
}

/// The boundary a superseded attempt folds behind, drawn as a system divider
/// that opens: what it replaced stays one tap away.
struct ThreadAttemptFoldRow: View {
    let fold: ThreadAttemptFold
    let onToggle: () -> Void
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 10) {
                hairline
                HStack(spacing: 6) {
                    Image(systemName: "arrow.uturn.backward")
                        .font(ChatTimelineStyle.small.weight(.medium))
                        .foregroundStyle(T3Colors.textTertiary)
                    Text(verbatim: "Superseded attempt")
                        .font(ChatTimelineStyle.smallStrong)
                        .foregroundStyle(T3Colors.textSecondary)
                    // The label alone at accessibility sizes, rather than
                    // both cut short.
                    if !dynamicTypeSize.isAccessibilitySize {
                        Text(verbatim: "Cut off by a steer")
                            .font(ChatTimelineStyle.small)
                            .foregroundStyle(T3Colors.textTertiary)
                    }
                    TimelineDisclosureChevron(isExpanded: fold.isExpanded)
                }
                .lineLimit(1)
                .layoutPriority(1)
                hairline
            }
            .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Superseded attempt, cut off by a steer")
        .accessibilityValue(fold.isExpanded ? "Expanded" : "Collapsed")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier(fold.id)
        .padding(.bottom, ChatTimelineStyle.entrySpacing - 12)
    }

    private var hairline: some View {
        Rectangle()
            .fill(ChatTimelineStyle.hairline)
            .frame(height: 1)
            .frame(maxWidth: .infinity)
            .accessibilityHidden(true)
    }
}
