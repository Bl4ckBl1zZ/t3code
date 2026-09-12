import Foundation

struct ThreadTurnFoldItem: Equatable, Sendable {
    enum Kind: Sendable { case user, assistant, work, persistent, other }
    let id: String
    let runID: String?
    let kind: Kind
    var isLive = false
    var isPersistent = false
    var date: Date? = nil
}

struct ThreadTurnFoldRun: Sendable {
    let id: String
    let status: String
    var startedAt: Date? = nil
    var completedAt: Date? = nil
}

struct ThreadTurnFold: Equatable, Sendable {
    let runID: String
    let anchorID: String
    let hiddenIDs: Set<String>
    let label: String
    let date: Date?
    var isExpanded: Bool
    var id: String { "turn-fold:\(runID)" }
}

/// Completed runs retain their final response and persistent/live resources.
/// Unknown, failed and interrupted runs stay visible so evidence is never hidden.
enum ThreadTurnFolding {
    static func folds(items: [ThreadTurnFoldItem], runs: [ThreadTurnFoldRun],
                      interruptedRunIDs: Set<String> = [], expandedRunIDs: Set<String> = []) -> [ThreadTurnFold] {
        var runsByID: [String: ThreadTurnFoldRun] = [:]
        for run in runs { runsByID[run.id] = run }
        var groups: [String: [ThreadTurnFoldItem]] = [:]
        var order: [String] = []
        for item in items {
            guard let runID = item.runID, item.kind != .user, item.kind != .other else { continue }
            if groups[runID] == nil { order.append(runID) }
            groups[runID, default: []].append(item)
        }
        return order.compactMap { runID in
            guard let run = runsByID[runID], run.status == "completed",
                  !interruptedRunIDs.contains(runID), let group = groups[runID],
                  !group.contains(where: { $0.kind == .assistant && $0.isLive }),
                  let terminal = group.last(where: { $0.kind == .assistant }) else { return nil }
            let hidden = group.filter { $0.id != terminal.id && $0.kind != .persistent && !$0.isPersistent && !$0.isLive }
            guard let anchor = hidden.first else { return nil }
            let start = run.startedAt ?? group.first?.date
            let end = run.completedAt ?? group.last?.date
            let label: String
            if let start, let end, end >= start {
                let seconds = Int(end.timeIntervalSince(start))
                let duration = seconds >= 3600 ? "\(seconds / 3600)h \((seconds % 3600) / 60)m" :
                    seconds >= 60 ? "\(seconds / 60)m \(seconds % 60)s" : "\(seconds)s"
                label = "Worked for \(duration)"
            } else { label = "Earlier work" }
            return ThreadTurnFold(runID: runID, anchorID: anchor.id,
                hiddenIDs: Set(hidden.map(\.id)), label: label, date: anchor.date,
                isExpanded: expandedRunIDs.contains(runID))
        }
    }
}
