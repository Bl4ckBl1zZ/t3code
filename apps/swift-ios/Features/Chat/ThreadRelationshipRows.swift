import Foundation

// The thread's immediate lineage — parents, forks, transfers and subagents.
//
// Ports packages/client-runtime/src/state/threadRelationships.ts together with
// the pure half of apps/mobile/src/features/threads/useThreadRelationshipRows.ts
// so the banner above the transcript and the desktop details panel cannot
// disagree about what a thread is related to.
//
// As in ThreadActivityInspector, the inputs are narrowed value types rather than
// `OrchestrationV2ThreadProjection` itself: `Core` models the projection's
// subagent and context-transfer tables without the join columns this graph
// walks (`subagent.childThreadId`, `contextTransfer.sourceThreadId` /
// `targetThreadId`), so the caller supplies the links it can resolve and the
// graph degrades to the relationships it was actually given.

public enum ThreadRelationshipKind: String, Equatable, Hashable, Sendable {
    case fork
    case subagent
    case transfer
}

/// A thread as the relationship graph reads it. Adapted from either an
/// `OrchestrationV2ThreadShell` (the home list) or an `OrchestrationV2AppThread`
/// (the open projection); both carry every field below.
public struct ThreadRelationshipShell: Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let title: String
    /// `idle` or a run status. Becomes the edge status for lineage edges.
    public let status: String
    public let parentThreadID: String?
    /// `fork`, `subagent`, or absent for a root thread.
    public let relationshipToParent: String?
    /// Set only when `forkedFrom` is a run reference, which outranks lineage.
    public let forkedFromRunThreadID: String?
    public let archivedAt: String?
    public let deletedAt: String?

    public init(
        id: String,
        title: String,
        status: String,
        parentThreadID: String?,
        relationshipToParent: String?,
        forkedFromRunThreadID: String?,
        archivedAt: String? = nil,
        deletedAt: String? = nil
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.parentThreadID = parentThreadID
        self.relationshipToParent = relationshipToParent
        self.forkedFromRunThreadID = forkedFromRunThreadID
        self.archivedAt = archivedAt
        self.deletedAt = deletedAt
    }

    public init(_ shell: OrchestrationV2ThreadShell) {
        self.init(
            id: shell.id,
            title: shell.title,
            status: shell.status,
            parentThreadID: shell.lineage.parentThreadId,
            relationshipToParent: shell.lineage.relationshipToParent,
            forkedFromRunThreadID: Self.runThreadID(shell.forkedFrom),
            archivedAt: shell.archivedAt,
            deletedAt: shell.deletedAt
        )
    }

    /// The projection's own thread. `status` is not part of `AppThread`, so the
    /// caller passes the shell status it already renders in the header.
    public init(_ thread: OrchestrationV2AppThread, status: String = "idle") {
        self.init(
            id: thread.id,
            title: thread.title,
            status: status,
            parentThreadID: thread.lineage.parentThreadId,
            relationshipToParent: thread.lineage.relationshipToParent,
            forkedFromRunThreadID: Self.runThreadID(thread.forkedFrom),
            archivedAt: thread.archivedAt,
            deletedAt: thread.deletedAt
        )
    }

    private static func runThreadID(_ source: OrchestrationV2ForkSource?) -> String? {
        if case let .run(threadID, _) = source { return threadID }
        return nil
    }
}

