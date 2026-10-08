import Foundation

// The user-arranged pinned run, as web orders it
// (`applyDurableThreadOrder` and `planDurableThreadReorder` in
// packages/client-runtime/src/state/threadSort.ts, `topOfPinnedRunOrderKey` in
// apps/web/src/hooks/useThreadActions.ts).

extension DailyUXSidebarIndex {
    /// Arranged pins first by `pinOrderKey` (plain string order, id breaking a
    /// tie), then pins that never got a key — pinned before reordering
    /// existed, or on a server without it — in the active shelf's newest-first
    /// order, so they keep a stable place below the arranged ones.
    static func pinnedOrder(_ lhs: FeatureThread, _ rhs: FeatureThread) -> Bool {
        switch (lhs.pinOrderKey, rhs.pinOrderKey) {
        case let (left?, right?):
            if left != right { return left < right }
            return lhs.id < rhs.id
        case (_?, nil): return true
        case (nil, _?): return false
        case (nil, nil):
            let lhsAnchor = activeAnchor(lhs)
            let rhsAnchor = activeAnchor(rhs)
            if lhsAnchor != rhsAnchor { return lhsAnchor > rhsAnchor }
            return lhs.id < rhs.id
        }
    }
}

enum PinnedThreadOrder {
    /// A key that sorts above every arranged pin, so a fresh pin lands on top
    /// of the run however it was pinned. Nil when the environment cannot take
    /// one; the pin is then sent bare and stays keyless.
    static func topKey(for thread: FeatureThread, among threads: [FeatureThread]) -> String? {
        guard thread.supportsPinReorder == true else { return nil }
        let first = threads
            .filter { $0.pinnedAt != nil && $0.id != thread.id }
            .compactMap(\.pinOrderKey)
            .min()
        return ThreadActiveOrder.between(nil, first)
    }

    /// The writes that realize `ordered` after `movedID` moved: one key when
    /// its neighbours are arranged, otherwise the whole run respaced once.
    /// Keys held by pins outside `ordered` (another project, another tab) are
    /// reserved so two rows never share a position.
    static func assignments(
        ordered: [FeatureThread],
        movedID: String,
        snapshot threads: [FeatureThread]
    ) -> [(String, String)] {
        ThreadActiveOrder.assignments(
            ordered: ordered,
            movedID: movedID,
            retained: threads.filter { $0.pinnedAt != nil },
            key: \.pinOrderKey
        )
    }
}
