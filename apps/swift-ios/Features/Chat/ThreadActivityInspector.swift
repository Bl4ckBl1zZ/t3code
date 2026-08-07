import Foundation

// The detail sheet behind a work-log row. Ported from
// apps/mobile/src/lib/threadActivityInspector.ts so both clients read the same
// projection into the same fields, blocks, and rollback affordance.

public struct ThreadActivityInspectorField: Equatable, Sendable {
    public let label: String
    public let value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

public struct ThreadActivityInspectorBlock: Equatable, Sendable {
    public let label: String
    public let value: String
    public let monospaced: Bool

    public init(label: String, value: String, monospaced: Bool) {
        self.label = label
        self.value = value
        self.monospaced = monospaced
    }
}

public struct ThreadActivityFileLink: Equatable, Sendable {
    public let label: String
    public let path: String
    public let line: Int?

    public init(label: String, path: String, line: Int? = nil) {
        self.label = label
        self.path = path
        self.line = line
    }
}

public struct ThreadActivityWebLink: Equatable, Sendable {
    public let label: String
    public let url: String

    public init(label: String, url: String) {
        self.label = label
        self.url = url
    }
}

public struct ThreadActivityRollbackTarget: Equatable, Sendable {
    public let threadID: String
    public let checkpointID: String
    public let scopeID: String

    public init(threadID: String, checkpointID: String, scopeID: String) {
        self.threadID = threadID
        self.checkpointID = checkpointID
        self.scopeID = scopeID
    }
}

public struct ThreadActivityInspectorModel: Equatable, Sendable {
    public let fields: [ThreadActivityInspectorField]
    public let blocks: [ThreadActivityInspectorBlock]
    public let fileLinks: [ThreadActivityFileLink]
    public let webLinks: [ThreadActivityWebLink]
    /// Unified diff for file changes, rendered by the diff viewer instead of a
    /// text block.
    public let diff: String?
    /// Structured changed-file list for checkpoints, rendered as rows instead
    /// of text.
    public let checkpointFiles: [OrchestrationV2CheckpointFileSummary]?
    public let canRollback: Bool
    public let rollbackTarget: ThreadActivityRollbackTarget?
    public let structuredDetails: String
}

/// The relational V2 entities that enrich one projected item, narrowed to the
/// fields the inspector reads.
///
/// `Core` models the projection's threads, runs, and turn items but not its
/// attempt / node / provider / checkpoint tables, so the inspector takes this
/// as an input rather than resolving it from a projection the way the RN
/// client's `resolveV2ItemSupport` does.
public struct ThreadActivityItemSupport: Equatable, Sendable {
    public struct Run: Equatable, Sendable {
        public let status: String

        public init(status: String) {
            self.status = status
        }
    }

    public struct Attempt: Equatable, Sendable {
        public let attemptOrdinal: Int
        public let status: String
        public let reason: String

        public init(attemptOrdinal: Int, status: String, reason: String) {
            self.attemptOrdinal = attemptOrdinal
            self.status = status
            self.reason = reason
        }
    }

    public struct Node: Equatable, Sendable {
        public let kind: String
        public let status: String

        public init(kind: String, status: String) {
            self.kind = kind
            self.status = status
        }
    }

    public struct ProviderThread: Equatable, Sendable {
        public let providerInstanceID: String
        public let status: String

        public init(providerInstanceID: String, status: String) {
            self.providerInstanceID = providerInstanceID
            self.status = status
        }
    }

    public struct ProviderTurn: Equatable, Sendable {
        public let status: String

        public init(status: String) {
            self.status = status
        }
    }

    public struct ProviderSession: Equatable, Sendable {
        public let status: String
        public let model: String?
        public let cwd: String

        public init(status: String, model: String?, cwd: String) {
            self.status = status
            self.model = model
            self.cwd = cwd
        }
    }

    public struct RuntimeRequest: Equatable, Sendable {
        public let status: String
        /// `live` or `not_resumable` — whether the request can still be answered.
        public let responseCapabilityType: String

        public init(status: String, responseCapabilityType: String) {
            self.status = status
            self.responseCapabilityType = responseCapabilityType
        }
    }

