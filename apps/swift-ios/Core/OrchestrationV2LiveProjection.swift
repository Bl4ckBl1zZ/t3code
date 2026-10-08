import Foundation

/// A thread projection kept current by folding `subscribeThread` events in
/// place.
///
/// A port of `applyOrchestrationV2ProjectionEvent`
/// (packages/client-runtime/src/state/orchestrationV2Projection.ts) and the
/// visibility rules it uses from packages/shared/src/orchestrationV2Timeline.ts.
/// Every event type folds locally; the only case that asks for a snapshot is a
/// known event whose payload this client could not decode.
///
/// The TypeScript reducer copies arrays per event. Here the projection is
/// mutated in place and the hot tables are indexed by id, so streaming a token
/// into one turn item costs O(1) instead of O(items). Indexes are built on the
/// first event, not on adoption, so a snapshot that is never streamed into
/// costs nothing extra.
public struct OrchestrationV2LiveProjection: Sendable {
    public private(set) var projection: OrchestrationV2ThreadProjection
    private var index: Index?

    public init(_ projection: OrchestrationV2ThreadProjection) {
        self.projection = projection
    }

    public enum Outcome: Equatable, Sendable {
        case changed
        case unchanged
        /// The event cannot be folded here; only an authoritative snapshot can
        /// say what it did.
        case unmodelable
    }

    public mutating func apply(_ event: OrchestrationV2ThreadEvent) -> Outcome {
        switch event.change {
        case .unknown:
            return .unchanged
        case .undecodable:
            return .unmodelable
        default:
            break
        }
        guard event.threadId == projection.thread.id else { return .unchanged }

        switch event.change {
        case let .thread(thread):
            // Visited tracking is read state, not activity: no updatedAt bump.
            if event.type != "thread.visited", event.type != "thread.marked-unread" {
                projection.updatedAt = event.occurredAt
            }
            projection.thread = thread

        case let .titleReconciled(title, revision, origin):
            guard revision > (projection.thread.titleRevision ?? 0) else { return .unchanged }
            projection.updatedAt = event.occurredAt
            projection.thread.title = title
            projection.thread.titleRevision = revision
            projection.thread.titleOrigin = origin

        case let .run(run):
            projection.updatedAt = event.occurredAt
            Self.upsert(run, into: &projection.runs)
            dropHiddenLocalRows()

        case .runBackgroundWorkCancelled:
            // The cancelled-work list is not modeled on the native run.
            projection.updatedAt = event.occurredAt

        case let .attempt(attempt):
            projection.updatedAt = event.occurredAt
            Self.upsert(attempt, into: &projection.attempts)
            dropHiddenLocalRows()

        case let .node(node):
            projection.updatedAt = event.occurredAt
            ensureIndex()
            Self.upsert(node, into: &projection.nodes, index: &index!.nodes)

        case let .subagent(subagent):
            projection.updatedAt = event.occurredAt
            Self.upsert(subagent, into: &projection.subagents)

        case let .providerSession(session):
            projection.updatedAt = event.occurredAt
            Self.upsert(session, into: &projection.providerSessions)

        case let .providerSessionDetached(sessionID):
            projection.updatedAt = event.occurredAt
            projection.providerSessions.removeAll { $0.id == sessionID }

        case let .providerThread(thread):
            projection.updatedAt = event.occurredAt
            Self.upsert(thread, into: &projection.providerThreads)

        case var .providerTurn(turn):
            projection.updatedAt = event.occurredAt
            ensureIndex()
            // A later report may omit usage it already gave; keep the last
            // reading so the context meter does not blink back to empty.
            if turn.tokenUsage == nil,
               let existing = index!.providerTurns[turn.id] {
                turn.tokenUsage = projection.providerTurns[existing].tokenUsage
            }
            Self.upsert(turn, into: &projection.providerTurns, index: &index!.providerTurns)

        case let .runtimeRequest(request):
            projection.updatedAt = event.occurredAt
            Self.upsert(request, into: &projection.runtimeRequests)

        case let .message(message):
            projection.updatedAt = event.occurredAt
            ensureIndex()
            Self.upsert(message, into: &projection.messages, index: &index!.messages)

        case let .turnItem(item):
            projection.updatedAt = event.occurredAt
            applyTurnItem(item)

        case let .checkpoint(checkpoint):
            projection.updatedAt = event.occurredAt
            Self.upsert(checkpoint, into: &projection.checkpoints)

        case let .contextHandoff(handoff):
            projection.updatedAt = event.occurredAt
            Self.upsert(handoff, into: &projection.contextHandoffs)

        case let .contextTransfer(transfer):
            projection.updatedAt = event.occurredAt
            Self.upsert(transfer, into: &projection.contextTransfers)

        case .activityOnly:
            projection.updatedAt = event.occurredAt

        case .unknown, .undecodable:
            return .unchanged
        }
        return .changed
    }

    // MARK: - Turn items

