import Foundation

/// Which diff a thread's review is showing.
///
/// `ReviewSelection` stores the selected section as an opaque string so the
/// store's rules stay testable without the wire; this is the one place that
/// knows what those strings mean.
///
/// The web and React Native clients key a turn section by turn count
/// (`turn:<checkpointTurnCount>` — apps/mobile/src/features/review/reviewModel.ts),
/// because they build the section list from the checkpoint table and have the
/// count in hand. This client's section arrives from a timeline row's "Open
/// diff", which carries a checkpoint id and nothing else, so the id is what is
/// stored and the turn count is resolved from the projection at load time.
public enum ReviewSectionID: Hashable, Sendable {
    /// The workspace as it stands right now, from `review.getDiffPreview`.
    case workingTree
    /// The diff one checkpoint captured.
    case checkpoint(id: String)

    private static let workingTreeRawValue = "git:working-tree"
    private static let checkpointPrefix = "checkpoint:"

    public var rawValue: String {
        switch self {
        case .workingTree: Self.workingTreeRawValue
        case let .checkpoint(id): Self.checkpointPrefix + id
        }
    }

    /// `nil` for a section id this build does not understand, which callers
    /// treat as "no checkpoint selected" rather than guessing at a scope.
    public init?(rawValue: String) {
        if rawValue == Self.workingTreeRawValue {
            self = .workingTree
            return
        }
        guard rawValue.hasPrefix(Self.checkpointPrefix) else { return nil }
        let id = String(rawValue.dropFirst(Self.checkpointPrefix.count))
        guard !id.isEmpty else { return nil }
        self = .checkpoint(id: id)
    }

    public var checkpointID: String? {
        guard case let .checkpoint(id) = self else { return nil }
        return id
    }
}

/// The turn-count range one checkpoint's diff is addressed by.
///
/// `orchestration.getTurnDiff` takes a range of *turn counts*, not checkpoint
/// ids, so a checkpoint has to be translated before it can be asked for.
public struct CheckpointTurnRange: Equatable, Sendable {
    public let fromTurnCount: Int
    public let toTurnCount: Int

    public init(fromTurnCount: Int, toTurnCount: Int) {
        self.fromTurnCount = fromTurnCount
        self.toTurnCount = toTurnCount
    }

    /// The first turn's diff starts from the thread's synthetic baseline
    /// checkpoint, which `getTurnDiff` cannot address on its own: it looks the
    /// `from` end up by `appRunOrdinal`, and the baseline has none. The server
    /// materialises that end only inside `getFullThreadDiff`
    /// (apps/server/src/checkpointing/CheckpointDiffQuery.ts), so a range that
    /// starts at 0 has to go through the full-thread call. Both replies are the
    /// same `ThreadTurnDiff`.
    public var needsFullThreadDiff: Bool { fromTurnCount == 0 }
}

/// Why a checkpoint could not be turned into a turn range.
///
/// Surfaced rather than swallowed: the working tree is *not* an acceptable
/// stand-in for a checkpoint's diff, so every one of these has to reach the
/// reader as itself.
public struct CheckpointTurnRangeUnresolved: LocalizedError, Equatable, Sendable {
    public enum Reason: Equatable, Sendable {
        /// No checkpoint row and no checkpoint item with this id. The projection
        /// the review is reading is not the one the timeline row came from.
        case unknownCheckpoint
        /// The server has the checkpoint but its snapshot is not usable.
        case notReady(status: String)
        /// The row was projected in from another thread, whose runs this
        /// projection does not carry — the ordinal would be read off the wrong
        /// thread's run table.
        case inheritedFromAnotherThread(sourceThreadID: String)
        /// The checkpoint item has no run, or the run is not in this projection.
        /// `appRunOrdinal` is the run's ordinal, so without the run there is no
        /// turn count.
        case runUnavailable
    }

    public let checkpointID: String
    public let reason: Reason

    public init(checkpointID: String, reason: Reason) {
        self.checkpointID = checkpointID
        self.reason = reason
    }

    public var errorDescription: String? {
        switch reason {
        case .unknownCheckpoint:
            "This checkpoint is no longer in the thread's history, so its diff cannot be loaded."
        case let .notReady(status):
            "This checkpoint's snapshot is \(status), so its diff cannot be loaded."
        case .inheritedFromAnotherThread:
            "This checkpoint belongs to another thread, so its diff has to be opened from there."
        case .runUnavailable:
            "This checkpoint is not attached to a turn, so its diff cannot be loaded."
        }
    }
}

/// Translates a checkpoint id into the turn range `orchestration.getTurnDiff`
/// is addressed by.
///
/// The derivation is the one the web and React Native clients use:
/// `fromTurnCount = max(0, checkpointTurnCount - 1)`, `toTurnCount =
/// checkpointTurnCount` (apps/web/src/components/DiffPanel.tsx and
/// apps/mobile/src/features/review/useReviewSections.ts), where
/// `checkpointTurnCount` is the checkpoint's `appRunOrdinal`
/// (packages/client-runtime/src/state/threadCheckpoints.ts).
///
/// This client reads that ordinal one hop further out. `OrchestrationV2Checkpoint`
/// as modelled here carries id, scope, status and files but not `appRunOrdinal`,
/// and the server stamps `appRunOrdinal: run.ordinal` when it captures
/// (apps/server/src/orchestration-v2/CheckpointCaptureService.ts), so the
/// checkpoint's own turn item names the run and the run names the ordinal. That
/// is the same number, not a parallel numbering.
public enum CheckpointTurnRangeResolver {
    public static func range(
        forCheckpoint checkpointID: String,
        in projection: OrchestrationV2ThreadProjection
    ) throws -> CheckpointTurnRange {
        func unresolved(_ reason: CheckpointTurnRangeUnresolved.Reason) -> Error {
            CheckpointTurnRangeUnresolved(checkpointID: checkpointID, reason: reason)
        }

        // A checkpoint the server has already marked unusable would come back
        // from `getTurnDiff` as a ref-unavailable failure; saying so up front
        // names the checkpoint rather than the RPC.
        if let row = projection.checkpoints.first(where: { $0.id == checkpointID }),
            row.status != "ready" {
            throw unresolved(.notReady(status: row.status))
        }

        guard let item = checkpointItem(checkpointID, in: projection) else {
            throw unresolved(.unknownCheckpoint)
        }
        guard item.base.threadId == projection.thread.id else {
            throw unresolved(.inheritedFromAnotherThread(sourceThreadID: item.base.threadId))
        }
        guard let runID = item.base.runId,
            let run = projection.runs.first(where: { $0.id == runID }),
            run.ordinal > 0 else {
            throw unresolved(.runUnavailable)
        }

        return CheckpointTurnRange(
            fromTurnCount: max(0, run.ordinal - 1),
            toTurnCount: run.ordinal
        )
    }

    /// The checkpoint's own turn item, which is where the run id lives.
    ///
    /// `turnItems` is the thread's own table; `visibleTurnItems` additionally
    /// carries rows projected in from other threads, and the timeline renders
    /// from that list, so a row the reader can tap may only exist there.
    private static func checkpointItem(
        _ checkpointID: String,
        in projection: OrchestrationV2ThreadProjection
    ) -> OrchestrationV2TurnItem? {
        func matches(_ item: OrchestrationV2TurnItem) -> Bool {
            guard case let .checkpoint(id, _, _) = item.payload else { return false }
            return id == checkpointID
        }

        return projection.turnItems.first(where: matches)
            ?? projection.visibleTurnItems.map(\.item).first(where: matches)
    }
}