    public struct Checkpoint: Equatable, Sendable {
        public let id: String
        public let scopeID: String
        public let status: String

        public init(id: String, scopeID: String, status: String) {
            self.id = id
            self.scopeID = scopeID
            self.status = status
        }
    }

    public struct Subagent: Equatable, Sendable {
        public let origin: String
        public let status: String
        public let progress: String?
        public let result: String?

        public init(origin: String, status: String, progress: String?, result: String?) {
            self.origin = origin
            self.status = status
            self.progress = progress
            self.result = result
        }
    }

    public struct ContextHandoff: Equatable, Sendable {
        public let status: String

        public init(status: String) {
            self.status = status
        }
    }

    public struct ContextTransfer: Equatable, Sendable {
        public struct Resolution: Equatable, Sendable {
            public let strategy: String

            public init(strategy: String) {
                self.strategy = strategy
            }
        }

        public let type: String
        public let status: String
        public let resolution: Resolution?

        public init(type: String, status: String, resolution: Resolution?) {
            self.type = type
            self.status = status
            self.resolution = resolution
        }
    }

    public let run: Run?
    public let attempts: [Attempt]
    public let node: Node?
    public let providerSession: ProviderSession?
    public let providerThread: ProviderThread?
    public let providerTurn: ProviderTurn?
    public let runtimeRequest: RuntimeRequest?
    public let checkpoint: Checkpoint?
    public let subagent: Subagent?
    public let contextHandoff: ContextHandoff?
    public let contextTransfer: ContextTransfer?

    public init(
        run: Run? = nil,
        attempts: [Attempt] = [],
        node: Node? = nil,
        providerSession: ProviderSession? = nil,
        providerThread: ProviderThread? = nil,
        providerTurn: ProviderTurn? = nil,
        runtimeRequest: RuntimeRequest? = nil,
        checkpoint: Checkpoint? = nil,
        subagent: Subagent? = nil,
        contextHandoff: ContextHandoff? = nil,
        contextTransfer: ContextTransfer? = nil
    ) {
        self.run = run
        self.attempts = attempts
        self.node = node
        self.providerSession = providerSession
        self.providerThread = providerThread
        self.providerTurn = providerTurn
        self.runtimeRequest = runtimeRequest
        self.checkpoint = checkpoint
        self.subagent = subagent
        self.contextHandoff = contextHandoff
        self.contextTransfer = contextTransfer
    }

