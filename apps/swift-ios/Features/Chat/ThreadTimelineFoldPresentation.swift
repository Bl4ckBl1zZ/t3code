import Foundation

/// Folding changes collection-view rows, so expanded content remains recycled
/// instead of materializing an entire run inside one SwiftUI disclosure cell.
enum ThreadTimelineFoldPresentation {
    struct Result {
        let entries: [ThreadTimelineEntry]
        let hiddenCitationRunIDs: [String: String]
    }

    static func apply(entries: [ThreadTimelineEntry], detail: FeatureThreadDetail,
                      expandedRunIDs: Set<String>, alwaysExpand: Bool) -> Result {
        guard !alwaysExpand else { return Result(entries: entries, hiddenCitationRunIDs: [:]) }
        var itemsByID: [String: OrchestrationV2TurnItem] = [:]
        var interruptedRunIDs = Set<String>()
        for projected in detail.timelineItems {
            itemsByID[projected.item.id] = projected.item
            if ["run_interrupt_request", "run_interrupt_result"].contains(projected.item.type),
               let runID = projected.item.base.runId { interruptedRunIDs.insert(runID) }
        }
        let items = entries.map { entry -> ThreadTurnFoldItem in
            switch entry {
            case let .message(message):
                return ThreadTurnFoldItem(id: entry.id, runID: itemsByID[message.id]?.base.runId,
                    kind: message.role == .assistant ? .assistant : .user,
                    isLive: message.state == .streaming, isPersistent: !message.attachments.isEmpty,
                    date: entry.date)
            case let .workLog(work):
                let runIDs = Set(work.rows.compactMap(\.runID))
                return ThreadTurnFoldItem(id: entry.id, runID: runIDs.count == 1 ? runIDs.first : nil,
                    kind: .work, isLive: work.rows.contains(where: \.inProgress), date: entry.date)
            case .lifecycle, .dayDivider, .turnFold:
                return ThreadTurnFoldItem(id: entry.id, runID: nil, kind: .persistent, date: entry.date)
            }
        }
        let runs = detail.workflow.runs.map { run in
            ThreadTurnFoldRun(id: run.id, status: run.status,
                startedAt: run.startedAt.flatMap { ThreadTimelineDay.date(fromISO8601: $0) },
                completedAt: run.completedAt.flatMap { ThreadTimelineDay.date(fromISO8601: $0) })
        }
        let folds = ThreadTurnFolding.folds(items: items, runs: runs,
            interruptedRunIDs: interruptedRunIDs, expandedRunIDs: expandedRunIDs)
        var foldsByHiddenID: [String: ThreadTurnFold] = [:]
        for fold in folds { for id in fold.hiddenIDs { foldsByHiddenID[id] = fold } }
        var result: [ThreadTimelineEntry] = []
        var hiddenCitationRunIDs: [String: String] = [:]
        var pendingDivider: ThreadTimelineEntry?
        func append(_ entry: ThreadTimelineEntry) {
            if let divider = pendingDivider { result.append(divider); pendingDivider = nil }
            result.append(entry)
        }
        for entry in entries {
            if case .dayDivider = entry { pendingDivider = entry; continue }
            if let fold = foldsByHiddenID[entry.id] {
                if fold.anchorID == entry.id { append(.turnFold(fold)) }
                if !fold.isExpanded {
                    if case let .message(message) = entry {
                        hiddenCitationRunIDs[message.wireMessageID ?? message.id] = fold.runID
                        hiddenCitationRunIDs[message.id] = fold.runID
                    }
                    continue
                }
            }
            append(entry)
        }
        return Result(entries: result, hiddenCitationRunIDs: hiddenCitationRunIDs)
    }
}
