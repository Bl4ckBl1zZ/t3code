import Foundation

// Wire mirrors for the fork's orchestration V2 contracts
// (`packages/contracts/src/orchestrationV2.ts`). Upstream's SwiftUI client was
// written against the V1 thread contracts, which this fork retired; these types
// replace that layer.
//
// Forward compatibility is deliberate and load-bearing. The server keeps adding
// turn item types, statuses, and domain events, and a client that throws on an
// unrecognized discriminator would blank an entire transcript the moment the
// server ships one. Every closed set below therefore decodes unknown values into
// an `unknown` case instead of failing, and callers render what they understand.

// MARK: - Scalars

/// Timestamps arrive as ISO-8601 strings with fractional seconds. Kept as
/// `String` on the wire (matching the rest of Core) and parsed at the mapping
/// layer, so a malformed timestamp degrades one row rather than the projection.
public typealias OrchestrationV2Timestamp = String

public enum OrchestrationV2TurnItemStatus: String, Codable, Equatable, Sendable {
    case pending
    case running
    case waiting
    case completed
    case failed
    case cancelled
    case interrupted
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = OrchestrationV2TurnItemStatus(rawValue: raw) ?? .unknown
    }

    /// Mirrors `orchestrationV2TurnItemStatusIsTerminal`. `unknown` is treated as
    /// non-terminal so a new in-flight status keeps its spinner rather than
    /// silently presenting as finished work.
    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled, .interrupted: true
        case .pending, .running, .waiting, .unknown: false
        }
    }
}

public enum OrchestrationV2TurnItemVisibility: String, Codable, Equatable, Sendable {
    case local
    case inherited
    case synthetic
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = OrchestrationV2TurnItemVisibility(rawValue: raw) ?? .unknown
    }
}

public enum OrchestrationV2UserMessageInputIntent: String, Codable, Equatable, Sendable {
    case turnStart = "turn_start"
    case queuedTurn = "queued_turn"
    case steer
    case promotedQueuedToSteer = "promoted_queued_to_steer"
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = OrchestrationV2UserMessageInputIntent(rawValue: raw) ?? .unknown
    }
}

// MARK: - Shared value types

public struct OrchestrationV2ProviderRef: Codable, Equatable, Sendable {
    public let driver: String
    public let nativeId: String?
    public let strength: String
    public let fingerprint: String?
    public let ordinal: Int?
}

public struct OrchestrationV2CheckpointFileSummary: Codable, Equatable, Sendable {
    public let path: String
    public let kind: String
    public let additions: Int
    public let deletions: Int
}

public struct OrchestrationV2UserInputOption: Codable, Equatable, Sendable {
    public let label: String
    public let description: String
}

public struct OrchestrationV2UserInputQuestion: Codable, Equatable, Sendable {
    public let id: String
    public let header: String
    public let question: String
    public let options: [OrchestrationV2UserInputOption]
}

public struct OrchestrationV2PlanStep: Codable, Equatable, Sendable {
    public let id: String
    public let text: String
    public let status: String
}

public struct OrchestrationV2FileSearchResult: Codable, Equatable, Sendable {
    public let fileName: String
    public let line: Int?
    public let column: Int?
    public let preview: String?
}

public struct OrchestrationV2WebSearchResult: Codable, Equatable, Sendable {
    public let title: String?
    public let url: String?
    public let snippet: String?
}

public struct OrchestrationV2ProviderFailure: Codable, Equatable, Sendable {
    public let failureClass: String
    public let message: String
    public let code: String?
    public let retryable: Bool?

    // `class` is a Swift keyword, so the wire key is remapped rather than
    // escaped at every use site.
    private enum CodingKeys: String, CodingKey {
        case failureClass = "class"
        case message, code, retryable
    }
}

public struct OrchestrationV2ProviderRetry: Codable, Equatable, Sendable {
    public let attempt: Int
    public let maxAttempts: Int?
    public let retryDelayMs: Int?
}

/// One declared phase of a workflow script.
///
/// `index` is the phase's position in the script's own declaration order, which
/// is *not* necessarily execution order — a script may skip a phase or revisit
/// one — so progress is keyed off the title reported as current rather than off
/// a monotonic walk of these.
public struct OrchestrationV2WorkflowPhase: Codable, Equatable, Sendable {
    public let index: Int
    public let title: String
    public let detail: String?

    public init(index: Int, title: String, detail: String? = nil) {
        self.index = index
        self.title = title
        self.detail = detail
    }

    private enum CodingKeys: String, CodingKey {
        case index, title, detail
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        index = try container.decodeIfPresent(Int.self, forKey: .index) ?? 0
        title = try container.decode(String.self, forKey: .title)
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
    }
}

/// Workflow-shaped progress for a subagent that runs a script rather than a
/// single prompt. Absent on ordinary subagents, which is the common case.
public struct OrchestrationV2WorkflowProgress: Codable, Equatable, Sendable {
    public let name: String?
    public let description: String?
    public let phases: [OrchestrationV2WorkflowPhase]
    /// Title of the phase most recently entered.
    public let currentPhase: String?
    /// Agents spawned so far by this workflow; drives the fan-out count.
    public let spawnedCount: Int?

    public init(
        name: String? = nil,
        description: String? = nil,
        phases: [OrchestrationV2WorkflowPhase] = [],
        currentPhase: String? = nil,
        spawnedCount: Int? = nil
    ) {
        self.name = name
        self.description = description
        self.phases = phases
        self.currentPhase = currentPhase
        self.spawnedCount = spawnedCount
    }

    private enum CodingKeys: String, CodingKey {
        case name, description, phases, currentPhase, spawnedCount
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        phases = try container.decodeIfPresent(
            [OrchestrationV2WorkflowPhase].self, forKey: .phases
        ) ?? []
        currentPhase = try container.decodeIfPresent(String.self, forKey: .currentPhase)
        spawnedCount = try container.decodeIfPresent(Int.self, forKey: .spawnedCount)
    }
}

/// Cumulative token rollup for one subagent task.
///
/// Every field past `totalTokens` is optional because no driver reports the
/// full set: a missing field means "not reported", which is not the same as
/// zero and must not be rendered as such.
public struct OrchestrationV2TaskUsage: Codable, Equatable, Sendable {
    public let totalTokens: Int
    public let inputTokens: Int?
    public let cachedInputTokens: Int?
    public let outputTokens: Int?
    public let reasoningOutputTokens: Int?
    public let toolUses: Int?
    public let durationMs: Int?

    public init(
        totalTokens: Int,
        inputTokens: Int? = nil,
        cachedInputTokens: Int? = nil,
        outputTokens: Int? = nil,
        reasoningOutputTokens: Int? = nil,
        toolUses: Int? = nil,
        durationMs: Int? = nil
    ) {
        self.totalTokens = totalTokens
        self.inputTokens = inputTokens
        self.cachedInputTokens = cachedInputTokens
        self.outputTokens = outputTokens
        self.reasoningOutputTokens = reasoningOutputTokens
        self.toolUses = toolUses
        self.durationMs = durationMs
    }