    public static let empty = ThreadActivityItemSupport()
}

public enum ThreadActivityInspector {
    public static func build(
        row: OrchestrationV2ProjectedTurnItem,
        support: ThreadActivityItemSupport = .empty,
        currentThreadID: String,
        now: Date = Date()
    ) -> ThreadActivityInspectorModel {
        let item = row.item
        var fields: [ThreadActivityInspectorField] = [
            .init(label: "Item", value: spaced(item.type)),
            .init(label: "Status", value: spaced(item.status.rawValue)),
        ]
        if let duration = durationLabel(
            startedAt: item.base.startedAt,
            completedAt: item.base.completedAt,
            now: now
        ) {
            fields.append(.init(label: "Duration", value: duration))
        }
        if row.visibility != .local {
            fields.append(.init(label: "Visibility", value: row.visibility.rawValue))
        }
        if let run = support.run {
            fields.append(.init(label: "Run", value: run.status))
        }
        if let attempt = support.attempts.last {
            fields.append(
                .init(
                    label: "Attempt",
                    value: "\(attempt.attemptOrdinal) · \(attempt.status) · \(spaced(attempt.reason))"
                )
            )
        }
        if let node = support.node {
            fields.append(.init(label: "Node", value: "\(spaced(node.kind)) · \(node.status)"))
        }
        if let providerThread = support.providerThread {
            fields.append(
                .init(
                    label: "Provider thread",
                    value: "\(providerThread.providerInstanceID) · \(providerThread.status)"
                )
            )
        }
        if let providerTurn = support.providerTurn {
            fields.append(.init(label: "Provider turn", value: providerTurn.status))
        }
        if let session = support.providerSession {
            fields.append(
                .init(label: "Session", value: "\(session.status) · \(session.model ?? "default model")")
            )
            fields.append(.init(label: "Working directory", value: session.cwd))
        }
        if let request = support.runtimeRequest {
            fields.append(
                .init(
                    label: "Request",
                    value: "\(request.status) · \(spaced(request.responseCapabilityType))"
                )
            )
        }

        var blocks: [ThreadActivityInspectorBlock] = []
        var fileLinks: [ThreadActivityFileLink] = []
        var webLinks: [ThreadActivityWebLink] = []

        // A single attempt is already summarised by the `Attempt` field; the
        // history only earns its space once the run was restarted.
        if support.attempts.count > 1 {
            addBlock(
                &blocks,
                "Attempt history",
                support.attempts
                    .map { "Attempt \($0.attemptOrdinal) · \($0.status) · \(spaced($0.reason))" }
                    .joined(separator: "\n")
            )
        }

        switch item.payload {
        case let .reasoning(text, _):
            addBlock(&blocks, "Reasoning", text, monospaced: false)

        case let .commandExecution(input, output, exitCode, _):
            addBlock(&blocks, "Command", input)
            addBlock(&blocks, "Output", output)
            if let exitCode {
                addBlock(&blocks, "Exit", "Process exited with code \(exitCode)")
            }

        case let .fileChange(fileName, additions, deletions, diffStr, oldStr, newStr):
            fileLinks.append(.init(label: fileName, path: fileName))
            if additions != nil || deletions != nil {
                fields.append(
                    .init(label: "Changes", value: "+\(additions ?? 0) −\(deletions ?? 0)")
                )
            }
            // Before/after text is the fallback for providers that send no
            // unified diff; with a diff the viewer renders it instead.
            if diffStr?.isEmpty ?? true {
                addBlock(&blocks, "Before", oldStr)
                addBlock(&blocks, "After", newStr)
            }

        case let .fileSearch(pattern, results):
            addBlock(&blocks, "Query", pattern)
            for result in results ?? [] {
                let label: String
                if let preview = result.preview, !preview.isEmpty {
                    label = "\(result.fileName) — \(preview)"
                } else {
                    label = result.fileName
                }
                fileLinks.append(.init(label: label, path: result.fileName, line: result.line))
            }

        case let .webSearch(patterns, results):
            addBlock(&blocks, "Queries", patterns?.joined(separator: "\n"))
            for result in results ?? [] {
                if let url = result.url, !url.isEmpty {
                    webLinks.append(.init(label: result.title ?? url, url: url))
                }
                if let snippet = result.snippet, !snippet.isEmpty {
                    addBlock(&blocks, result.title ?? "Search result", snippet, monospaced: false)
                }
            }

        case let .dynamicTool(_, input, output):
            addBlock(&blocks, "Input", input)
            addBlock(&blocks, "Output", output)

        case let .approvalRequest(_, _, prompt):
            addBlock(&blocks, "Prompt", prompt, monospaced: false)

        case let .userInputRequest(_, questions):
            addBlock(
                &blocks,
                "Questions",
                questions.map(\.question).joined(separator: "\n"),
                monospaced: false
            )

        case let .subagent(_, _, _, _, _, prompt, progress, result):
            addBlock(&blocks, "Prompt", prompt, monospaced: false)
            // The subagent record streams ahead of the turn item, so prefer it
            // when the projection carries one.
            addBlock(&blocks, "Progress", support.subagent?.progress ?? progress, monospaced: false)
            addBlock(&blocks, "Result", support.subagent?.result ?? result, monospaced: false)
            if let subagent = support.subagent {
                fields.append(
                    .init(
                        label: "Delegated task",
                        value: "\(spaced(subagent.origin)) · \(subagent.status)"
                    )
                )
            }

        case let .handoff(_, _, _, _, _, _, strategy, summary):
            addBlock(&blocks, "Summary", summary, monospaced: false)
            fields.append(
                .init(
                    label: "Handoff",
                    value: "\(spaced(strategy)) · \(support.contextHandoff?.status ?? item.status.rawValue)"
                )
            )
            if let transfer = support.contextTransfer {
                fields.append(
                    .init(label: "Transfer", value: "\(spaced(transfer.type)) · \(transfer.status)")
                )
                if let resolution = transfer.resolution {
                    fields.append(.init(label: "Context", value: spaced(resolution.strategy)))
                }
            }

        case let .error(failure, _):
            addBlock(&blocks, "Error", failure.message, monospaced: false)
            if let code = failure.code, !code.isEmpty {
                fields.append(.init(label: "Code", value: code))
            }
            if let retryable = failure.retryable {
                fields.append(.init(label: "Retryable", value: retryable ? "yes" : "no"))
            }

        case let .proposedPlan(_, markdown, _):
            addBlock(&blocks, "Plan", markdown, monospaced: false)

        case let .todoList(_, steps, explanation):
            addBlock(
                &blocks,
                "Tasks",
                steps
                    .map { "\($0.status == "completed" ? "✓" : "○") \($0.text)" }
                    .joined(separator: "\n"),
                monospaced: false
            )
            addBlock(&blocks, "Explanation", explanation, monospaced: false)

        case let .compaction(_, summary, beforeTokenCount, afterTokenCount):
            addBlock(&blocks, "Summary", summary, monospaced: false)
            if beforeTokenCount != nil || afterTokenCount != nil {
                fields.append(
                    .init(
                        label: "Context tokens",
                        value: "\(beforeTokenCount.map(String.init) ?? "?") → \(afterTokenCount.map(String.init) ?? "?")"
                    )
                )
            }

        case let .runInterruptRequest(message), let .runInterruptResult(message):
            addBlock(&blocks, "Message", message, monospaced: false)

        // Checkpoints render their file list as rows, and forks, thread
        // creations, and chat messages have nothing beyond the common fields.
        case .checkpoint, .checkpointRollback, .fork, .threadCreated, .userMessage,
            .assistantMessage, .unknown:
            break
        }

        var checkpointFiles: [OrchestrationV2CheckpointFileSummary]?
        if case let .checkpoint(_, _, files) = item.payload {
            checkpointFiles = files
        }

        // Rolling back rewrites the owning thread's history, so the affordance
        // only appears on the thread that captured the checkpoint — never on a
        // child that merely inherited the row.
        var rollbackTarget: ThreadActivityRollbackTarget?
        if checkpointFiles != nil,
            row.sourceThreadId == currentThreadID,
            let checkpoint = support.checkpoint,
            checkpoint.status == "ready" {
            rollbackTarget = ThreadActivityRollbackTarget(
                threadID: row.sourceThreadId,
                checkpointID: checkpoint.id,
                scopeID: checkpoint.scopeID
            )
        }

        var diff: String?
        if case let .fileChange(_, _, _, diffStr, _, _) = item.payload {
            diff = diffStr
        }

        return ThreadActivityInspectorModel(
            fields: fields,
            blocks: blocks,
            fileLinks: fileLinks,
            webLinks: webLinks,
            diff: diff,
            checkpointFiles: checkpointFiles,
            canRollback: rollbackTarget != nil,
            rollbackTarget: rollbackTarget,
            structuredDetails: structuredDetails(for: row)
        )
    }

