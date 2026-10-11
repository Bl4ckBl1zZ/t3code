import Foundation

/// Ported from packages/client-runtime/src/diffCount.ts. Every diff line count
/// goes through here so `83065` reads `83,065` in the reader's grouping,
/// whether it lands in a `Text`, a verbatim label, or a built string.
enum DiffCount {
    static func format(_ count: Int) -> String {
        count.formatted(.number)
    }
}
