import Foundation

/// Threads opened from inside another thread (a subagent card, a fork divider,
/// a lineage row, "Open parent"), so Back returns to the thread that opened
/// them instead of to the list. One per tab; picking a thread from the list,
/// or leaving to the list, starts over. The thread column renders it as a
/// navigation stack, so Back and the edge swipe are the system's own.
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

    /// The thread column's navigation: the first thread of the trail is the
    /// stack's root and the rest, ending at `current`, are pushed over it.
    func route(current: String) -> (root: String, path: [String]) {
        let trail = threadIDs + [current]
        return (trail[0], Array(trail.dropFirst()))
    }

    /// The system popped (back button or edge swipe) to the thread at `level`
    /// of the trail, 0 being the root: returns it and forgets everything that
    /// was above it. Nil when nothing was popped.
    mutating func popTo(level: Int) -> String? {
        guard threadIDs.indices.contains(level) else { return nil }
        let id = threadIDs[level]
        threadIDs.removeSubrange(level...)
        return id
    }

    /// The thread to go back to, skipping any deleted since they were left.
    mutating func pop(where exists: (String) -> Bool) -> String? {
        while let last = threadIDs.popLast() {
            if exists(last) { return last }
        }
        return nil
    }
}

/// A thread pushed over another in the thread column.
struct ThreadNavigationRoute: Hashable {
    let threadID: String
}