    private mutating func applyTurnItem(_ item: OrchestrationV2TurnItem) {
        ensureIndex()
        let previousType = index!.turnItems[item.id].map { projection.turnItems[$0].type }
        Self.upsert(item, into: &projection.turnItems, index: &index!.turnItems)

        // Visibility of other rows depends only on runs, attempts, and
        // interrupt requests, so ordinary item updates (the token-streaming hot
        // path) touch just their own row.
        if item.type == "run_interrupt_request" || previousType == "run_interrupt_request" {
            dropHiddenLocalRows()
        }
        if OrchestrationV2Visibility.isVisible(
            item,
            runs: projection.runs,
            attempts: projection.attempts,
            items: projection.turnItems
        ) {
            upsertVisibleRow(item)
        } else {
            removeVisibleRow(sourceItemID: item.id)
        }
    }

    /// `upsertVisibleTurnItem`: the row moves to its ordinal among local rows and
    /// every row is renumbered. When the row would land where it already is,
    /// the update is written in place.
    private mutating func upsertVisibleRow(_ item: OrchestrationV2TurnItem) {
        let row = OrchestrationV2ProjectedTurnItem(
            position: 0,
            visibility: .local,
            sourceThreadId: item.base.threadId,
            sourceItemId: item.id,
            item: item
        )
        let existing = index!.visible[item.id]
        // Read rows through `projection` rather than a local copy: a live copy
        // would force the in-place write below to duplicate the whole array.
        let count = projection.visibleTurnItems.count

        if index!.localRowsSorted, index!.positionsNormalized {
            if let existing,
               projection.visibleTurnItems[existing].visibility == .local,
               projection.visibleTurnItems[existing].item.ordinal == item.ordinal,
               existing + 1 == count
                || projection.visibleTurnItems[existing + 1].visibility == .local {
                var updated = row
                updated.position = existing
                projection.visibleTurnItems[existing] = updated
                return
            }
            if existing == nil,
               count > 0,
               projection.visibleTurnItems[count - 1].visibility == .local,
               !Self.sortsAfter(projection.visibleTurnItems[count - 1].item, item) {
                var appended = row
                appended.position = count
                projection.visibleTurnItems.append(appended)
                index!.visible[item.id] = count
                return
            }
        }

        var next = projection.visibleTurnItems
        if let existing { next.remove(at: existing) }
        let insertion = next.firstIndex {
            $0.visibility == .local && Self.sortsAfter($0.item, item)
        } ?? next.count
        next.insert(row, at: insertion)
        projection.visibleTurnItems = next
        renumberVisibleRows()
    }

    private mutating func removeVisibleRow(sourceItemID: String) {
        guard let existing = index!.visible[sourceItemID] else { return }
        projection.visibleTurnItems.remove(at: existing)
        renumberVisibleRows()
    }

    /// `activeVisibleTurnItems`: drops local rows a run or attempt change has
    /// hidden. Inherited and synthetic rows are the server's call.
    private mutating func dropHiddenLocalRows() {
        let isVisible = OrchestrationV2Visibility.Context(
            runs: projection.runs,
            attempts: projection.attempts,
            items: projection.turnItems
        )
        let rows = projection.visibleTurnItems
        guard rows.contains(where: { $0.visibility == .local && !isVisible.contains($0.item) }) else {
            return
        }
        projection.visibleTurnItems = rows.filter {
            $0.visibility != .local || isVisible.contains($0.item)
        }
        renumberVisibleRows()
    }

    private mutating func renumberVisibleRows() {
        for position in projection.visibleTurnItems.indices
        where projection.visibleTurnItems[position].position != position {
            projection.visibleTurnItems[position].position = position
        }
        if index != nil {
            index!.visible = Self.visibleIndex(projection.visibleTurnItems)
            index!.positionsNormalized = true
        }
    }

    /// The TypeScript ordering: ordinal, then id by `localeCompare`.
    private static func sortsAfter(
        _ candidate: OrchestrationV2TurnItem,
        _ item: OrchestrationV2TurnItem
    ) -> Bool {
        if candidate.ordinal != item.ordinal { return candidate.ordinal > item.ordinal }
        return candidate.id.compare(item.id, locale: collationLocale) == .orderedDescending
    }

    private static let collationLocale = Locale(identifier: "en")

    // MARK: - Indexes

    private struct Index: Sendable {
        var turnItems: [String: Int]
        var visible: [String: Int]
        var messages: [String: Int]
        var nodes: [String: Int]
        var providerTurns: [String: Int]
        /// Local rows in (ordinal, id) order. Every insert keeps it, so it only
        /// has to be checked once per snapshot; without it the in-place fast
        /// path could disagree with the TypeScript insertion point.
        var localRowsSorted: Bool
        /// Row `n` has position `n`, which is what a renumber produces.
        var positionsNormalized: Bool
    }

