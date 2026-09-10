import Foundation
import Observation

public struct ThreadWorkLogExpansion: Equatable, Sendable {
    private var openedIDs: Set<String> = []
    private var closedIDs: Set<String> = []

    public init() {}

    public func isExpanded(_ id: String, expandedByDefault: Bool) -> Bool {
        if closedIDs.contains(id) { return false }
        return expandedByDefault || openedIDs.contains(id)
    }

    /// Records what the reader asked for, against what they can currently see:
    /// toggling a row the preference opened has to register as a close, not as
    /// the absence of an open.
    public mutating func toggle(_ id: String, expandedByDefault: Bool) {
        if isExpanded(id, expandedByDefault: expandedByDefault) {
            openedIDs.remove(id)
            closedIDs.insert(id)
        } else {
            closedIDs.remove(id)
            openedIDs.insert(id)
        }
    }
}


/// Each transcript coordinator owns one cache, independent of recycled cells.
@MainActor @Observable
final class ThreadWorkLogHistory {
    var groupExpanded: Bool?
    var rowExpansion = ThreadWorkLogExpansion()
    var anchorID: String?
}

@MainActor
final class ThreadWorkLogHistoryStore {
    private var entries: [String: ThreadWorkLogHistory] = [:]
    private var insertionOrder: [String] = []
    private let limit: Int

    init(limit: Int = 1000) { self.limit = max(1, limit) }

    func entry(_ key: String) -> ThreadWorkLogHistory {
        if let existing = entries[key] { return existing }
        let value = ThreadWorkLogHistory()
        entries[key] = value
        insertionOrder.append(key)
        while insertionOrder.count > limit { entries.removeValue(forKey: insertionOrder.removeFirst()) }
        return value
    }
}