    // MARK: - Field helpers

    /// Wire enums are snake_case; the inspector reads them as prose.
    private static func spaced(_ value: String) -> String {
        value.replacingOccurrences(of: "_", with: " ")
    }

    private static func addBlock(
        _ blocks: inout [ThreadActivityInspectorBlock],
        _ label: String,
        _ value: String?,
        monospaced: Bool = true
    ) {
        guard let value, !value.isEmpty else { return }
        blocks.append(.init(label: label, value: value, monospaced: monospaced))
    }

    /// Provider-defined payloads (dynamic tool input and output) arrive as raw
    /// JSON. A JSON string renders as its text; anything else is pretty-printed.
    private static func addBlock(
        _ blocks: inout [ThreadActivityInspectorBlock],
        _ label: String,
        _ value: JSONValue?,
        monospaced: Bool = true
    ) {
        guard let value else { return }
        switch value {
        case .null:
            return
        case let .string(text):
            addBlock(&blocks, label, text, monospaced: monospaced)
        default:
            blocks.append(
                .init(label: label, value: stringify(value, indent: 0), monospaced: monospaced)
            )
        }
    }

    // MARK: - Duration

    /// An item that started but has not completed is still running, so its
    /// duration is measured against the clock rather than left blank.
    private static func durationLabel(
        startedAt: OrchestrationV2Timestamp?,
        completedAt: OrchestrationV2Timestamp?,
        now: Date
    ) -> String? {
        guard let start = parseTimestamp(startedAt) else { return nil }
        let end = parseTimestamp(completedAt) ?? now
        return formatDuration(max(0, (end.timeIntervalSince(start) * 1000).rounded()))
    }