    private enum CodingKeys: String, CodingKey {
        case totalTokens, inputTokens, cachedInputTokens, outputTokens
        case reasoningOutputTokens, toolUses, durationMs
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        totalTokens = try container.decodeIfPresent(Int.self, forKey: .totalTokens) ?? 0
        inputTokens = try container.decodeIfPresent(Int.self, forKey: .inputTokens)
        cachedInputTokens = try container.decodeIfPresent(Int.self, forKey: .cachedInputTokens)
        outputTokens = try container.decodeIfPresent(Int.self, forKey: .outputTokens)
        reasoningOutputTokens = try container.decodeIfPresent(
            Int.self, forKey: .reasoningOutputTokens
        )
        toolUses = try container.decodeIfPresent(Int.self, forKey: .toolUses)
        durationMs = try container.decodeIfPresent(Int.self, forKey: .durationMs)
    }
}

/// The turn-shaped half of `OrchestrationV2ProviderCapabilities`, narrowed to
/// the steering and queueing flags the composer and the queue control read.
///
/// Every flag defaults to `false`: a driver descriptor written before one of
/// these existed means the client has no evidence of the capability, and
/// offering a steer the provider silently drops is worse than not offering it.
public struct OrchestrationV2TurnCapabilities: Codable, Equatable, Sendable {
    public let supportsActiveSteering: Bool
    public let supportsSteeringByInterruptRestart: Bool
    public let supportsQueuedMessages: Bool

    public init(
        supportsActiveSteering: Bool = false,
        supportsSteeringByInterruptRestart: Bool = false,
        supportsQueuedMessages: Bool = false
    ) {
        self.supportsActiveSteering = supportsActiveSteering
        self.supportsSteeringByInterruptRestart = supportsSteeringByInterruptRestart
        self.supportsQueuedMessages = supportsQueuedMessages
    }

    private enum CodingKeys: String, CodingKey {
        case supportsActiveSteering, supportsSteeringByInterruptRestart, supportsQueuedMessages
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        supportsActiveSteering = try container.decodeIfPresent(
            Bool.self, forKey: .supportsActiveSteering
        ) ?? false
        supportsSteeringByInterruptRestart = try container.decodeIfPresent(
            Bool.self, forKey: .supportsSteeringByInterruptRestart
        ) ?? false
        supportsQueuedMessages = try container.decodeIfPresent(
            Bool.self, forKey: .supportsQueuedMessages
        ) ?? false
    }
}

/// The provider capability descriptor, narrowed to the `turns` group.
///
/// The contract carries eleven groups; the rest are modeled when a feature
/// needs them. Unmodeled groups decode away rather than failing.
public struct OrchestrationV2ProviderCapabilities: Codable, Equatable, Sendable {
    public let turns: OrchestrationV2TurnCapabilities?

    public init(turns: OrchestrationV2TurnCapabilities? = nil) {
        self.turns = turns
    }
}

/// `fork.source` and `thread.forkedFrom` share this shape.
public enum OrchestrationV2ForkSource: Codable, Equatable, Sendable {
    case run(threadID: String, runID: String)
    case node(nodeID: String)
    case providerThread(providerThreadID: String, providerTurnID: String?)
    case unknown(String)

    private enum CodingKeys: String, CodingKey {
        case type, threadId, runId, nodeId, providerThreadId, providerTurnId
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "run":
            self = .run(
                threadID: try container.decode(String.self, forKey: .threadId),
                runID: try container.decode(String.self, forKey: .runId)
            )
        case "node":
            self = .node(nodeID: try container.decode(String.self, forKey: .nodeId))
        case "provider_thread":
            self = .providerThread(
                providerThreadID: try container.decode(String.self, forKey: .providerThreadId),
                providerTurnID: try container.decodeIfPresent(String.self, forKey: .providerTurnId)
            )
        default:
            self = .unknown(type)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .run(threadID, runID):
            try container.encode("run", forKey: .type)
            try container.encode(threadID, forKey: .threadId)
            try container.encode(runID, forKey: .runId)
        case let .node(nodeID):
            try container.encode("node", forKey: .type)
            try container.encode(nodeID, forKey: .nodeId)
        case let .providerThread(providerThreadID, providerTurnID):
            try container.encode("provider_thread", forKey: .type)
            try container.encode(providerThreadID, forKey: .providerThreadId)
            try container.encodeIfPresent(providerTurnID, forKey: .providerTurnId)
        case let .unknown(type):
            try container.encode(type, forKey: .type)
        }
    }
}

// MARK: - Turn items

/// Fields every turn item carries, regardless of type.
public struct OrchestrationV2TurnItemBase: Codable, Equatable, Sendable {
    public let id: String
    public let threadId: String
    public let runId: String?
    public let nodeId: String?
    public let providerThreadId: String?
    public let providerTurnId: String?
    public let nativeItemRef: OrchestrationV2ProviderRef?
    public let parentItemId: String?
    public let ordinal: Int
    public let status: OrchestrationV2TurnItemStatus
    public let title: String?
    public let startedAt: OrchestrationV2Timestamp?
    public let completedAt: OrchestrationV2Timestamp?
    public let updatedAt: OrchestrationV2Timestamp
    /// Only `user_message` carries the creation fields, so these are absent on
    /// every other item type rather than optional-by-accident.
    public let createdBy: String?
    public let creationSource: String?
    /// The status exactly as the server sent it.
    ///
    /// `status` collapses anything this build predates to `.unknown`, which is
    /// what keeps a new server status from failing the decode. Surfaces that
    /// *display* the status need the literal instead, or a user inspecting an
    /// item would see "unknown" where the web and React Native clients show the
    /// real value.
    public let rawStatus: String

    private enum CodingKeys: String, CodingKey {
        case id, threadId, runId, nodeId, providerThreadId, providerTurnId
        case nativeItemRef, parentItemId, ordinal, status, title
        case startedAt, completedAt, updatedAt, createdBy, creationSource
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        threadId = try container.decode(String.self, forKey: .threadId)
        runId = try container.decodeIfPresent(String.self, forKey: .runId)
        nodeId = try container.decodeIfPresent(String.self, forKey: .nodeId)
        providerThreadId = try container.decodeIfPresent(String.self, forKey: .providerThreadId)
        providerTurnId = try container.decodeIfPresent(String.self, forKey: .providerTurnId)
        nativeItemRef = try container.decodeIfPresent(
            OrchestrationV2ProviderRef.self, forKey: .nativeItemRef
        )
        parentItemId = try container.decodeIfPresent(String.self, forKey: .parentItemId)
        ordinal = try container.decodeIfPresent(Int.self, forKey: .ordinal) ?? 0
        rawStatus = try container.decode(String.self, forKey: .status)
        status = OrchestrationV2TurnItemStatus(rawValue: rawStatus) ?? .unknown
        title = try container.decodeIfPresent(String.self, forKey: .title)
        startedAt = try container.decodeIfPresent(String.self, forKey: .startedAt)
        completedAt = try container.decodeIfPresent(String.self, forKey: .completedAt)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
        createdBy = try container.decodeIfPresent(String.self, forKey: .createdBy)
        creationSource = try container.decodeIfPresent(String.self, forKey: .creationSource)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(threadId, forKey: .threadId)
        try container.encode(runId, forKey: .runId)
        try container.encode(nodeId, forKey: .nodeId)
        try container.encode(providerThreadId, forKey: .providerThreadId)
        try container.encode(providerTurnId, forKey: .providerTurnId)
        try container.encodeIfPresent(nativeItemRef, forKey: .nativeItemRef)
        try container.encode(parentItemId, forKey: .parentItemId)
        try container.encode(ordinal, forKey: .ordinal)
        try container.encode(rawStatus, forKey: .status)
        try container.encode(title, forKey: .title)
        try container.encode(startedAt, forKey: .startedAt)
        try container.encode(completedAt, forKey: .completedAt)
        try container.encode(updatedAt, forKey: .updatedAt)
        try container.encodeIfPresent(createdBy, forKey: .createdBy)
        try container.encodeIfPresent(creationSource, forKey: .creationSource)
    }
}

