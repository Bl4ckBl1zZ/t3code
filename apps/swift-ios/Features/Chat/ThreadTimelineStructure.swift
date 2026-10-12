import SwiftUI

/// Rows the feed derives from the transcript's shape rather than from a single
/// turn item: a run of agent updates, a superseded
/// attempt folded away, and a turn's changed files under its reply.
///
/// One `ThreadTimelineEntry` case carries all of them, so a new structural row
/// adds a case here instead of touching every switch over the entry.
enum ThreadTimelineStructuralRow: Equatable {
    case agentUpdates(ThreadAgentUpdates)
    case attemptFold(ThreadAttemptFold)
    case changedFiles(ThreadChangedFiles)

    var id: String {
        switch self {
        case let .agentUpdates(updates): updates.id
        case let .attemptFold(fold): fold.id
        case let .changedFiles(files): files.id
        }
    }

    var date: Date? {
        switch self {
        case let .agentUpdates(updates): updates.date
        case let .attemptFold(fold): fold.date
        case let .changedFiles(files): files.date
        }
    }

    /// How a settled turn's fold treats the row: changed files stay under the
    /// reply, a superseded attempt folds with the rest of its run, and the
    /// others belong to no run.
    func turnFoldItem(entryID: String, date: Date?) -> ThreadTurnFoldItem {
        switch self {
        case .agentUpdates:
            ThreadTurnFoldItem(id: entryID, runID: nil, kind: .user, date: date)
        case let .attemptFold(fold):
            ThreadTurnFoldItem(id: entryID, runID: fold.runID, kind: .work, date: date)
        case let .changedFiles(files):
            ThreadTurnFoldItem(id: entryID, runID: files.runID, kind: .persistent, date: date)
        }
    }
}

/// Renders a structural row. Each row owns its bottom margin, like every other
/// entry in the transcript.
struct ThreadTimelineStructuralRowView: View {
    let row: ThreadTimelineStructuralRow
    let currentThreadID: String
    let workspaceRoot: String?
    let onOpenThread: (String) -> Void
    let onOpenFile: (ThreadActivityFileOpenRequest) -> Void
    let onOpenDiff: (String, String?) -> Void
    let onToggleFold: (String) -> Void

    var body: some View {
        switch row {
        case let .agentUpdates(updates):
            ThreadAgentUpdatesGroup(
                updates: updates,
                currentThreadID: currentThreadID,
                onOpenThread: onOpenThread
            )
        case let .attemptFold(fold):
            ThreadAttemptFoldRow(fold: fold) { onToggleFold(fold.expansionKey) }
        case let .changedFiles(files):
            ChangedFilesTreeCard(
                files: files,
                currentThreadID: currentThreadID,
                workspaceRoot: workspaceRoot,
                onOpenFile: onOpenFile,
                onOpenDiff: onOpenDiff
            )
        }
    }
}
