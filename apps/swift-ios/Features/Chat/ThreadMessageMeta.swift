import Foundation

// Per-message facts the transcript shows around a bubble — its time, a failed
// or interrupted status, and whether it can be restored to or forked from —
// resolved once per detail revision from the projection, not in `body`.
// Mirrors web's `UserTimelineRow` / `AssistantTimelineRow` rules in
// apps/web/src/components/chat/MessagesTimeline.tsx.

/// A message that did not complete: the small pill beside its time.
struct ThreadMessageStatusPill: Equatable, Sendable {
    enum Tone: Equatable, Sendable { case danger, neutral }

    let label: String
    let tone: Tone

    /// Only settled outcomes other than success. In-flight statuses already
    /// have the working band; a pill for them would lie as soon as it lands.
    static func resolve(_ status: OrchestrationV2TurnItemStatus) -> ThreadMessageStatusPill? {
        switch status {
        case .failed: ThreadMessageStatusPill(label: "Failed", tone: .danger)
        case .interrupted: ThreadMessageStatusPill(label: "Interrupted", tone: .neutral)
        case .cancelled: ThreadMessageStatusPill(label: "Cancelled", tone: .neutral)
        case .completed, .pending, .running, .waiting, .unknown: nil
        }
    }
}

/// When a message was sent or a reply finished, said quietly under it.
struct ThreadMessageTimestamp: Equatable, Sendable {
    let date: Date
    /// Time of day for today, then "Yesterday at …", then the date: the first
    /// message of a thread has no day divider above it to date it.
    let label: String
    /// "Today at 9:41 AM" or the full date, for the long-press menu and
    /// VoiceOver.
    let fullLabel: String

    init(date: Date, now: Date = .now, calendar: Calendar = .current) {
        self.date = date
        let time = date.formatted(date: .omitted, time: .shortened)
        let day = ThreadTimelineDay.key(for: date, calendar: calendar)
        let yesterday = calendar.date(byAdding: .day, value: -1, to: now).map { ThreadTimelineDay.key(for: $0, calendar: calendar) }
        if day == ThreadTimelineDay.key(for: now, calendar: calendar) {
            label = time
            fullLabel = "Today at \(time)"
        } else if day == yesterday {
            label = "Yesterday at \(time)"
            fullLabel = label
        } else {
            let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
            var style = Date.FormatStyle.dateTime.month(.abbreviated).day().hour().minute()
            if !sameYear { style = style.year() }
            style.calendar = calendar
            style.timeZone = calendar.timeZone
            label = date.formatted(style)
            fullLabel = date.formatted(date: .long, time: .shortened)
        }
    }
}

/// Where "Fork from Here" forks: the end of the reply's run, in the thread the
/// row came from (an inherited row names its parent).
struct ThreadMessageForkPoint: Equatable, Sendable {
    let messageID: String
    /// Wire id.
    let sourceThreadID: String
    let runID: String
    /// The provider forks only at its head, so the fork takes the latest
    /// stable point and says so.
    let latestOnly: Bool

    var title: String { latestOnly ? "Fork Latest Conversation" : "Fork from Here" }
}

/// What "Restore to Here…" rolls back to: the checkpoint captured before the
/// message's turn started, which deletes the message and everything after it.
struct ThreadMessageRestorePoint: Equatable, Sendable {
    let messageID: String
    let target: ThreadActivityRollbackTarget
    /// The run ordinal the target was captured at; 0 is the scope's baseline.
    let targetOrdinal: Int
}

struct ThreadMessageMeta: Equatable, Sendable {
    var timestamp: ThreadMessageTimestamp?
    var status: ThreadMessageStatusPill?
    var restore: ThreadMessageRestorePoint?
    var fork: ThreadMessageForkPoint?
}

enum ThreadMessageMetaResolver {
    static func resolve(_ detail: FeatureThreadDetail, now: Date = .now, calendar: Calendar = .current) -> [String: ThreadMessageMeta] {
        resolve(
            timelineItems: detail.timelineItems,
            checkpoints: detail.checkpoints,
            itemSupport: detail.itemSupport,
            threadID: detail.thread.id,
            activeRunID: detail.workflow.queueState.activeRun?.id,
            latestRunID: detail.workflow.runs.max { $0.ordinal < $1.ordinal }?.id,
            isWorking: detail.thread.state == .working || detail.thread.state == .queued,
            now: now,
            calendar: calendar
        )
    }

