import Foundation
import os

/// The open thread's projection and the stream cursor that keeps it current.
///
/// Mirrors `applyItems` in packages/client-runtime/src/state/threads.ts:
/// snapshots replace, events with a sequence at or below the cursor are
/// replays and skip, and every other event folds locally. Sequences are
/// monotonic but not contiguous — the server may coalesce superseded events —
/// so a gap is never a reason to refetch.
///
/// The one Swift-only state is the hold: a known event this client could not
/// decode cannot be folded, so it and everything after it wait for an
/// authoritative snapshot. When the snapshot lands, held events newer than it
/// replay on top, so nothing that arrived during the refresh is lost.
struct NativeThreadDetailSync {
    private var live: OrchestrationV2LiveProjection?
    private(set) var sequence: Int
    private var held: [(sequence: Int, event: OrchestrationV2ThreadEvent)] = []

    init(snapshot: OrchestrationV2ThreadDetailSnapshot) {
        live = OrchestrationV2LiveProjection(snapshot.projection)
        sequence = snapshot.snapshotSequence
    }

    /// A thread whose projection has not arrived yet. Events wait for it.
    init(awaitingSnapshotAfter sequence: Int) {
        live = nil
        self.sequence = sequence
    }

    var projection: OrchestrationV2ThreadProjection? { live?.projection }

    /// Whether folding is paused until a snapshot arrives.
    var awaitingSnapshot: Bool { live == nil || !held.isEmpty }

    /// The event type that paused folding, for diagnostics.
    var holdReason: String? { held.first.map { "undecodable:\($0.event.type)" } }

    struct Result: Equatable {
        var changed = false
        var adoptedSnapshot = false
        var synchronized = false
    }

    /// Folds one stream batch. A whole replay backlog folds into one result,
    /// so the caller publishes once per batch rather than once per event.
    mutating func receive(_ items: [OrchestrationV2ThreadStreamItem]) -> Result {
        var result = Result()
        for item in items {
            switch item {
            case .synchronized:
                result.synchronized = true
            case let .snapshot(snapshot):
                if adopt(snapshot, into: &result) { result.adoptedSnapshot = true }
            case let .event(sequence, event):
                fold(sequence: sequence, event: event, into: &result)
            }
        }
        return result
    }

    /// Takes an HTTP or stream snapshot unless it is older than what is held.
    /// Held events newer than it replay on top. Returns nil when rejected.
    mutating func adopt(_ snapshot: OrchestrationV2ThreadDetailSnapshot) -> Result? {
        var result = Result()
        guard adopt(snapshot, into: &result) else { return nil }
        result.adoptedSnapshot = true
        return result
    }

    private mutating func adopt(
        _ snapshot: OrchestrationV2ThreadDetailSnapshot,
        into result: inout Result
    ) -> Bool {
        guard live == nil || snapshot.snapshotSequence >= sequence else { return false }
        live = OrchestrationV2LiveProjection(snapshot.projection)
        sequence = snapshot.snapshotSequence
        result.changed = true
        let replay = held.filter { $0.sequence > snapshot.snapshotSequence }
        held = []
        for entry in replay {
            fold(sequence: entry.sequence, event: entry.event, into: &result)
        }
        return true
    }

    private mutating func fold(
        sequence eventSequence: Int,
        event: OrchestrationV2ThreadEvent,
        into result: inout Result
    ) {
        guard eventSequence > (held.last?.sequence ?? sequence) else { return }
        guard live != nil, held.isEmpty else {
            held.append((eventSequence, event))
            return
        }
        switch live!.apply(event) {
        case .changed:
            sequence = eventSequence
            result.changed = true
        case .unchanged:
            // An unknown type still moves the resume cursor past it.
            sequence = eventSequence
        case .unmodelable:
            held.append((eventSequence, event))
        }
    }
}

/// Restart delays for a thread stream that ended: the ceiling doubles from
/// `base` up to `cap`, and each delay is a random point in its upper half so
/// clients of a restarted server do not return in the same instant. The same
/// shape the connection supervisor uses, scaled for one subscription.
struct NativeDetailStreamBackoff {
    var base: Duration = .seconds(1)
    var cap: Duration = .seconds(30)
    private(set) var attempt = 0

    /// `unit` is a value in 0...1; injected so tests are deterministic.
    mutating func nextDelay(unit: Double = .random(in: 0...1)) -> Duration {
        let ceiling = min(base * (1 << min(attempt, 20)), cap)
        attempt += 1
        return ceiling / 2 + (ceiling / 2) * min(max(unit, 0), 1)
    }

    mutating func reset() {
        attempt = 0
    }
}

/// Hands thread-stream items to the main actor in batches.
///
/// The pump drains the RPC stream off the main actor into a buffer; the
/// consumer wakes once per signal and takes everything that has arrived, so a
/// chunk of events — or a catch-up replay — folds in one pass. Mirrors the
/// `Queue.takeAll` drain in threads.ts.
final class NativeThreadDetailInbox: Sendable {
    enum Ending: Sendable {
        case finished
        case failed(String)
    }

    private struct State {
        var items: [OrchestrationV2ThreadStreamItem] = []
        var ending: Ending?
        var resumeSequence: Int
    }

    private let state: OSAllocatedUnfairLock<State>
    let signals: AsyncStream<Void>
    private let signal: AsyncStream<Void>.Continuation

    init(after sequence: Int) {
        state = OSAllocatedUnfairLock(initialState: State(resumeSequence: sequence))
        (signals, signal) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
    }

    /// The newest sequence this stream has delivered: where a resubscribe
    /// should resume. Held or not-yet-folded items are still in memory, so
    /// resuming after them loses nothing.
    var resumeSequence: Int { state.withLock { $0.resumeSequence } }

    /// Why the source ended, once it has.
    var ending: Ending? { state.withLock { $0.ending } }

    func drain() -> [OrchestrationV2ThreadStreamItem] {
        state.withLock { state in
            defer { state.items.removeAll(keepingCapacity: true) }
            return state.items
        }
    }

    /// Runs until the source ends or the calling task is cancelled.
    func pump(_ source: AsyncThrowingStream<OrchestrationV2ThreadStreamItem, Error>) async {
        var ending = Ending.finished
        do {
            for try await item in source {
                append(item)
            }
        } catch {
            ending = .failed(ConnectionLog.describe(error))
        }
        let final = ending
        state.withLock { $0.ending = final }
        signal.finish()
    }

    func append(_ item: OrchestrationV2ThreadStreamItem) {
        state.withLock { state in
            state.items.append(item)
            switch item {
            case let .event(sequence, _):
                state.resumeSequence = max(state.resumeSequence, sequence)
            case let .snapshot(snapshot):
                state.resumeSequence = max(state.resumeSequence, snapshot.snapshotSequence)
            case .synchronized:
                break
            }
        }
        signal.yield()
    }
}