/// A subagent edge plus the observability annotations the row renders.
///
/// `childThreadID` is what makes a subagent addressable from a relationship
/// surface at all, and it doubles as the orb seed: the relationship surfaces
/// only know thread ids, so seeding from the child thread keeps one agent the
/// same colour here and on the timeline. `ThreadLifecycle` seeds the same way.
public struct ThreadRelationshipSubagentLink: Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let childThreadID: String?
    public let status: String
    public let title: String?
    public let workflow: AgentWorkflowProgress?
    public let usage: AgentTaskUsage?

    public init(
        id: String,
        childThreadID: String?,
        status: String,
        title: String? = nil,
        workflow: AgentWorkflowProgress? = nil,
        usage: AgentTaskUsage? = nil
    ) {
        self.id = id
        self.childThreadID = childThreadID
        self.status = status
        self.title = title
        self.workflow = workflow
        self.usage = usage
    }

    /// Best-effort recovery from the transcript.
    ///
    /// `Core`'s `OrchestrationV2Subagent` does not model `childThreadId`, but the
    /// `subagent` turn item does, so subagent rows work today and gain their
    /// workflow/usage annotations once the projection row carries them.
    public init?(turnItem: OrchestrationV2TurnItem) {
        guard case let .subagent(subagentID, _, _, _, childThreadID, _, _, _) = turnItem.payload
        else { return nil }
        self.init(
            id: subagentID,
            childThreadID: childThreadID,
            status: turnItem.base.rawStatus,
            title: turnItem.base.title
        )
    }

    /// The orb seed, preferring the child thread id over the subagent id.
    public var orbSeed: String { childThreadID ?? id }
}

public struct ThreadRelationshipTransferLink: Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let sourceThreadID: String
    public let targetThreadID: String
    public let status: String

    public init(id: String, sourceThreadID: String, targetThreadID: String, status: String) {
        self.id = id
        self.sourceThreadID = sourceThreadID
        self.targetThreadID = targetThreadID
        self.status = status
    }
}

public struct ThreadRelationshipEdge: Equatable, Hashable, Sendable {
    public let sourceThreadID: String
    public let targetThreadID: String
    public let kind: ThreadRelationshipKind
    public let status: String?

    public init(
        sourceThreadID: String,
        targetThreadID: String,
        kind: ThreadRelationshipKind,
        status: String?
    ) {
        self.sourceThreadID = sourceThreadID
        self.targetThreadID = targetThreadID
        self.kind = kind
        self.status = status
    }

    var key: String { "\(sourceThreadID)\u{1f}\(targetThreadID)\u{1f}\(kind.rawValue)" }
}

public struct ThreadRelationshipNode: Equatable, Hashable, Sendable {
    public let threadID: String
    public let thread: ThreadRelationshipShell?
    /// The thread is referenced by an edge but absent from every list this
    /// client holds — deleted, or in a project the phone has not synced.
    public let missing: Bool

    public init(threadID: String, thread: ThreadRelationshipShell?, missing: Bool) {
        self.threadID = threadID
        self.thread = thread
        self.missing = missing
    }
}

public struct ThreadRelationshipGraph: Equatable, Sendable {
    public let nodes: [String: ThreadRelationshipNode]
    /// Insertion ordered, which is what makes row order deterministic.
    public let edges: [ThreadRelationshipEdge]

    public init(nodes: [String: ThreadRelationshipNode], edges: [ThreadRelationshipEdge]) {
        self.nodes = nodes
        self.edges = edges
    }

    public func node(_ threadID: String) -> ThreadRelationshipNode? { nodes[threadID] }
}

public struct ThreadRelationshipRow: Equatable, Hashable, Sendable, Identifiable {
    public let threadID: String
    public let fromThreadID: String
    public let depth: Int
    public let edge: ThreadRelationshipEdge

    public init(threadID: String, fromThreadID: String, depth: Int, edge: ThreadRelationshipEdge) {
        self.threadID = threadID
        self.fromThreadID = fromThreadID
        self.depth = depth
        self.edge = edge
    }

    /// Stable across a status change so a row animates rather than remounting.
    public var id: String { "\(edge.kind.rawValue):\(threadID)" }
}

// MARK: - Graph

