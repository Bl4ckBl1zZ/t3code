import Foundation

// Ports web's `composerTypingGuard` (apps/web/src/components/chat/composerTypingGuard.ts):
// an approval or question that arrives while the reader is typing a draft waits
// until they pause, leave the field, or send, instead of taking the composer
// out from under their fingers.

/// Which pending requests the composer holds back for now. Requests already on
/// screen when the composer appears are never held.
struct ComposerTypingGuard: Equatable {
    static let idleInterval: TimeInterval = 1.5

    private(set) var held: Set<String> = []
    private(set) var lastTypedAt: Date = .distantPast
    private var seen: Set<String> = []
    private var focused = false

    /// The moment held requests show anyway, or nil when nothing is held.
    var releasesAt: Date? {
        held.isEmpty ? nil : lastTypedAt.addingTimeInterval(Self.idleInterval)
    }

    mutating func requests(_ ids: [String], now: Date) {
        held = held.filter(ids.contains)
        for id in ids where !seen.contains(id) {
            if focused, now.timeIntervalSince(lastTypedAt) < Self.idleInterval {
                held.insert(id)
            }
            seen.insert(id)
        }
    }

    mutating func typed(now: Date) {
        lastTypedAt = now
    }

    mutating func focus() {
        focused = true
    }

    mutating func blur() {
        release()
        focused = false
    }

    /// A send or a pause: everything held shows.
    mutating func release() {
        held = []
        lastTypedAt = .distantPast
    }

    /// A different draft: its requests start unseen, and focus carries over.
    mutating func reset() {
        self = ComposerTypingGuard(focused: focused)
    }

    private init(focused: Bool) {
        self.focused = focused
    }

    init() {}
}