/// Liveness metadata for a command that can outlive the tool call that launched
/// it. Providers supply complementary halves of this, so every field is optional
/// and presentation is chosen from what is actually present.
public struct OrchestrationV2CommandLiveness: Codable, Equatable, Sendable {
    public let background: Bool?
    public let taskId: String?
    public let hasOutputStream: Bool?
    public let timeoutMs: Int?
    public let paused: Bool?
    public let pausedMs: Int?
    public let outputTruncated: Bool?
    public let exitReason: String?
    public let waitKind: String?
    public let waitingOnTaskId: String?
    public let lastOutputAt: OrchestrationV2Timestamp?
}

public struct OrchestrationV2TurnItem: Codable, Equatable, Sendable, Identifiable {
    public let base: OrchestrationV2TurnItemBase
    public let payload: Payload

    public var id: String { base.id }
    public var status: OrchestrationV2TurnItemStatus { base.status }
    public var ordinal: Int { base.ordinal }

    public enum Payload: Equatable, Sendable {
        case userMessage(messageID: String, intent: OrchestrationV2UserMessageInputIntent, text: String, attachments: [ChatAttachment])
        case assistantMessage(messageID: String, text: String, streaming: Bool)
        case reasoning(text: String, streaming: Bool)
        case proposedPlan(planID: String, markdown: String, streaming: Bool)
        case todoList(planID: String, steps: [OrchestrationV2PlanStep], explanation: String?)
        case userInputRequest(requestID: String, questions: [OrchestrationV2UserInputQuestion])
        case fileChange(fileName: String, additions: Int?, deletions: Int?, diffStr: String?, oldStr: String?, newStr: String?)
        case commandExecution(input: String, output: String?, exitCode: Int?, liveness: OrchestrationV2CommandLiveness)
        case fileSearch(pattern: String?, results: [OrchestrationV2FileSearchResult]?)
        case webSearch(patterns: [String]?, results: [OrchestrationV2WebSearchResult]?)
        case approvalRequest(requestID: String, requestKind: String, prompt: String?)
        case checkpoint(checkpointID: String, scopeID: String, files: [OrchestrationV2CheckpointFileSummary])
        case checkpointRollback(checkpointID: String, scopeID: String, restoredFileCount: Int, rolledBackRunCount: Int)
        case runInterruptRequest(message: String)
        case runInterruptResult(message: String)
        case error(failure: OrchestrationV2ProviderFailure, retry: OrchestrationV2ProviderRetry?)
        case compaction(driver: String?, summary: String?, beforeTokenCount: Int?, afterTokenCount: Int?)
        case handoff(contextHandoffID: String, fromProviderInstanceIDs: [String], fromModelSelections: [ModelSelection]?, toProviderThreadID: String, toProviderInstanceID: String, toModel: String?, strategy: String, summary: String?)
        case fork(source: OrchestrationV2ForkSource, targetThreadID: String, providerThreadID: String?)
        case threadCreated(targetThreadID: String, targetRunID: String?, targetProviderInstanceID: String, targetModel: String)
        case subagent(subagentID: String, origin: String, driver: String, providerInstanceID: String, childThreadID: String?, prompt: String, progress: String?, result: String?)
        case dynamicTool(toolName: String?, input: JSONValue?, output: JSONValue?)
        /// A type this build does not know. Retained so ordinals and counts stay
        /// correct and the row can render as a neutral placeholder.
        case unknown(type: String)
    }

    /// The wire discriminator, preserved verbatim so unknown types can still be
    /// logged and re-encoded.
    public let type: String

    private enum CodingKeys: String, CodingKey {
        case type
        case messageId, inputIntent, text, attachments
        case streaming, planId, markdown, steps, explanation
        case requestId, questions, requestKind, prompt
        case fileName, additions, deletions, diffStr, oldStr, newStr
        case input, output, exitCode
        case pattern, results, patterns
        case checkpointId, scopeId, files, restoredFileCount, rolledBackRunCount
        case message, failure, retry
        case driver, summary, beforeTokenCount, afterTokenCount
        case contextHandoffId, fromProviderInstanceIds, fromModelSelections
        case toProviderThreadId, toProviderInstanceId, toModel, strategy
        case source, targetThreadId, providerThreadId
        case targetRunId, targetProviderInstanceId, targetModel
        case subagentId, origin, providerInstanceId, childThreadId, progress, result
        case toolName
    }