    private mutating func ensureIndex() {
        guard index == nil else { return }
        let rows = projection.visibleTurnItems
        var sorted = true
        var previousLocal: OrchestrationV2TurnItem?
        for row in rows where row.visibility == .local {
            if let previous = previousLocal, Self.sortsAfter(previous, row.item) {
                sorted = false
                break
            }
            previousLocal = row.item
        }
        index = Index(
            turnItems: Self.idIndex(projection.turnItems),
            visible: Self.visibleIndex(rows),
            messages: Self.idIndex(projection.messages),
            nodes: Self.idIndex(projection.nodes),
            providerTurns: Self.idIndex(projection.providerTurns),
            localRowsSorted: sorted,
            positionsNormalized: rows.indices.allSatisfy { rows[$0].position == $0 }
        )
    }

    private static func idIndex<Row: Identifiable>(_ rows: [Row]) -> [String: Int]
    where Row.ID == String {
        var index: [String: Int] = [:]
        index.reserveCapacity(rows.count)
        // First match wins, like `findIndex`.
        for (position, row) in rows.enumerated() where index[row.id] == nil {
            index[row.id] = position
        }
        return index
    }

    private static func visibleIndex(_ rows: [OrchestrationV2ProjectedTurnItem]) -> [String: Int] {
        var index: [String: Int] = [:]
        index.reserveCapacity(rows.count)
        for (position, row) in rows.enumerated() where index[row.sourceItemId] == nil {
            index[row.sourceItemId] = position
        }
        return index
    }

    /// `upsertEntity` for the small tables, where a scan beats an index.
    private static func upsert<Row: Identifiable>(_ row: Row, into rows: inout [Row])
    where Row.ID == String {
        if let existing = rows.firstIndex(where: { $0.id == row.id }) {
            rows[existing] = row
        } else {
            rows.append(row)
        }
    }

    private static func upsert<Row: Identifiable>(
        _ row: Row,
        into rows: inout [Row],
        index: inout [String: Int]
    ) where Row.ID == String {
        if let existing = index[row.id] {
            rows[existing] = row
        } else {
            index[row.id] = rows.count
            rows.append(row)
        }
    }
}

/// Which turn items the transcript shows. Ported from
/// packages/shared/src/orchestrationV2Timeline.ts.
enum OrchestrationV2Visibility {
    /// `isOrchestrationV2TurnItemVisible`, for one item.
    static func isVisible(
        _ item: OrchestrationV2TurnItem,
        runs: [OrchestrationV2Run],
        attempts: [OrchestrationV2RunAttempt],
        items: [OrchestrationV2TurnItem]
    ) -> Bool {
        if let runID = item.base.runId,
           runs.contains(where: { $0.id == runID && $0.status == "rolled_back" }) {
            return false
        }
        // A queued message is composer state, not history: once its run is
        // cancelled it never reached the provider.
        if isQueuedTurn(item), let runID = item.base.runId,
           runs.contains(where: { $0.id == runID && $0.status == "cancelled" }) {
            return false
        }
        guard item.type == "run_interrupt_result",
              let runID = item.base.runId,
              let nodeID = item.base.nodeId else {
            return true
        }
        let superseded = attempts.contains {
            $0.runId == runID && $0.rootNodeId == nodeID && $0.status == "superseded"
        }
        guard superseded else { return true }
        // A paired stop-then-steer keeps its result; a plain steer hides it.
        return items.contains { $0.type == "run_interrupt_request" && $0.base.runId == runID }
    }

    /// `makeOrchestrationV2VisibilityContext`: the same rules as set lookups,
    /// for scanning a whole timeline in O(n).
    struct Context {
        private var rolledBackRuns: Set<String> = []
        private var cancelledRuns: Set<String> = []
        private var supersededAttempts: Set<String> = []
        private var interruptRequestRuns: Set<String> = []

        init(
            runs: [OrchestrationV2Run],
            attempts: [OrchestrationV2RunAttempt],
            items: [OrchestrationV2TurnItem]
        ) {
            for run in runs {
                if run.status == "rolled_back" {
                    rolledBackRuns.insert(run.id)
                } else if run.status == "cancelled" {
                    cancelledRuns.insert(run.id)
                }
            }
            for attempt in attempts where attempt.status == "superseded" {
                supersededAttempts.insert(Self.key(attempt.runId, attempt.rootNodeId))
            }
            for item in items where item.type == "run_interrupt_request" {
                if let runID = item.base.runId { interruptRequestRuns.insert(runID) }
            }
        }

        func contains(_ item: OrchestrationV2TurnItem) -> Bool {
            if let runID = item.base.runId, rolledBackRuns.contains(runID) { return false }
            if isQueuedTurn(item), let runID = item.base.runId, cancelledRuns.contains(runID) {
                return false
            }
            guard item.type == "run_interrupt_result",
                  let runID = item.base.runId,
                  let nodeID = item.base.nodeId else {
                return true
            }
            guard supersededAttempts.contains(Self.key(runID, nodeID)) else { return true }
            return interruptRequestRuns.contains(runID)
        }

        private static func key(_ runID: String, _ nodeID: String?) -> String {
            "\(runID):\(nodeID ?? "null")"
        }
    }

    private static func isQueuedTurn(_ item: OrchestrationV2TurnItem) -> Bool {
        if case .userMessage(_, .queuedTurn, _, _) = item.payload { return true }
        return false
    }
}