    /// Keyed by turn item id, which is the transcript's message id.
    static func resolve(
        timelineItems: [OrchestrationV2ProjectedTurnItem],
        checkpoints: [OrchestrationV2Checkpoint],
        itemSupport: [String: ThreadActivityItemSupport],
        threadID: String,
        activeRunID: String?,
        latestRunID: String?,
        isWorking: Bool,
        now: Date = .now,
        calendar: Calendar = .current
    ) -> [String: ThreadMessageMeta] {
        var metas: [String: ThreadMessageMeta] = [:]
        // `deriveTerminalAssistantMessageIds`: the last reply of each run, or
        // of each stretch between user messages for runless replies.
        var lastAssistantByResponse: [String: OrchestrationV2ProjectedTurnItem] = [:]
        var runlessIndex = 0
        let restore = RestoreResolver(checkpoints: checkpoints, threadID: threadID)

        for projected in timelineItems {
            let item = projected.item
            switch item.payload {
            case let .userMessage(_, intent, _, _):
                runlessIndex += 1
                var meta = ThreadMessageMeta()
                if let date = ThreadTimelineDay.date(fromISO8601: item.base.startedAt ?? item.base.updatedAt) {
                    meta.timestamp = ThreadMessageTimestamp(date: date, now: now, calendar: calendar)
                }
                meta.status = ThreadMessageStatusPill.resolve(item.status)
                if intent == .turnStart || intent == .queuedTurn, let runID = item.base.runId {
                    meta.restore = restore.point(messageID: item.id, runID: runID)
                }
                metas[item.id] = meta
            case .assistantMessage:
                let key = item.base.runId.map { "run:\($0)" } ?? "runless:\(runlessIndex)"
                lastAssistantByResponse[key] = projected
                if let status = ThreadMessageStatusPill.resolve(item.status) {
                    metas[item.id, default: ThreadMessageMeta()].status = status
                }
            default:
                break
            }
        }

        for projected in lastAssistantByResponse.values {
            let item = projected.item
            // While the turn runs its latest reply is only provisionally the
            // last, so the time and the fork wait for the turn to settle.
            let unsettled = item.base.runId.map { $0 == activeRunID } ?? isWorking
            guard !unsettled else { continue }
            var meta = metas[item.id] ?? ThreadMessageMeta()
            if let date = ThreadTimelineDay.date(fromISO8601: item.base.completedAt ?? item.base.updatedAt) {
                meta.timestamp = ThreadMessageTimestamp(date: date, now: now, calendar: calendar)
            }
            if item.status == .completed, let runID = item.base.runId {
                let capabilities = itemSupport[projected.id]?.providerSession?.fork
                // No descriptor is no evidence: historical and inherited rows
                // can outlive their session, and the server can still fork them.
                if capabilities?.allowsFork(isLatestRun: runID == latestRunID) ?? true {
                    meta.fork = ThreadMessageForkPoint(
                        messageID: item.id,
                        sourceThreadID: projected.sourceThreadId,
                        runID: runID,
                        latestOnly: capabilities?.forksLatestOnly ?? false
                    )
                }
            }
            metas[item.id] = meta
        }
        return metas
    }

    /// `deriveRevertTurnCountByUserMessageId` and `revertThreadCheckpoint`:
    /// the message's run has a ready checkpoint at ordinal N, and the restore
    /// goes to the ready checkpoint at N − 1 (the scope baseline for N = 1).
    private struct RestoreResolver {
        let readyByRunID: [String: OrchestrationV2Checkpoint]
        let checkpoints: [OrchestrationV2Checkpoint]
        let threadID: String

        init(checkpoints: [OrchestrationV2Checkpoint], threadID: String) {
            var ready: [String: OrchestrationV2Checkpoint] = [:]
            for checkpoint in checkpoints where checkpoint.status == "ready" && checkpoint.appRunOrdinal != nil {
                if let runID = checkpoint.runId { ready[runID] = checkpoint }
            }
            readyByRunID = ready
            self.checkpoints = checkpoints
            self.threadID = threadID
        }

        func point(messageID: String, runID: String) -> ThreadMessageRestorePoint? {
            guard let ordinal = readyByRunID[runID]?.appRunOrdinal else { return nil }
            let targetOrdinal = max(0, ordinal - 1)
            guard let target = checkpoints.last(where: { candidate in
                targetOrdinal == 0
                    ? candidate.ordinalWithinScope == 0 && candidate.appRunOrdinal == nil
                    : candidate.appRunOrdinal == targetOrdinal
            }), target.status == "ready" else { return nil }
            return ThreadMessageRestorePoint(
                messageID: messageID,
                target: ThreadActivityRollbackTarget(threadID: threadID, checkpointID: target.id, scopeID: target.scopeId),
                targetOrdinal: targetOrdinal
            )
        }
    }
}

extension CheckpointRestoreRequest {
    /// The preview for restoring to before a message: the files the later
    /// turns touched return, the message and every exchange after it go, and
    /// newer restore points in the scope die.
    static func beforeMessage(
        _ point: ThreadMessageRestorePoint,
        timelineItems: [OrchestrationV2ProjectedTurnItem],
        checkpoints: [OrchestrationV2Checkpoint]
    ) -> CheckpointRestoreRequest {
        let start = timelineItems.firstIndex { $0.item.id == point.messageID } ?? timelineItems.endIndex
        var files: [OrchestrationV2CheckpointFileSummary] = []
        var fileIndex: [String: Int] = [:]
        var exchanges = 0
        for projected in timelineItems[start...] {
            switch projected.item.payload {
            case .userMessage:
                exchanges += 1
            case let .checkpoint(_, scopeID, itemFiles) where scopeID == point.target.scopeID:
                for file in itemFiles {
                    if let index = fileIndex[file.path] {
                        let previous = files[index]
                        files[index] = OrchestrationV2CheckpointFileSummary(
                            path: file.path,
                            kind: file.kind,
                            additions: previous.additions + file.additions,
                            deletions: previous.deletions + file.deletions
                        )
                    } else {
                        fileIndex[file.path] = files.count
                        files.append(file)
                    }
                }
            default:
                break
            }
        }
        let newer = checkpoints.filter {
            $0.scopeId == point.target.scopeID && $0.status == "ready" && ($0.appRunOrdinal ?? 0) > point.targetOrdinal
        }.count
        let capturedAt = checkpoints.first { $0.id == point.target.checkpointID }?.capturedAt
            .flatMap(ThreadTimelineDay.date(fromISO8601:))
        return CheckpointRestoreRequest(
            target: point.target,
            files: files,
            exchangesAfter: exchanges,
            newerRestorePoints: newer,
            capturedAtLabel: capturedAt?.formatted(date: .omitted, time: .shortened)
        )
    }
}