    public init(from decoder: any Decoder) throws {
        base = try OrchestrationV2TurnItemBase(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        self.type = type

        switch type {
        case "user_message":
            payload = .userMessage(
                messageID: try container.decode(String.self, forKey: .messageId),
                intent: try container.decode(OrchestrationV2UserMessageInputIntent.self, forKey: .inputIntent),
                text: try container.decode(String.self, forKey: .text),
                attachments: try container.decodeIfPresent([ChatAttachment].self, forKey: .attachments) ?? []
            )
        case "assistant_message":
            payload = .assistantMessage(
                messageID: try container.decode(String.self, forKey: .messageId),
                text: try container.decode(String.self, forKey: .text),
                streaming: try container.decodeIfPresent(Bool.self, forKey: .streaming) ?? false
            )
        case "reasoning":
            payload = .reasoning(
                text: try container.decode(String.self, forKey: .text),
                streaming: try container.decodeIfPresent(Bool.self, forKey: .streaming) ?? false
            )
        case "proposed_plan":
            payload = .proposedPlan(
                planID: try container.decode(String.self, forKey: .planId),
                markdown: try container.decode(String.self, forKey: .markdown),
                streaming: try container.decodeIfPresent(Bool.self, forKey: .streaming) ?? false
            )
        case "todo_list":
            payload = .todoList(
                planID: try container.decode(String.self, forKey: .planId),
                steps: try container.decodeIfPresent([OrchestrationV2PlanStep].self, forKey: .steps) ?? [],
                explanation: try container.decodeIfPresent(String.self, forKey: .explanation)
            )
        case "user_input_request":
            payload = .userInputRequest(
                requestID: try container.decode(String.self, forKey: .requestId),
                questions: try container.decodeIfPresent([OrchestrationV2UserInputQuestion].self, forKey: .questions) ?? []
            )
        case "file_change":
            payload = .fileChange(
                fileName: try container.decode(String.self, forKey: .fileName),
                additions: try container.decodeIfPresent(Int.self, forKey: .additions),
                deletions: try container.decodeIfPresent(Int.self, forKey: .deletions),
                diffStr: try container.decodeIfPresent(String.self, forKey: .diffStr),
                oldStr: try container.decodeIfPresent(String.self, forKey: .oldStr),
                newStr: try container.decodeIfPresent(String.self, forKey: .newStr)
            )
        case "command_execution":
            payload = .commandExecution(
                input: try container.decode(String.self, forKey: .input),
                output: try container.decodeIfPresent(String.self, forKey: .output),
                exitCode: try container.decodeIfPresent(Int.self, forKey: .exitCode),
                liveness: try OrchestrationV2CommandLiveness(from: decoder)
            )
        case "file_search":
            payload = .fileSearch(
                pattern: try container.decodeIfPresent(String.self, forKey: .pattern),
                results: try container.decodeIfPresent([OrchestrationV2FileSearchResult].self, forKey: .results)
            )
        case "web_search":
            payload = .webSearch(
                patterns: try container.decodeIfPresent([String].self, forKey: .patterns),
                results: try container.decodeIfPresent([OrchestrationV2WebSearchResult].self, forKey: .results)
            )
        case "approval_request":
            payload = .approvalRequest(
                requestID: try container.decode(String.self, forKey: .requestId),
                requestKind: try container.decode(String.self, forKey: .requestKind),
                prompt: try container.decodeIfPresent(String.self, forKey: .prompt)
            )
        case "checkpoint":
            payload = .checkpoint(
                checkpointID: try container.decode(String.self, forKey: .checkpointId),
                scopeID: try container.decode(String.self, forKey: .scopeId),
                files: try container.decodeIfPresent([OrchestrationV2CheckpointFileSummary].self, forKey: .files) ?? []
            )
        case "checkpoint_rollback":
            payload = .checkpointRollback(
                checkpointID: try container.decode(String.self, forKey: .checkpointId),
                scopeID: try container.decode(String.self, forKey: .scopeId),
                restoredFileCount: try container.decodeIfPresent(Int.self, forKey: .restoredFileCount) ?? 0,
                rolledBackRunCount: try container.decodeIfPresent(Int.self, forKey: .rolledBackRunCount) ?? 0
            )
        case "run_interrupt_request":
            payload = .runInterruptRequest(message: try container.decode(String.self, forKey: .message))
        case "run_interrupt_result":
            payload = .runInterruptResult(message: try container.decode(String.self, forKey: .message))
        case "error":
            payload = .error(
                failure: try container.decode(OrchestrationV2ProviderFailure.self, forKey: .failure),
                retry: try container.decodeIfPresent(OrchestrationV2ProviderRetry.self, forKey: .retry)
            )
        case "compaction":
            payload = .compaction(
                driver: try container.decodeIfPresent(String.self, forKey: .driver),
                summary: try container.decodeIfPresent(String.self, forKey: .summary),
                beforeTokenCount: try container.decodeIfPresent(Int.self, forKey: .beforeTokenCount),
                afterTokenCount: try container.decodeIfPresent(Int.self, forKey: .afterTokenCount)
            )
        case "handoff":
            payload = .handoff(
                contextHandoffID: try container.decode(String.self, forKey: .contextHandoffId),
                fromProviderInstanceIDs: try container.decodeIfPresent(
                    [String].self, forKey: .fromProviderInstanceIds
                ) ?? [],
                fromModelSelections: try container.decodeIfPresent(
                    [ModelSelection].self, forKey: .fromModelSelections
                ),
                toProviderThreadID: try container.decode(String.self, forKey: .toProviderThreadId),
                toProviderInstanceID: try container.decode(String.self, forKey: .toProviderInstanceId),
                toModel: try container.decodeIfPresent(String.self, forKey: .toModel),
                strategy: try container.decode(String.self, forKey: .strategy),
                summary: try container.decodeIfPresent(String.self, forKey: .summary)
            )
        case "fork":
            payload = .fork(
                source: try container.decode(OrchestrationV2ForkSource.self, forKey: .source),
                targetThreadID: try container.decode(String.self, forKey: .targetThreadId),
                providerThreadID: try container.decodeIfPresent(String.self, forKey: .providerThreadId)
            )
        case "thread_created":
            payload = .threadCreated(
                targetThreadID: try container.decode(String.self, forKey: .targetThreadId),
                targetRunID: try container.decodeIfPresent(String.self, forKey: .targetRunId),
                targetProviderInstanceID: try container.decode(String.self, forKey: .targetProviderInstanceId),
                targetModel: try container.decode(String.self, forKey: .targetModel)
            )
        case "subagent":
            payload = .subagent(
                subagentID: try container.decode(String.self, forKey: .subagentId),
                origin: try container.decode(String.self, forKey: .origin),
                driver: try container.decode(String.self, forKey: .driver),
                providerInstanceID: try container.decode(String.self, forKey: .providerInstanceId),
                childThreadID: try container.decodeIfPresent(String.self, forKey: .childThreadId),
                prompt: try container.decodeIfPresent(String.self, forKey: .prompt) ?? "",
                progress: try container.decodeIfPresent(String.self, forKey: .progress),
                result: try container.decodeIfPresent(String.self, forKey: .result)
            )
        case "dynamic_tool":
            payload = .dynamicTool(
                toolName: try container.decodeIfPresent(String.self, forKey: .toolName),
                input: try container.decodeIfPresent(JSONValue.self, forKey: .input),
                output: try container.decodeIfPresent(JSONValue.self, forKey: .output)
            )
        default:
            payload = .unknown(type: type)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        try base.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)

        switch payload {
        case let .userMessage(messageID, intent, text, attachments):
            try container.encode(messageID, forKey: .messageId)
            try container.encode(intent.rawValue, forKey: .inputIntent)
            try container.encode(text, forKey: .text)
            try container.encode(attachments, forKey: .attachments)
        case let .assistantMessage(messageID, text, streaming):
            try container.encode(messageID, forKey: .messageId)
            try container.encode(text, forKey: .text)
            try container.encode(streaming, forKey: .streaming)
        case let .reasoning(text, streaming):
            try container.encode(text, forKey: .text)
            try container.encode(streaming, forKey: .streaming)
        case let .proposedPlan(planID, markdown, streaming):
            try container.encode(planID, forKey: .planId)
            try container.encode(markdown, forKey: .markdown)
            try container.encode(streaming, forKey: .streaming)
        case let .todoList(planID, steps, explanation):
            try container.encode(planID, forKey: .planId)
            try container.encode(steps, forKey: .steps)
            try container.encodeIfPresent(explanation, forKey: .explanation)
        case let .userInputRequest(requestID, questions):
            try container.encode(requestID, forKey: .requestId)
            try container.encode(questions, forKey: .questions)
        case let .fileChange(fileName, additions, deletions, diffStr, oldStr, newStr):
            try container.encode(fileName, forKey: .fileName)
            try container.encodeIfPresent(additions, forKey: .additions)
            try container.encodeIfPresent(deletions, forKey: .deletions)
            try container.encodeIfPresent(diffStr, forKey: .diffStr)
            try container.encodeIfPresent(oldStr, forKey: .oldStr)
            try container.encodeIfPresent(newStr, forKey: .newStr)
        case let .commandExecution(input, output, exitCode, liveness):
            try container.encode(input, forKey: .input)
            try container.encodeIfPresent(output, forKey: .output)
            try container.encodeIfPresent(exitCode, forKey: .exitCode)
            try liveness.encode(to: encoder)
        case let .fileSearch(pattern, results):
            try container.encodeIfPresent(pattern, forKey: .pattern)
            try container.encodeIfPresent(results, forKey: .results)
        case let .webSearch(patterns, results):
            try container.encodeIfPresent(patterns, forKey: .patterns)
            try container.encodeIfPresent(results, forKey: .results)
        case let .approvalRequest(requestID, requestKind, prompt):
            try container.encode(requestID, forKey: .requestId)
            try container.encode(requestKind, forKey: .requestKind)
            try container.encodeIfPresent(prompt, forKey: .prompt)
        case let .checkpoint(checkpointID, scopeID, files):
            try container.encode(checkpointID, forKey: .checkpointId)
            try container.encode(scopeID, forKey: .scopeId)
            try container.encode(files, forKey: .files)
        case let .checkpointRollback(checkpointID, scopeID, restoredFileCount, rolledBackRunCount):
            try container.encode(checkpointID, forKey: .checkpointId)
            try container.encode(scopeID, forKey: .scopeId)
            try container.encode(restoredFileCount, forKey: .restoredFileCount)
            try container.encode(rolledBackRunCount, forKey: .rolledBackRunCount)
        case let .runInterruptRequest(message), let .runInterruptResult(message):
            try container.encode(message, forKey: .message)
        case let .error(failure, retry):
            try container.encode(failure, forKey: .failure)
            try container.encodeIfPresent(retry, forKey: .retry)
        case let .compaction(driver, summary, beforeTokenCount, afterTokenCount):
            try container.encodeIfPresent(driver, forKey: .driver)
            try container.encodeIfPresent(summary, forKey: .summary)
            try container.encodeIfPresent(beforeTokenCount, forKey: .beforeTokenCount)
            try container.encodeIfPresent(afterTokenCount, forKey: .afterTokenCount)
        case let .handoff(contextHandoffID, fromProviderInstanceIDs, fromModelSelections, toProviderThreadID, toProviderInstanceID, toModel, strategy, summary):
            try container.encode(contextHandoffID, forKey: .contextHandoffId)
            try container.encode(fromProviderInstanceIDs, forKey: .fromProviderInstanceIds)
            try container.encodeIfPresent(fromModelSelections, forKey: .fromModelSelections)
            try container.encode(toProviderThreadID, forKey: .toProviderThreadId)
            try container.encode(toProviderInstanceID, forKey: .toProviderInstanceId)
            try container.encodeIfPresent(toModel, forKey: .toModel)
            try container.encode(strategy, forKey: .strategy)
            try container.encodeIfPresent(summary, forKey: .summary)
        case let .fork(source, targetThreadID, providerThreadID):
            try container.encode(source, forKey: .source)
            try container.encode(targetThreadID, forKey: .targetThreadId)
            try container.encodeIfPresent(providerThreadID, forKey: .providerThreadId)
        case let .threadCreated(targetThreadID, targetRunID, targetProviderInstanceID, targetModel):
            try container.encode(targetThreadID, forKey: .targetThreadId)
            try container.encodeIfPresent(targetRunID, forKey: .targetRunId)
            try container.encode(targetProviderInstanceID, forKey: .targetProviderInstanceId)
            try container.encode(targetModel, forKey: .targetModel)
        case let .subagent(subagentID, origin, driver, providerInstanceID, childThreadID, prompt, progress, result):
            try container.encode(subagentID, forKey: .subagentId)
            try container.encode(origin, forKey: .origin)
            try container.encode(driver, forKey: .driver)
            try container.encode(providerInstanceID, forKey: .providerInstanceId)
            try container.encodeIfPresent(childThreadID, forKey: .childThreadId)
            try container.encode(prompt, forKey: .prompt)
            try container.encodeIfPresent(progress, forKey: .progress)
            try container.encodeIfPresent(result, forKey: .result)
        case let .dynamicTool(toolName, input, output):
            try container.encodeIfPresent(toolName, forKey: .toolName)
            try container.encodeIfPresent(input, forKey: .input)
            try container.encodeIfPresent(output, forKey: .output)
        case .unknown:
            break
        }
    }
}

public struct OrchestrationV2ProjectedTurnItem: Codable, Equatable, Sendable, Identifiable {
    public let position: Int
    public let visibility: OrchestrationV2TurnItemVisibility
    public let sourceThreadId: String
    public let sourceItemId: String
    public let item: OrchestrationV2TurnItem

