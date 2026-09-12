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
    var offsetWithinAnchor: Double = 0

    func rememberViewport(rows: [ThreadWorkLogRowFrame], contentOffset: Double) {
        guard let anchor = ThreadWorkLogViewportAnchor.capture(rows: rows, contentOffset: contentOffset) else { return }
        if anchorID != anchor.id || abs(offsetWithinAnchor - anchor.offset) > 0.5 {
            anchorID = anchor.id
            offsetWithinAnchor = anchor.offset
        }
    }

    func clearViewport() { anchorID = nil; offsetWithinAnchor = 0 }
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

struct ThreadWorkLogRowFrame: Equatable, Sendable {
    let id: String
    let minY: Double
    let height: Double
}

struct ThreadWorkLogViewportAnchor: Equatable, Sendable {
    let id: String
    let offset: Double

    static func capture(rows: [ThreadWorkLogRowFrame], contentOffset: Double) -> Self? {
        guard contentOffset.isFinite else { return nil }
        let frames = rows.filter { $0.minY.isFinite && $0.height.isFinite && $0.height > 0 }
        let row = frames.filter { $0.minY <= contentOffset && $0.minY + $0.height > contentOffset }.max { $0.minY < $1.minY }
            ?? frames.filter { $0.minY >= contentOffset }.min { $0.minY < $1.minY }
        guard let row else { return nil }
        return Self(id: row.id, offset: max(0, contentOffset - row.minY))
    }

    func restoredOffset(in row: ThreadWorkLogRowFrame) -> Double? {
        guard row.id == id, row.minY.isFinite, row.height.isFinite, row.height > 0, offset.isFinite else { return nil }
        return max(0, row.minY + min(max(0, offset), max(0, row.height - 1)))
    }
}
