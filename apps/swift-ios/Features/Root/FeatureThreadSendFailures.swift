import Foundation

/// Why a thread's last message did not send, shown above that thread's
/// composer rather than as an app-wide alert. Ports upstream mobile's
/// `thread-composer-error`.
public struct FeatureThreadSendFailure: Equatable, Sendable {
    public let message: String
    public let environmentID: String
    /// The outbox entry the failure is about, while it still waits there with
    /// "Send failed"; Retry resends it. Nil when the server refused the send
    /// outright and the text went back into the draft.
    public let submissionID: String?
}

/// One failure per thread, keyed by thread id. A failure outlives leaving the
/// thread: the outbox can reject a message after the reader has moved on. It
/// lasts until they dismiss it, send again, the message it describes is
/// delivered or discarded, or its environment is removed.
public struct FeatureThreadSendFailures: Equatable, Sendable {
    private var byThreadID: [String: FeatureThreadSendFailure] = [:]

    public init() {}

    public subscript(threadID: String) -> FeatureThreadSendFailure? {
        byThreadID[threadID]
    }

    public var isEmpty: Bool { byThreadID.isEmpty }

    public mutating func record(
        threadID: String,
        environmentID: String,
        message: String,
        submissionID: String? = nil
    ) {
        byThreadID[threadID] = FeatureThreadSendFailure(
            message: message,
            environmentID: environmentID,
            submissionID: submissionID
        )
    }

    /// Dismissed, or superseded by a new send on the thread.
    public mutating func clear(threadID: String) {
        byThreadID.removeValue(forKey: threadID)
    }

    /// The message it described went out after all, or was discarded. Keyed
    /// by submission because a delivered thread creation changes thread id.
    public mutating func clear(submissionID: String) {
        byThreadID = byThreadID.filter { $0.value.submissionID != submissionID }
    }

    public mutating func clear(environmentID: String) {
        byThreadID = byThreadID.filter { $0.value.environmentID != environmentID }
    }
}