    public init(
        position: Int,
        visibility: OrchestrationV2TurnItemVisibility,
        sourceThreadId: String,
        sourceItemId: String,
        item: OrchestrationV2TurnItem
    ) {
        self.position = position
        self.visibility = visibility
        self.sourceThreadId = sourceThreadId
        self.sourceItemId = sourceItemId
        self.item = item
    }

    /// Inherited items repeat their source id across threads, so identity has to
    /// include the source thread to stay unique inside one projection.
    public var id: String { "\(sourceThreadId)/\(sourceItemId)" }
}

// MARK: - Thread

public struct OrchestrationV2AppThreadLineage: Codable, Equatable, Sendable {
    public let parentThreadId: String?
    public let relationshipToParent: String?
    public let rootThreadId: String
}

public struct OrchestrationV2TitleRegeneration: Codable, Equatable, Sendable {
    public let requestId: String
    public let startedAt: OrchestrationV2Timestamp
}

public struct OrchestrationV2AppThread: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let projectId: String
    /// Who and what created the thread. `creationSource` is what distinguishes a
    /// scheduler-fired thread from a hand-started one, so badges depend on it.
    public let createdBy: String
    public let creationSource: String
    public let title: String
    public let titleRevision: Int?
    public let titleOrigin: String?
    public let providerInstanceId: String
    public let modelSelection: ModelSelection
    public let runtimeMode: RuntimeMode
    public let interactionMode: InteractionMode
    public let branch: String?
    public let worktreePath: String?
    public let activeProviderThreadId: String?
    public let historyOrigin: String?
    public let lineage: OrchestrationV2AppThreadLineage
    public let forkedFrom: OrchestrationV2ForkSource?
    public let createdAt: OrchestrationV2Timestamp
    public let updatedAt: OrchestrationV2Timestamp
    public let archivedAt: OrchestrationV2Timestamp?
    public let settledOverride: String?
    public let settledAt: OrchestrationV2Timestamp?
    public let pinnedAt: OrchestrationV2Timestamp?
    public let workInboxRole: String?
    public let timelineClearedAt: OrchestrationV2Timestamp?
    public let snoozedUntil: OrchestrationV2Timestamp?
    public let snoozedAt: OrchestrationV2Timestamp?
    public let lastVisitedAt: OrchestrationV2Timestamp?
    public let titleRegeneration: OrchestrationV2TitleRegeneration?
    public let deletedAt: OrchestrationV2Timestamp?
}