public enum ThreadRelationships {
    public static func deriveGraph(
        threads: [ThreadRelationshipShell],
        ownerThreadID: String?,
        subagents: [ThreadRelationshipSubagentLink] = [],
        transfers: [ThreadRelationshipTransferLink] = []
    ) -> ThreadRelationshipGraph {
        // Callers order shells from most to least authoritative: live shells
        // precede archived snapshots, which may still hold a stale copy during
        // an archive refresh.
        var uniqueThreads: [ThreadRelationshipShell] = []
        var seenThreadIDs: Set<String> = []
        for thread in threads where seenThreadIDs.insert(thread.id).inserted {
            uniqueThreads.append(thread)
        }

        var nodes: [String: ThreadRelationshipNode] = [:]
        for thread in uniqueThreads {
            nodes[thread.id] = ThreadRelationshipNode(
                threadID: thread.id, thread: thread, missing: false
            )
        }

        var edges: [ThreadRelationshipEdge] = []
        var edgeIndexByKey: [String: Int] = [:]

        func ensureNode(_ threadID: String) {
            guard nodes[threadID] == nil else { return }
            nodes[threadID] = ThreadRelationshipNode(
                threadID: threadID, thread: nil, missing: true
            )
        }

        func addEdge(_ edge: ThreadRelationshipEdge) {
            ensureNode(edge.sourceThreadID)
            ensureNode(edge.targetThreadID)
            if let index = edgeIndexByKey[edge.key] {
                edges[index] = edge
            } else {
                edgeIndexByKey[edge.key] = edges.count
                edges.append(edge)
            }
        }

        for thread in uniqueThreads {
            guard let parentThreadID = thread.forkedFromRunThreadID ?? thread.parentThreadID else {
                continue
            }
            addEdge(
                ThreadRelationshipEdge(
                    sourceThreadID: parentThreadID,
                    targetThreadID: thread.id,
                    kind: thread.relationshipToParent == "subagent" ? .subagent : .fork,
                    status: thread.status
                )
            )
        }

        if let ownerThreadID {
            for subagent in subagents {
                guard let childThreadID = subagent.childThreadID else { continue }
                addEdge(
                    ThreadRelationshipEdge(
                        sourceThreadID: ownerThreadID,
                        targetThreadID: childThreadID,
                        kind: .subagent,
                        status: subagent.status
                    )
                )
            }
        }

        for transfer in transfers where transfer.sourceThreadID != transfer.targetThreadID {
            addEdge(
                ThreadRelationshipEdge(
                    sourceThreadID: transfer.sourceThreadID,
                    targetThreadID: transfer.targetThreadID,
                    kind: .transfer,
                    status: transfer.status
                )
            )
        }

        return ThreadRelationshipGraph(nodes: nodes, edges: edges)
    }

    /// One row per directly related thread, first edge wins.
    public static func immediateRelationships(
        graph: ThreadRelationshipGraph,
        threadID: String
    ) -> [ThreadRelationshipRow] {
        var visited: Set<String> = []
        var rows: [ThreadRelationshipRow] = []
        for edge in graph.edges {
            let relatedID: String?
            if edge.sourceThreadID == threadID {
                relatedID = edge.targetThreadID
            } else if edge.targetThreadID == threadID {
                relatedID = edge.sourceThreadID
            } else {
                relatedID = nil
            }
            guard let relatedID, visited.insert(relatedID).inserted else { continue }
            rows.append(
                ThreadRelationshipRow(
                    threadID: relatedID, fromThreadID: threadID, depth: 1, edge: edge
                )
            )
        }
        return rows
    }

    /// Breadth-first walk of the whole component. Not used by the banner, which
    /// shows immediate lineage only, but the details surface reads it.
    public static func walk(
        graph: ThreadRelationshipGraph,
        threadID: String
    ) -> [ThreadRelationshipRow] {
        var visited: Set<String> = [threadID]
        var pending: [(threadID: String, depth: Int)] = [(threadID, 0)]
        var rows: [ThreadRelationshipRow] = []
        var index = 0
        while index < pending.count {
            let current = pending[index]
            index += 1
            for edge in graph.edges {
                let relatedID: String?
                if edge.sourceThreadID == current.threadID {
                    relatedID = edge.targetThreadID
                } else if edge.targetThreadID == current.threadID {
                    relatedID = edge.sourceThreadID
                } else {
                    relatedID = nil
                }
                guard let relatedID, visited.insert(relatedID).inserted else { continue }
                let depth = current.depth + 1
                rows.append(
                    ThreadRelationshipRow(
                        threadID: relatedID,
                        fromThreadID: current.threadID,
                        depth: depth,
                        edge: edge
                    )
                )
                pending.append((relatedID, depth))
            }
        }
        return rows
    }