    /// Mirrors `formatDuration` in packages/shared/src/orchestrationTiming.ts.
    static func formatDuration(_ durationMs: Double) -> String {
        guard durationMs.isFinite, durationMs >= 0 else { return "0ms" }
        if durationMs < 1_000 { return "\(Int(max(1, durationMs.rounded())))ms" }
        if durationMs < 10_000 { return String(format: "%.1fs", durationMs / 1_000) }
        if durationMs < 60_000 { return "\(Int((durationMs / 1_000).rounded()))s" }
        let minutes = Int(durationMs / 60_000)
        let seconds = Int((durationMs.truncatingRemainder(dividingBy: 60_000) / 1_000).rounded())
        if seconds == 0 { return "\(minutes)m" }
        if seconds == 60 { return "\(minutes + 1)m" }
        return "\(minutes)m \(seconds)s"
    }

    private static func parseTimestamp(_ value: OrchestrationV2Timestamp?) -> Date? {
        guard let value else { return nil }
        return fractionalTimestampParser.date(from: value) ?? timestampParser.date(from: value)
    }

    /// Fractional seconds are the norm on the wire, but the plain form still
    /// appears; an unparsable timestamp drops the duration rather than the row.
    private static let fractionalTimestampParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let timestampParser = ISO8601DateFormatter()

    // MARK: - Structured details

    /// The raw row, for the "copy details" escape hatch when the curated fields
    /// do not explain what happened.
    private static func structuredDetails(for row: OrchestrationV2ProjectedTurnItem) -> String {
        let item = (try? JSONValue.encode(row.item)) ?? .null
        return stringifyObject(
            [
                ("visibility", .string(row.visibility.rawValue)),
                ("sourceThreadId", .string(row.sourceThreadId)),
                ("sourceItemId", .string(row.sourceItemId)),
                ("item", item),
            ],
            indent: 0
        )
    }

    /// `JSON.stringify(value, null, 2)`, which `JSONSerialization.prettyPrinted`
    /// does not match — it emits `"key" : value` with a space before the colon.
    /// Object keys are sorted, since Swift dictionaries have no insertion order
    /// to preserve.
    private static func stringify(_ value: JSONValue, indent: Int) -> String {
        switch value {
        case .null:
            return "null"
        case let .bool(flag):
            return flag ? "true" : "false"
        case let .integer(number):
            return String(number)
        case let .unsignedInteger(number):
            return String(number)
        case let .number(number):
            return numberLiteral(number)
        case let .string(text):
            return quoted(text)
        case let .array(items):
            guard !items.isEmpty else { return "[]" }
            let inner = String(repeating: " ", count: (indent + 1) * 2)
            let body = items
                .map { inner + stringify($0, indent: indent + 1) }
                .joined(separator: ",\n")
            return "[\n\(body)\n\(String(repeating: " ", count: indent * 2))]"
        case let .object(entries):
            return stringifyObject(
                entries.keys.sorted().map { ($0, entries[$0] ?? .null) },
                indent: indent
            )
        }
    }

    private static func stringifyObject(
        _ entries: [(String, JSONValue)],
        indent: Int
    ) -> String {
        guard !entries.isEmpty else { return "{}" }
        let inner = String(repeating: " ", count: (indent + 1) * 2)
        let body = entries
            .map { inner + quoted($0.0) + ": " + stringify($0.1, indent: indent + 1) }
            .joined(separator: ",\n")
        return "{\n\(body)\n\(String(repeating: " ", count: indent * 2))}"
    }

    private static func numberLiteral(_ value: Double) -> String {
        guard value.isFinite else { return "null" }
        if value == value.rounded(), abs(value) < 1e15 { return String(Int64(value)) }
        return String(value)
    }

    private static func quoted(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}