// MARK: - Projection

/// The thread projection. Only the collections this client reads are modeled;
/// unmodeled keys decode away harmlessly, which keeps the client from breaking
/// when the server grows the projection.
// MARK: - Relational tables
//
// The projection carries these alongside the turn items. They are narrowed to
// the fields the client reads: the activity inspector resolves an item's
// supporting rows through them, which is what turns "a tool call failed" into
// "attempt 2 of 3 failed because the provider session ended".

public struct OrchestrationV2RunAttempt: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let runId: String
    public let attemptOrdinal: Int
    public let status: String
    public let reason: String?
}

public struct OrchestrationV2ExecutionNode: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let status: String
    public let runtimeRequestId: String?
}

public struct OrchestrationV2ProviderSession: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let status: String
    public let model: String?
    public let cwd: String?
    /// What the driver behind this session can actually do. Absent means the
    /// server predates the descriptor, which reads as "no capability evidence"
    /// rather than as a denial-by-default at every call site.
    public let capabilities: OrchestrationV2ProviderCapabilities?
}

public struct OrchestrationV2ProviderThread: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let providerInstanceId: String
    public let providerSessionId: String?
    /// The app thread this provider thread belongs to. Null while a provider
    /// thread exists without an owning app thread (a subagent's own thread, or
    /// one recovered from the provider before it was adopted).
    public let appThreadId: String?
    public let status: String
}

public struct OrchestrationV2ProviderTurn: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// The run attempt this turn belongs to. This is the only join from a
    /// provider turn back to the run that asked for it, so steering and queue
    /// state cannot be resolved without it.
    public let runAttemptId: String?
    public let status: String
}

public struct OrchestrationV2ResponseCapability: Codable, Equatable, Sendable {
    public let type: String
    public let reason: String?
}

public struct OrchestrationV2RuntimeRequest: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let status: String
    public let responseCapability: OrchestrationV2ResponseCapability?
}

public struct OrchestrationV2Checkpoint: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let scopeId: String
    public let status: String
    public let files: [OrchestrationV2CheckpointFileSummary]
}

public struct OrchestrationV2Subagent: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// The thread that owns this subagent row — the parent half of every
    /// subagent edge in the relationship graph.
    public let threadId: String
    /// The subagent's own thread, when the driver exposes one. Null for drivers
    /// that run subagents without addressable threads; the relationship surfaces
    /// use it both as the navigation target and as the orb seed, so a subagent
    /// without it renders but cannot be opened.
    public let childThreadId: String?
    /// The driver's own label for the task, used verbatim as the row title.
    public let title: String?
    public let origin: String
    public let status: String
    public let progress: String?
    public let result: String?
    /// Observability annotations. Absent means "this driver does not report it",
    /// which clients render as nothing rather than as a zero.
    public let workflow: OrchestrationV2WorkflowProgress?
    public let usage: OrchestrationV2TaskUsage?
}

public struct OrchestrationV2ContextHandoff: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let transferId: String?
    public let status: String
}

public struct OrchestrationV2TransferResolution: Codable, Equatable, Sendable {
    public let strategy: String?
}

public struct OrchestrationV2ContextTransfer: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let type: String
    /// The two ends of the transfer edge. Without them a transfer row knows it
    /// happened but not between which threads, which is the whole of what the
    /// lineage graph draws.
    public let sourceThreadId: String
    public let targetThreadId: String
    public let status: String
    public let resolution: OrchestrationV2TransferResolution?
}

/// A run, narrowed to what drives the thread header and the queue control. The
/// projection carries far more per run; the rest is modeled when a feature
/// needs it.
public struct OrchestrationV2Run: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let ordinal: Int
    public let status: String
    /// The provider instance and model the run executed on. A handoff item
    /// persisted before models were stamped carries only instance ids, and this
    /// is what lets the timeline recover the model it handed off from.
    public let providerInstanceId: String?
    public let modelSelection: ModelSelection?
    /// The provider thread the run executes against. Null before the run has
    /// been assigned one.
    public let providerThreadId: String?
    /// The user message that asked for this run. This is what lets a queued run
    /// be rendered as the message the user typed rather than as a bare ordinal.
    /// Non-null in the contract, so it decodes as required — same as `id`.
    public let userMessageId: String
    /// The attempt currently owning the run. Null between attempts — a run that
    /// was interrupted and not yet restarted has none.
    public let activeAttemptId: String?
    /// Explicit position in the thread's queue when the server assigned one.
    /// Absent on runs that were never queued; callers fall back to `ordinal`.
    public let queuePosition: Int?
    public let requestedAt: OrchestrationV2Timestamp
    public let startedAt: OrchestrationV2Timestamp?
    public let completedAt: OrchestrationV2Timestamp?
}

/// A conversation message row.
///
/// Distinct from the `user_message` / `assistant_message` turn items: those are
/// transcript entries scoped to a run, while these are the thread's message
/// table, which is what a queued run's `userMessageId` resolves against and
/// what survives a timeline clear.
public struct OrchestrationV2ConversationMessage: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let threadId: String
    public let runId: String?
    public let nodeId: String?
    public let role: String
    public let text: String
    public let attachments: [ChatAttachment]
    public let streaming: Bool
    /// Only messages carry the creation fields on this table; a message written
    /// by the scheduler is what distinguishes an automated turn from a typed one.
    public let createdBy: String?
    public let creationSource: String?
    public let createdAt: OrchestrationV2Timestamp
    public let updatedAt: OrchestrationV2Timestamp

    private enum CodingKeys: String, CodingKey {
        case id, threadId, runId, nodeId, role, text, attachments, streaming
        case createdBy, creationSource, createdAt, updatedAt
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        threadId = try container.decode(String.self, forKey: .threadId)
        runId = try container.decodeIfPresent(String.self, forKey: .runId)
        nodeId = try container.decodeIfPresent(String.self, forKey: .nodeId)
        role = try container.decode(String.self, forKey: .role)
        // A message with no text is a legitimate attachments-only send, so an
        // absent body degrades to empty rather than failing the projection.
        text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
        attachments = try container.decodeIfPresent(
            [ChatAttachment].self, forKey: .attachments
        ) ?? []
        streaming = try container.decodeIfPresent(Bool.self, forKey: .streaming) ?? false
        createdBy = try container.decodeIfPresent(String.self, forKey: .createdBy)
        creationSource = try container.decodeIfPresent(String.self, forKey: .creationSource)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
    }
}