    /// The thread a fork merges back into. Only forks have one.
    public static func mergeBackTargetThreadID(_ thread: ThreadRelationshipShell?) -> String? {
        guard let thread, thread.relationshipToParent == "fork" else { return nil }
        return thread.forkedFromRunThreadID ?? thread.parentThreadID
    }

    // MARK: Presentation

    public static func label(_ edge: ThreadRelationshipEdge, currentThreadID: String) -> String {
        let outgoing = edge.sourceThreadID == currentThreadID
        switch edge.kind {
        case .transfer: return outgoing ? "Context sent to" : "Context received from"
        case .subagent: return outgoing ? "Subagent" : "Parent agent"
        case .fork: return outgoing ? "Fork" : "Forked from"
        }
    }

    public static func symbol(_ edge: ThreadRelationshipEdge) -> String {
        edge.kind == .transfer ? "arrow.left.arrow.right" : "arrow.triangle.branch"
    }

    /// Orb state for a subagent edge.
    ///
    /// Deliberately not `ThreadLifecycle`'s terminal test: an edge status is a
    /// thread/subagent status, where `pending` and `waiting` mean the agent is
    /// parked rather than working, and a parked agent reading as "active" would
    /// keep an orb animating with nothing behind it.
    public static func subagentOrbState(
        _ status: String?
    ) -> LifecyclePresentation.RelatedThread.OrbState {
        if status == "failed" { return .failed }
        if status == "running" { return .active }
        return .done
    }

    /// Why a related thread cannot be opened, or nil when it can.
    public static func availability(
        thread: ThreadRelationshipShell?,
        missing: Bool
    ) -> String? {
        if missing { return "Unavailable" }
        if thread?.deletedAt != nil { return "Deleted" }
        if thread?.archivedAt != nil { return "Archived" }
        return nil
    }
}

// MARK: - Decay

/// A finished subagent edge stays visible for a minute, then collapses into the
/// trailing "Done · N" group. Failed edges never auto-collapse: a failure is
/// exactly the row a user came here to find.
public struct ThreadRelationshipDecay: Equatable, Sendable {
    public static let window: TimeInterval = 60
    static let terminalStatuses: Set<String> = ["completed", "cancelled", "interrupted"]

    public struct Split: Equatable, Sendable {
        public let visible: [ThreadRelationshipRow]
        public let archived: [ThreadRelationshipRow]
        /// When the next row is due to collapse, so the caller can schedule one
        /// wake-up instead of polling.
        public let nextRefresh: Date?

        public init(
            visible: [ThreadRelationshipRow],
            archived: [ThreadRelationshipRow],
            nextRefresh: Date?
        ) {
            self.visible = visible
            self.archived = archived
            self.nextRefresh = nextRefresh
        }
    }

    private var expiries: [String: Date] = [:]
    private var hasObserved = false

    public init() {}

    public mutating func split(
        rows: [ThreadRelationshipRow],
        now: Date = Date()
    ) -> Split {
        var liveKeys: Set<String> = []
        for row in rows where row.edge.kind == .subagent {
            let key = row.id
            liveKeys.insert(key)
            if let status = row.edge.status, Self.terminalStatuses.contains(status) {
                if expiries[key] == nil {
                    // Edges already terminal on first observation go straight to
                    // the archived group; later completions linger for the
                    // decay window so the user sees the agent finish.
                    expiries[key] = hasObserved ? now.addingTimeInterval(Self.window) : .distantPast
                }
            } else {
                expiries[key] = nil
            }
        }
        // Snapshot the keys: the dictionary is mutated inside the loop.
        for key in Array(expiries.keys) where !liveKeys.contains(key) {
            expiries[key] = nil
        }
        hasObserved = true

        var visible: [ThreadRelationshipRow] = []
        var archived: [ThreadRelationshipRow] = []
        for row in rows {
            if let expiry = expiries[row.id], expiry <= now {
                archived.append(row)
            } else {
                visible.append(row)
            }
        }
        let nextRefresh = expiries.values.filter { $0 > now }.min()
        return Split(visible: visible, archived: archived, nextRefresh: nextRefresh)
    }
}

