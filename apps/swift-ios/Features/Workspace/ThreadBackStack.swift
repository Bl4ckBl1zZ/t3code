import Foundation

/// Threads opened from inside another thread (a subagent card, a fork divider,
/// a lineage row, "Open parent"), so Back returns to the thread that opened
/// them instead of to the list. One per tab; picking a thread from the list,
/// or leaving to the list, starts over.
struct ThreadBackStack: Equatable {
    /// Deep enough for an agent's agent's agent; old entries fall off the bottom.
    static let limit = 20

    private(set) var threadIDs: [String] = []

    /// The thread Back returns to.
    var parentID: String? { threadIDs.last }

    /// `current` opened `target`. Opening a thread already below on the stack,
    /// such as a subagent's "Open parent", returns to it rather than pushing a
    /// loop.
    mutating func open(_ target: String, from current: String?) {
        guard let current, current != target else { return }
        if let index = threadIDs.lastIndex(of: target) {
            threadIDs.removeSubrange(index...)
            return
        }
        threadIDs.append(current)
        if threadIDs.count > Self.limit {
            threadIDs.removeFirst(threadIDs.count - Self.limit)
        }
    }

    /// The thread to go back to, skipping any deleted since they were left.
    mutating func pop(where exists: (String) -> Bool) -> String? {
        while let last = threadIDs.popLast() {
            if exists(last) { return last }
        }
        return nil
    }
}