public struct OrchestrationV2ThreadProjection: Codable, Equatable, Sendable {
    public let thread: OrchestrationV2AppThread
    public let runs: [OrchestrationV2Run]
    public let attempts: [OrchestrationV2RunAttempt]
    public let nodes: [OrchestrationV2ExecutionNode]
    public let subagents: [OrchestrationV2Subagent]
    public let providerSessions: [OrchestrationV2ProviderSession]
    public let providerThreads: [OrchestrationV2ProviderThread]
    public let providerTurns: [OrchestrationV2ProviderTurn]
    public let runtimeRequests: [OrchestrationV2RuntimeRequest]
    public let checkpoints: [OrchestrationV2Checkpoint]
    public let contextHandoffs: [OrchestrationV2ContextHandoff]
    public let contextTransfers: [OrchestrationV2ContextTransfer]
    /// The thread's message table. Turn items carry the transcript; this is what
    /// a run's `userMessageId` resolves against.
    public let messages: [OrchestrationV2ConversationMessage]
    public let turnItems: [OrchestrationV2TurnItem]
    public let visibleTurnItems: [OrchestrationV2ProjectedTurnItem]
    /// Number of older visible items omitted when the snapshot was windowed.
    /// Absent on complete projections — this is the fork's replacement for
    /// upstream's keyset `hasMore`.
    public let truncatedVisibleItemCount: Int?
    public let updatedAt: OrchestrationV2Timestamp

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        thread = try container.decode(OrchestrationV2AppThread.self, forKey: .thread)
        runs = try container.decodeIfPresent([OrchestrationV2Run].self, forKey: .runs) ?? []
        attempts = try container.decodeIfPresent([OrchestrationV2RunAttempt].self, forKey: .attempts) ?? []
        nodes = try container.decodeIfPresent([OrchestrationV2ExecutionNode].self, forKey: .nodes) ?? []
        subagents = try container.decodeIfPresent([OrchestrationV2Subagent].self, forKey: .subagents) ?? []
        providerSessions = try container.decodeIfPresent(
            [OrchestrationV2ProviderSession].self, forKey: .providerSessions
        ) ?? []
        providerThreads = try container.decodeIfPresent(
            [OrchestrationV2ProviderThread].self, forKey: .providerThreads
        ) ?? []
        providerTurns = try container.decodeIfPresent(
            [OrchestrationV2ProviderTurn].self, forKey: .providerTurns
        ) ?? []
        runtimeRequests = try container.decodeIfPresent(
            [OrchestrationV2RuntimeRequest].self, forKey: .runtimeRequests
        ) ?? []
        checkpoints = try container.decodeIfPresent(
            [OrchestrationV2Checkpoint].self, forKey: .checkpoints
        ) ?? []
        contextHandoffs = try container.decodeIfPresent(
            [OrchestrationV2ContextHandoff].self, forKey: .contextHandoffs
        ) ?? []
        contextTransfers = try container.decodeIfPresent(
            [OrchestrationV2ContextTransfer].self, forKey: .contextTransfers
        ) ?? []
        messages = try container.decodeIfPresent(
            [OrchestrationV2ConversationMessage].self, forKey: .messages
        ) ?? []
        turnItems = try container.decodeIfPresent([OrchestrationV2TurnItem].self, forKey: .turnItems) ?? []
        visibleTurnItems = try container.decodeIfPresent(
            [OrchestrationV2ProjectedTurnItem].self, forKey: .visibleTurnItems
        ) ?? []
        truncatedVisibleItemCount = try container.decodeIfPresent(
            Int.self, forKey: .truncatedVisibleItemCount
        )
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
    }

    public var hasOlderItems: Bool { (truncatedVisibleItemCount ?? 0) > 0 }

    /// Memberwise copy-with. The type has a custom `init(from:)`, which
    /// suppresses the synthesized memberwise initializer, and the live-event
    /// reducer needs to produce modified copies.
    public init(
        thread: OrchestrationV2AppThread,
        runs: [OrchestrationV2Run],
        attempts: [OrchestrationV2RunAttempt] = [],
        nodes: [OrchestrationV2ExecutionNode] = [],
        subagents: [OrchestrationV2Subagent] = [],
        providerSessions: [OrchestrationV2ProviderSession] = [],
        providerThreads: [OrchestrationV2ProviderThread] = [],
        providerTurns: [OrchestrationV2ProviderTurn] = [],
        runtimeRequests: [OrchestrationV2RuntimeRequest] = [],
        checkpoints: [OrchestrationV2Checkpoint] = [],
        contextHandoffs: [OrchestrationV2ContextHandoff] = [],
        contextTransfers: [OrchestrationV2ContextTransfer] = [],
        messages: [OrchestrationV2ConversationMessage] = [],
        turnItems: [OrchestrationV2TurnItem],
        visibleTurnItems: [OrchestrationV2ProjectedTurnItem],
        truncatedVisibleItemCount: Int?,
        updatedAt: OrchestrationV2Timestamp
    ) {
        self.thread = thread
        self.runs = runs
        self.attempts = attempts
        self.nodes = nodes
        self.subagents = subagents
        self.providerSessions = providerSessions
        self.providerThreads = providerThreads
        self.providerTurns = providerTurns
        self.runtimeRequests = runtimeRequests
        self.checkpoints = checkpoints
        self.contextHandoffs = contextHandoffs
        self.contextTransfers = contextTransfers
        self.messages = messages
        self.turnItems = turnItems
        self.visibleTurnItems = visibleTurnItems
        self.truncatedVisibleItemCount = truncatedVisibleItemCount
        self.updatedAt = updatedAt
    }

    public func replacing(
        thread: OrchestrationV2AppThread? = nil,
        runs: [OrchestrationV2Run]? = nil,
        messages: [OrchestrationV2ConversationMessage]? = nil,
        turnItems: [OrchestrationV2TurnItem]? = nil,
        visibleTurnItems: [OrchestrationV2ProjectedTurnItem]? = nil
    ) -> OrchestrationV2ThreadProjection {
        OrchestrationV2ThreadProjection(
            thread: thread ?? self.thread,
            runs: runs ?? self.runs,
            attempts: attempts,
            nodes: nodes,
            subagents: subagents,
            providerSessions: providerSessions,
            providerThreads: providerThreads,
            providerTurns: providerTurns,
            runtimeRequests: runtimeRequests,
            checkpoints: checkpoints,
            contextHandoffs: contextHandoffs,
            contextTransfers: contextTransfers,
            messages: messages ?? self.messages,
            turnItems: turnItems ?? self.turnItems,
            visibleTurnItems: visibleTurnItems ?? self.visibleTurnItems,
            truncatedVisibleItemCount: truncatedVisibleItemCount,
            updatedAt: updatedAt
        )
    }
}

public struct OrchestrationV2ThreadDetailSnapshot: Codable, Equatable, Sendable {
    public let snapshotSequence: Int
    public let projection: OrchestrationV2ThreadProjection
}

// MARK: - Shell

public struct OrchestrationV2PendingRuntimeRequestSummary: Codable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let createdAt: OrchestrationV2Timestamp
}

public struct OrchestrationV2LatestVisibleMessageSummary: Codable, Equatable, Sendable {
    public let id: String
    public let role: String
    public let text: String
    public let updatedAt: OrchestrationV2Timestamp
}