// MARK: - Banner model

/// Everything the banner and its lineage sheet render, derived once.
public struct ThreadRelationshipsModel: Equatable, Sendable {
    public let currentThreadID: String
    public let graph: ThreadRelationshipGraph
    /// Merge-back target first, otherwise graph order.
    public let rows: [ThreadRelationshipRow]
    public let mergeTargetThreadID: String?
    public let latestMergeBackRunID: String?
    public let canMerge: Bool
    public let canDetach: Bool
    public let subagentsByChildThreadID: [String: ThreadRelationshipSubagentLink]
    /// The row the collapsed banner speaks for: an incoming edge if there is
    /// one, because "Forked from X" says more than "Fork: Y".
    public let primaryRow: ThreadRelationshipRow?
    public let summary: String

    /// Nothing to say and nothing to disconnect — the banner hides entirely.
    public var isEmpty: Bool { rows.isEmpty && !canDetach }

    public func title(for threadID: String) -> String {
        graph.node(threadID)?.thread?.title ?? threadID
    }

    public func availability(for threadID: String) -> String? {
        let node = graph.node(threadID)
        return ThreadRelationships.availability(
            thread: node?.thread, missing: node?.missing ?? true
        )
    }

    public func subagent(for threadID: String) -> ThreadRelationshipSubagentLink? {
        subagentsByChildThreadID[threadID]
    }
}

public extension ThreadRelationships {
    /// - Parameters:
    ///   - threads: Live shells first, then archived snapshots.
    ///   - currentThread: The open thread, used for the merge-back target.
    ///   - runs: The open thread's runs, used for the merge-back run.
    ///   - providerSession: The session `ThreadWorkflows.resolveProviderSession`
    ///     picked, used for the detach affordance.
    static func build(
        currentThreadID: String,
        currentThread: ThreadRelationshipShell?,
        threads: [ThreadRelationshipShell],
        subagents: [ThreadRelationshipSubagentLink] = [],
        transfers: [ThreadRelationshipTransferLink] = [],
        runs: [ThreadWorkflowRun] = [],
        providerSession: ThreadWorkflowSession? = nil
    ) -> ThreadRelationshipsModel {
        let graph = deriveGraph(
            threads: threads,
            ownerThreadID: currentThreadID,
            subagents: subagents,
            transfers: transfers
        )
        let mergeTargetThreadID = mergeBackTargetThreadID(currentThread)
        let unsorted = immediateRelationships(graph: graph, threadID: currentThreadID)
        // A stable partition rather than a sort: only the merge target moves,
        // and everything else keeps deterministic graph order.
        let rows =
            unsorted.filter { $0.threadID == mergeTargetThreadID }
            + unsorted.filter { $0.threadID != mergeTargetThreadID }

        let latestMergeBackRun = ThreadWorkflows.resolveLatestMergeBackRun(runs: runs)
        var index: [String: ThreadRelationshipSubagentLink] = [:]
        for subagent in subagents {
            guard let childThreadID = subagent.childThreadID else { continue }
            index[childThreadID] = subagent
        }

        let primaryRow = rows.first { $0.edge.targetThreadID == currentThreadID } ?? rows.first
        let summary: String
        if let primaryRow {
            let title = graph.node(primaryRow.threadID)?.thread?.title ?? "related thread"
            summary = "\(label(primaryRow.edge, currentThreadID: currentThreadID)): \(title)"
        } else {
            summary = "Agent session connected"
        }

        return ThreadRelationshipsModel(
            currentThreadID: currentThreadID,
            graph: graph,
            rows: rows,
            mergeTargetThreadID: mergeTargetThreadID,
            latestMergeBackRunID: latestMergeBackRun?.id,
            canMerge: mergeTargetThreadID != nil && latestMergeBackRun != nil,
            canDetach: ThreadWorkflows.canDetachProviderSession(providerSession),
            subagentsByChildThreadID: index,
            primaryRow: primaryRow,
            summary: summary
        )
    }
}
