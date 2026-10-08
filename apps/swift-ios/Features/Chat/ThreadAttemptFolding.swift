import SwiftUI

/// The run attempt that produced an item, narrowed to what the transcript
/// folds on.
public struct ThreadTimelineAttempt: Equatable, Sendable {
    public let id: String
    public let runID: String
    /// `superseded` once a steer or retry replaced the attempt mid-run.
    public let status: String

    public init(id: String, runID: String, status: String) {
        self.id = id
        self.runID = runID
        self.status = status
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
        ThreadTimelineAttempt(id: attempt.id, runID: attempt.runId, status: attempt.status)
    }
}

/// "Superseded attempt": the partial output of an attempt a steer or retry
/// replaced, folded behind one row. Expansion shares the coordinator's set of
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

    /// Fold per anchor entry id, with every entry id the fold hides.
    static func folds(
        candidates: [Candidate],
        failedRunIDs: Set<String>,
        expandedKeys: Set<String>
    ) -> (byAnchorID: [String: ThreadAttemptFold], hiddenIDs: [String: ThreadAttemptFold]) {
        var byAnchorID: [String: ThreadAttemptFold] = [:]
        var anchorByAttemptID: [String: String] = [:]
        var hiddenIDs: [String: ThreadAttemptFold] = [:]
        for candidate in candidates {
            // A failed run stays readable in place, the failure in context.
            guard let attempt = candidate.attempt, attempt.status == "superseded",
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
        let (byAnchorID, hiddenIDs) = folds(
            candidates: candidates,
            failedRunIDs: failedRunIDs,
            expandedKeys: expandedKeys
        )
        guard !byAnchorID.isEmpty else { return Result(entries: entries, hiddenCitationKeys: [:]) }

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
        return Result(entries: result, hiddenCitationKeys: hiddenCitationKeys)
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
                        Text(verbatim: "Partial output retained")
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
        .accessibilityLabel("Superseded attempt, partial output retained")
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