/// The home list's per-thread row. V2 replaced V1's `latestTurn` / `session` /
/// `hasPendingApprovals` / `hasPendingUserInput` with a run status, a single
/// pending runtime request, and precomputed counts.
public struct OrchestrationV2ThreadShell: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var projectId: String
    public var createdBy: String
    public var creationSource: String
    public var title: String
    public var titleRevision: Int?
    public var titleOrigin: String?
    public var providerInstanceId: String
    public var modelSelection: ModelSelection
    public var runtimeMode: RuntimeMode
    public var interactionMode: InteractionMode
    public var branch: String?
    public var worktreePath: String?
    public var lineage: OrchestrationV2AppThreadLineage
    public var forkedFrom: OrchestrationV2ForkSource?
    public var activeProviderThreadId: String?
    public var historyOrigin: String?
    public var latestRunId: String?
    public var latestRunRequestedAt: OrchestrationV2Timestamp?
    public var latestRunStartedAt: OrchestrationV2Timestamp?
    public var latestRunCompletedAt: OrchestrationV2Timestamp?
    public var activeRunId: String?
    /// `idle` or a run status.
    public var status: String
    public var lastError: String?
    public var pendingRuntimeRequest: OrchestrationV2PendingRuntimeRequestSummary?
    public var latestVisibleMessage: OrchestrationV2LatestVisibleMessageSummary?
    public var latestUserMessageAt: OrchestrationV2Timestamp?
    public var hasActionableProposedPlan: Bool
    /// Background commands still running. Deliberately never persisted server
    /// side, so it is absent rather than zero on a cached read.
    public var backgroundProcessCount: Int?
    public var itemCount: Int
    public var visibleItemCount: Int
    public var createdAt: OrchestrationV2Timestamp
    public var updatedAt: OrchestrationV2Timestamp
    public var archivedAt: OrchestrationV2Timestamp?
    public var settledOverride: String?
    public var settledAt: OrchestrationV2Timestamp?
    public var pinnedAt: OrchestrationV2Timestamp?
    public var workInboxRole: String?
    public var timelineClearedAt: OrchestrationV2Timestamp?
    public var snoozedUntil: OrchestrationV2Timestamp?
    public var snoozedAt: OrchestrationV2Timestamp?
    /// Absent on servers predating server-side visited tracking; clients fall
    /// back to local visited state when it is nil.
    public var lastVisitedAt: OrchestrationV2Timestamp?
    public var titleRegeneration: OrchestrationV2TitleRegeneration?
    public var deletedAt: OrchestrationV2Timestamp?
}

public struct OrchestrationV2ShellSnapshot: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var snapshotSequence: Int
    public var projects: [OrchestrationProject]
    public var threads: [OrchestrationV2ThreadShell]
    public var archivedThreads: [OrchestrationV2ThreadShell]

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
        snapshotSequence = try container.decode(Int.self, forKey: .snapshotSequence)
        projects = try container.decodeIfPresent([OrchestrationProject].self, forKey: .projects) ?? []
        threads = try container.decodeIfPresent([OrchestrationV2ThreadShell].self, forKey: .threads) ?? []
        archivedThreads = try container.decodeIfPresent(
            [OrchestrationV2ThreadShell].self, forKey: .archivedThreads
        ) ?? []
    }
}

/// Live shell subscription frames.
///
/// V2 renamed every granular frame (`project-upserted` became `project.updated`,
/// and so on) and added a `location` telling the client whether a thread belongs
/// to the active list or the archive.
public enum OrchestrationV2ShellStreamItem: Decodable, Sendable {
    case synchronized
    case snapshot(OrchestrationV2ShellSnapshot)
    case projectUpdated(sequence: Int, project: OrchestrationProject)
    case projectRemoved(sequence: Int, projectID: String)
    case threadUpdated(sequence: Int, location: Location, thread: OrchestrationV2ThreadShell)
    case threadRemoved(sequence: Int, location: Location, threadID: String)

    public enum Location: String, Decodable, Sendable {
        case active
        case archive
    }

    private enum CodingKeys: String, CodingKey {
        case kind, sequence, snapshot, project, projectId, thread, threadId, location
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)

        func location() throws -> Location {
            try container.decodeIfPresent(Location.self, forKey: .location) ?? .active
        }

        switch kind {
        case "synchronized":
            self = .synchronized
        case "snapshot":
            self = .snapshot(
                try container.decode(OrchestrationV2ShellSnapshot.self, forKey: .snapshot)
            )
        case "project.updated":
            self = .projectUpdated(
                sequence: try container.decode(Int.self, forKey: .sequence),
                project: try container.decode(OrchestrationProject.self, forKey: .project)
            )
        case "project.removed":
            self = .projectRemoved(
                sequence: try container.decode(Int.self, forKey: .sequence),
                projectID: try container.decode(String.self, forKey: .projectId)
            )
        case "thread.updated":
            self = .threadUpdated(
                sequence: try container.decode(Int.self, forKey: .sequence),
                location: try location(),
                thread: try container.decode(OrchestrationV2ThreadShell.self, forKey: .thread)
            )
        case "thread.removed":
            self = .threadRemoved(
                sequence: try container.decode(Int.self, forKey: .sequence),
                location: try location(),
                threadID: try container.decode(String.self, forKey: .threadId)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "Unknown shell stream item \(kind)"
            )
        }
    }
}

/// Live thread subscription frames.
///
/// The wire shape differs from upstream V1 in two ways that matter: the snapshot
/// fields are inline rather than nested under a `snapshot` key, and events carry
/// their own `sequence`.
public enum OrchestrationV2ThreadStreamItem: Decodable, Sendable {
    case synchronized
    case snapshot(OrchestrationV2ThreadDetailSnapshot)
    case event(sequence: Int, event: JSONValue)

    private enum CodingKeys: String, CodingKey {
        case kind, snapshotSequence, projection, sequence, event
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "synchronized":
            self = .synchronized
        case "snapshot":
            self = .snapshot(
                OrchestrationV2ThreadDetailSnapshot(
                    snapshotSequence: try container.decode(Int.self, forKey: .snapshotSequence),
                    projection: try container.decode(
                        OrchestrationV2ThreadProjection.self, forKey: .projection
                    )
                )
            )
        case "event":
            self = .event(
                sequence: try container.decode(Int.self, forKey: .sequence),
                event: try container.decode(JSONValue.self, forKey: .event)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "Unknown thread stream item \(kind)"
            )
        }
    }
}

public extension OrchestrationV2ThreadProjection {
    /// Whether the projection already contains a given user message.
    ///
    /// Outbox reconciliation asks this to decide whether an optimistic send was
    /// committed, so it matches on the message id the client generated rather
    /// than on the turn item id the server assigned.
    func containsUserMessage(id: String) -> Bool {
        turnItems.contains { item in
            guard case let .userMessage(messageID, _, _, _) = item.payload else { return false }
            return messageID == id
        }
    }

    var hasAnyUserMessage: Bool {
        turnItems.contains { item in
            if case .userMessage = item.payload { return true }
            return false
        }
    }
}
