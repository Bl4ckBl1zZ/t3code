import Foundation

/// Remembers each shell thread's mapped row so a publish maps only the rows
/// whose input changed.
///
/// While any thread is running, the shell stream publishes up to four times a
/// second, and every publish rebuilt every row of every environment. A row is
/// a pure function of its wire thread plus per-environment context (the
/// environment, settings, the provider catalog), so a row whose thread and
/// context both compare equal is reused as-is. Changing an environment's
/// context remaps all of that environment's rows.
struct ShellThreadMappingCache<Context: Equatable> {
    private struct Entry {
        let thread: OrchestrationV2ThreadShell
        let row: FeatureThread
    }

    private var contexts: [String: Context] = [:]
    private var entries: [String: [String: Entry]] = [:]

    /// Rows for `threads`, in order. Rows for threads that are gone are
    /// forgotten.
    mutating func rows(
        environmentID: String,
        context: Context,
        threads: [OrchestrationV2ThreadShell],
        map: (OrchestrationV2ThreadShell) -> FeatureThread
    ) -> [FeatureThread] {
        let previous = contexts[environmentID] == context ? entries[environmentID] ?? [:] : [:]
        contexts[environmentID] = context
        var next: [String: Entry] = [:]
        next.reserveCapacity(threads.count)
        let rows = threads.map { thread in
            if let entry = previous[thread.id], entry.thread == thread {
                next[thread.id] = entry
                return entry.row
            }
            let row = map(thread)
            next[thread.id] = Entry(thread: thread, row: row)
            return row
        }
        entries[environmentID] = next
        return rows
    }

    /// Drops environments that are no longer listed.
    mutating func retain(environmentIDs: Set<String>) {
        contexts = contexts.filter { environmentIDs.contains($0.key) }
        entries = entries.filter { environmentIDs.contains($0.key) }
    }
}
