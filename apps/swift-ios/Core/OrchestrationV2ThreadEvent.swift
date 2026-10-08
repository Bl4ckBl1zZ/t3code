import Foundation

/// One committed domain event from `subscribeThread`, decoded once into the
/// typed row it carries.
///
/// Mirrors `OrchestrationV2DomainEvent` in packages/contracts. The stream item
/// decoder builds this on the RPC actor, so the main actor only folds typed
/// values. Decoding never throws past the envelope: a type this build does not
/// know becomes ``Change/unknown`` (skipped, like the contract's
/// `unknown-event` arm), and a known type whose payload this client cannot
/// decode becomes ``Change/undecodable`` so one odd row cannot end the
/// subscription.
public struct OrchestrationV2ThreadEvent: Decodable, Sendable {
    public let type: String
    public let threadId: String
    public let occurredAt: OrchestrationV2Timestamp
    public let change: Change

    public enum Change: Sendable {
        case thread(OrchestrationV2AppThread)
        case titleReconciled(title: String, revision: Int, origin: String)
        case run(OrchestrationV2Run)
        case runBackgroundWorkCancelled(runID: String)
        case attempt(OrchestrationV2RunAttempt)
        case node(OrchestrationV2ExecutionNode)
        case subagent(OrchestrationV2Subagent)
        case providerSession(OrchestrationV2ProviderSession)
        case providerSessionDetached(providerSessionID: String)
        case providerThread(OrchestrationV2ProviderThread)
        case providerTurn(OrchestrationV2ProviderTurn)
        case runtimeRequest(OrchestrationV2RuntimeRequest)
        case message(OrchestrationV2ConversationMessage)
        case turnItem(OrchestrationV2TurnItem)
        case checkpoint(OrchestrationV2Checkpoint)
        case contextHandoff(OrchestrationV2ContextHandoff)
        case contextTransfer(OrchestrationV2ContextTransfer)
        /// A known event that only touches a table this client does not decode
        /// (`plan.updated`, `checkpoint-scope.created`) or carries nothing to
        /// fold (`checkpoint.rollback-requested`). It still bumps `updatedAt`.
        case activityOnly
        /// A type, or a turn item type, this build does not know.
        case unknown
        /// A known type whose payload did not decode here.
        case undecodable
    }

    public init(
        type: String,
        threadId: String,
        occurredAt: OrchestrationV2Timestamp,
        change: Change
    ) {
        self.type = type
        self.threadId = threadId
        self.occurredAt = occurredAt
        self.change = change
    }

    private enum CodingKeys: String, CodingKey {
        case type, threadId, occurredAt, payload
    }

    private struct TitleReconciled: Decodable {
        let title: String
        let revision: Int
        let origin: String
    }

    private struct RunReference: Decodable {
        let runId: String
    }

    private struct SessionDetached: Decodable {
        let providerSessionId: String
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let type = try? container.decode(String.self, forKey: .type) else {
            self.type = ""
            threadId = ""
            occurredAt = ""
            change = .unknown
            return
        }
        self.type = type
        guard let threadId = try? container.decode(String.self, forKey: .threadId),
              let occurredAt = try? container.decode(String.self, forKey: .occurredAt) else {
            self.threadId = ""
            self.occurredAt = ""
            change = Self.knownTypes.contains(type) ? .undecodable : .unknown
            return
        }
        self.threadId = threadId
        self.occurredAt = occurredAt

        func payload<T: Decodable>(_: T.Type) -> T? {
            try? container.decode(T.self, forKey: .payload)
        }

        let decoded: Change?
        switch type {
        case "thread.created", "thread.archived", "thread.unarchived", "thread.deleted",
             "thread.settled", "thread.unsettled", "thread.snoozed", "thread.unsnoozed",
             "thread.visited", "thread.marked-unread", "thread.metadata-updated",
             "thread.runtime-mode-updated", "thread.interaction-mode-updated",
             "thread.model-selection-updated", "thread.provider-switched":
            decoded = payload(OrchestrationV2AppThread.self).map(Change.thread)
        case "thread.title-reconciled":
            decoded = payload(TitleReconciled.self).map {
                .titleReconciled(title: $0.title, revision: $0.revision, origin: $0.origin)
            }
        case "run.created", "run.updated":
            decoded = payload(OrchestrationV2Run.self).map(Change.run)
        case "run.background-work-cancelled":
            decoded = payload(RunReference.self).map { .runBackgroundWorkCancelled(runID: $0.runId) }
        case "run-attempt.created", "run-attempt.updated":
            decoded = payload(OrchestrationV2RunAttempt.self).map(Change.attempt)
        case "node.updated":
            decoded = payload(OrchestrationV2ExecutionNode.self).map(Change.node)
        case "subagent.updated":
            decoded = payload(OrchestrationV2Subagent.self).map(Change.subagent)
        case "provider-session.attached", "provider-session.updated":
            decoded = payload(OrchestrationV2ProviderSession.self).map(Change.providerSession)
        case "provider-session.detached":
            decoded = payload(SessionDetached.self).map {
                .providerSessionDetached(providerSessionID: $0.providerSessionId)
            }
        case "provider-thread.updated":
            decoded = payload(OrchestrationV2ProviderThread.self).map(Change.providerThread)
        case "provider-turn.updated":
            decoded = payload(OrchestrationV2ProviderTurn.self).map(Change.providerTurn)
        case "runtime-request.updated":
            decoded = payload(OrchestrationV2RuntimeRequest.self).map(Change.runtimeRequest)
        case "message.updated":
            decoded = payload(OrchestrationV2ConversationMessage.self).map(Change.message)
        case "turn-item.updated":
            decoded = payload(OrchestrationV2TurnItem.self).map { item in
                // The contract decodes an unknown turn item type as an unknown
                // event and skips it; do the same rather than fold a row no
                // surface can render.
                if case .unknown = item.payload { return .unknown }
                return .turnItem(item)
            }
        case "checkpoint.captured":
            decoded = payload(OrchestrationV2Checkpoint.self).map(Change.checkpoint)
        case "context-handoff.updated":
            decoded = payload(OrchestrationV2ContextHandoff.self).map(Change.contextHandoff)
        case "context-transfer.created", "context-transfer.updated":
            decoded = payload(OrchestrationV2ContextTransfer.self).map(Change.contextTransfer)
        case "plan.updated", "checkpoint-scope.created", "checkpoint.rollback-requested":
            decoded = .activityOnly
        default:
            decoded = .unknown
        }
        change = decoded ?? .undecodable
    }

    /// Every `OrchestrationV2DomainEvent` type, for telling a malformed known
    /// event from one a newer server added.
    private static let knownTypes: Set<String> = [
        "thread.created", "thread.archived", "thread.unarchived", "thread.deleted",
        "thread.settled", "thread.unsettled", "thread.snoozed", "thread.unsnoozed",
        "thread.visited", "thread.marked-unread", "thread.metadata-updated",
        "thread.runtime-mode-updated", "thread.interaction-mode-updated",
        "thread.model-selection-updated", "thread.provider-switched",
        "thread.title-reconciled", "run.created", "run.updated",
        "run.background-work-cancelled", "run-attempt.created", "run-attempt.updated",
        "node.updated", "subagent.updated", "provider-session.attached",
        "provider-session.updated", "provider-session.detached", "provider-thread.updated",
        "provider-turn.updated", "runtime-request.updated", "message.updated",
        "turn-item.updated", "plan.updated", "checkpoint-scope.created",
        "checkpoint.captured", "checkpoint.rollback-requested", "context-handoff.updated",
        "context-transfer.created", "context-transfer.updated",
    ]
}
