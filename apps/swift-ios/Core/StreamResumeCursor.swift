import Foundation

/// The newest sequence a resumable subscription has handed its consumer.
///
/// A shell or thread subscription that reconnects asks the server to resume
/// after a sequence. Naming the one it opened with turns every reconnect of a
/// long-lived stream into a replay of everything since then, or a full
/// snapshot. Callers that do not track their own applied sequence get this
/// cursor instead: it starts at the sequence the stream opened after and
/// advances with every frame the stream delivers. Mirrors how web reads the
/// latest sequence when it builds each subscribe request
/// (`packages/client-runtime/src/state/threads.ts`).
final class StreamResumeCursor: @unchecked Sendable {
    private let lock = NSLock()
    private var latest: Int?

    init(after sequence: Int?) {
        latest = sequence
    }

    /// Nil until the consumer holds state; a subscribe without a sequence
    /// asks the server for a full snapshot.
    var sequence: Int? {
        lock.withLock { latest }
    }

    func advance(to sequence: Int?) {
        guard let sequence else { return }
        lock.withLock {
            latest = max(latest ?? sequence, sequence)
        }
    }
}

extension OrchestrationV2ShellStreamItem {
    /// The sequence a consumer that applied this frame holds afterwards.
    /// Enrichment frames patch identity onto the shell and carry no position.
    var resumeSequence: Int? {
        switch self {
        case let .snapshot(shell, resolvedRepositoryIdentityRoots):
            resolvedRepositoryIdentityRoots == nil ? shell.snapshotSequence : nil
        case let .projectUpdated(sequence, _),
             let .projectRemoved(sequence, _),
             let .threadUpdated(sequence, _, _),
             let .threadRemoved(sequence, _, _):
            sequence
        case .synchronized:
            nil
        }
    }
}

extension OrchestrationV2ThreadStreamItem {
    var resumeSequence: Int? {
        switch self {
        case let .snapshot(snapshot): snapshot.snapshotSequence
        case let .event(sequence, _): sequence
        case .synchronized: nil
        }
    }
}
