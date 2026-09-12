import Foundation

struct ThreadLiveWorkItem: Equatable {
    let id: String
    let runID: String?
    let running: Bool
    let successful: Bool
    let background: Bool
    let boundary: Bool
}

/// A successful foreground operation remains the focus until the next message;
/// failed, interrupted and background-only work must not claim the agent's focus.
enum ThreadLiveWorkFocus {
    static func selection(items: [ThreadLiveWorkItem], activeRunID: String?) -> String? {
        guard let activeRunID, !items.isEmpty,
              items.allSatisfy({ $0.runID == activeRunID && !$0.boundary }) else { return nil }
        let foreground = items.filter { !$0.background }
        if let running = foreground.last(where: \.running) { return running.id }
        guard let last = foreground.last, last.successful else { return nil }
        return last.id
    }
}
