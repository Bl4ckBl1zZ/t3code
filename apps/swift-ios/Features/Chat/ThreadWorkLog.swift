import SwiftUI
import UIKit

// Ported from apps/mobile/src/features/threads/thread-work-log.tsx, plus the
// row presentation half of apps/mobile/src/lib/threadActivity.ts
// (`toFeedActivity`) that the rows read.

// MARK: - Row model

public struct ThreadWorkLogDiffStat: Equatable, Sendable {
    public let additions: Int
    public let deletions: Int

    public init(additions: Int, deletions: Int) {
        self.additions = additions
        self.deletions = deletions
    }
}

/// One line of the work log: what a turn item did, in the terms a reader scans.
public struct ThreadWorkLogRow: Identifiable, Equatable, Sendable {
    public enum Icon: String, Equatable, Sendable {
        case agent, alert, check, command, edit, eye, globe, hammer, message, warning, wrench, zap

        var symbolName: String {
            switch self {
            case .agent: "sparkles"
            case .alert: "exclamationmark.triangle"
            case .check: "checkmark"
            case .command: "terminal"
            case .edit: "square.and.pencil"
            case .eye: "eye"
            case .globe: "globe"
            case .hammer: "hammer"
            case .message: "bubble.left"
            case .warning: "xmark"
            case .wrench: "wrench"
            case .zap: "bolt"
            }
        }
    }

    public enum Status: String, Equatable, Sendable {
        case success, failure, neutral
    }

    public let id: String
    public let createdAt: String
    public let runID: String?
    public let summary: String
    public let detail: String?
    public let icon: Icon
    /// Provider tool calls, as opposed to orchestration bookkeeping. A log made
    /// only of tool calls drops its "work log" header.
    public let toolLike: Bool
    /// Rows that open a related thread and therefore earn a card surface.
    public let prominent: Bool
    public let status: Status?
    /// In-flight rows shimmer; terminal ones do not.
    public let inProgress: Bool
    public let projectedItem: OrchestrationV2ProjectedTurnItem

    public var item: OrchestrationV2TurnItem { projectedItem.item }

    /// A `file_change` row headlines its own diffstat.
    public var diffStat: ThreadWorkLogDiffStat? {
        guard case let .fileChange(_, additions, deletions, _, _, _) = item.payload else {
            return nil
        }
        let added = additions ?? 0
        let removed = deletions ?? 0
        return added > 0 || removed > 0
            ? ThreadWorkLogDiffStat(additions: added, deletions: removed)
            : nil
    }

    /// A background command usually starts early in a turn, so the collapsed
    /// log has to pin it: keeping only the last row would hide the one row
    /// still reporting.
    public var isLiveBackgroundCommand: Bool {
        guard case let .commandExecution(_, _, _, liveness) = item.payload else { return false }
        return liveness.background == true && !item.status.isTerminal
    }

    public static func make(_ row: OrchestrationV2ProjectedTurnItem) -> ThreadWorkLogRow {
        let item = row.item
        let toolDisplayName = T3McpToolPresentation.displayName(for: item)
        return ThreadWorkLogRow(
            id: "\(row.visibility.rawValue):\(row.sourceThreadId):\(row.sourceItemId)",
            createdAt: item.base.startedAt ?? item.base.updatedAt,
            runID: item.base.runId,
            summary: ThreadWorkLogPresentation.summary(item, toolDisplayName: toolDisplayName),
            detail: ThreadWorkLogPresentation.preview(item),
            icon: ThreadWorkLogPresentation.icon(item),
            toolLike: ThreadWorkLogPresentation.isToolLike(item),
            prominent: ThreadWorkLogPresentation.isProminent(item),
            status: ThreadWorkLogPresentation.status(item),
            inProgress: !item.status.isTerminal,
            projectedItem: row
        )
    }

    /// Long-press copies the row: what it says, what it previewed, and the raw
    /// item behind both.
    public func copyText(structuredDetails: String) -> String {
        var lines: [String] = []
        for value in [summary, detail, structuredDetails] {
            guard let value, !value.isEmpty, !lines.contains(value) else { continue }
            lines.append(value)
        }
        return lines.joined(separator: "\n")
    }

    /// Tool-like activities with a neutral status carry no signal worth a row.
    public static func visible(_ rows: [ThreadWorkLogRow]) -> [ThreadWorkLogRow] {
        rows.filter { !($0.toolLike && $0.status == .neutral) }
    }

    /// Contiguous rows that fold as one unit. A group is the thing that folds,
    /// so it must not straddle runs — merging a finished run's work into the
    /// live one would make the fold either hide too much or nothing at all —
    /// and a prominent row (one that opens a related thread) always stands
    /// alone rather than being folded away behind a count.
    public static func groups(_ rows: [ThreadWorkLogRow]) -> [[ThreadWorkLogRow]] {
        var groups: [[ThreadWorkLogRow]] = []
        var openRunID: String?
        var openHasProminent = false
        for row in rows {
            if !groups.isEmpty, openRunID == row.runID, !row.prominent, !openHasProminent {
                groups[groups.count - 1].append(row)
                continue
            }
            groups.append([row])
            openRunID = row.runID
            openHasProminent = row.prominent
        }
        return groups
    }

    public static func totalDiffStat(_ rows: [ThreadWorkLogRow]) -> ThreadWorkLogDiffStat {
        var additions = 0
        var deletions = 0
        for row in rows {
            guard let stat = row.diffStat else { continue }
            additions += stat.additions
            deletions += stat.deletions
        }
        return ThreadWorkLogDiffStat(additions: additions, deletions: deletions)
    }

    /// Ported from thread-work-log-labels.ts.
    public static func overflowNoun(onlyToolRows: Bool, count: Int) -> String {
        if onlyToolRows { return count == 1 ? "tool call" : "tool calls" }
        return count == 1 ? "log entry" : "log entries"
    }
}

// MARK: - Row presentation

public enum ThreadWorkLogPresentation {
    static let maxVisibleEntries = 1

    public static func isToolLike(_ item: OrchestrationV2TurnItem) -> Bool {
        switch item.type {
        case "reasoning", "command_execution", "file_change", "file_search", "web_search",
            "approval_request", "user_input_request", "dynamic_tool", "subagent", "error":
            true
        default:
            false
        }
    }

    public static func isProminent(_ item: OrchestrationV2TurnItem) -> Bool {
        item.type == "fork" || item.type == "thread_created" || item.type == "subagent"
    }

    public static func status(_ item: OrchestrationV2TurnItem) -> ThreadWorkLogRow.Status? {
        guard isToolLike(item) else { return nil }
        if item.type == "error" || item.status == .failed { return .failure }
        return item.status == .completed ? .success : .neutral
    }

    public static func icon(_ item: OrchestrationV2TurnItem) -> ThreadWorkLogRow.Icon {
        switch item.payload {
        case .reasoning: .agent
        case .commandExecution: .command
        case .fileChange: .edit
        case .fileSearch: .eye
        case .webSearch: .globe
        case .approvalRequest, .userInputRequest, .userMessage, .assistantMessage: .message
        // Read-style tool calls (a file/notebook path argument) present as reads.
        case let .dynamicTool(_, input, _):
            DynamicToolInputPreview.resolve(input)?.kind == .path ? .eye : .wrench
        case .subagent: .hammer
        case .runInterruptRequest, .runInterruptResult: .warning
        case .error: .alert
        case .checkpoint, .proposedPlan, .todoList: .check
        case .checkpointRollback, .compaction, .handoff, .fork, .threadCreated: .zap
        case .unknown: .wrench
        }
    }

    public static func summary(
        _ item: OrchestrationV2TurnItem,
        toolDisplayName: String? = nil
    ) -> String {
        let title = item.base.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let title, !title.isEmpty {
            return toolDisplayName ?? capitalizePhrase(title)
        }
        switch item.payload {
        case .reasoning:
            return "Thinking"
        case let .commandExecution(_, _, _, liveness):
            // A command that outlives its turn needs to say so: on a phone the
            // turn footer is often the only thing on screen, and "Command" next
            // to a finished turn reads as finished.
            guard liveness.background == true else { return "Command" }
            return liveness.waitKind == "monitor" ? "Waiting for a condition" : "Background command"
        case let .fileChange(fileName, _, _, _, _, _):
            return "Changed \(fileName)"
        case .fileSearch:
            return "Searched files"
        case .webSearch:
            return "Searched the web"
        case .approvalRequest:
            return "Approval requested"
        case .userInputRequest:
            return "Input requested"
        case .checkpoint:
            return "Checkpoint captured"
        case .checkpointRollback:
            return "Rolled back"
        case .runInterruptRequest:
            return "Interrupt requested"
        case .runInterruptResult:
            return "Run interrupted"
        case .error:
            return "Provider error"
        case .compaction:
            return "Chat compacted"
        case .handoff:
            return "Context handed off"
        case .fork:
            return "Thread forked"
        case .threadCreated:
            return "Thread created"
        case .subagent:
            return "Subagent"
        case let .dynamicTool(toolName, _, _):
            return toolDisplayName ?? toolName ?? "Tool call"
        case .proposedPlan:
            return "Proposed plan"
        case .todoList:
            return "Plan updated"
        case .userMessage:
            return "User message"
        case .assistantMessage:
            return "Assistant message"
        case let .unknown(type):
            return capitalizePhrase(type.replacingOccurrences(of: "_", with: " "))
        }
    }

    public static func preview(_ item: OrchestrationV2TurnItem) -> String? {
        switch item.payload {
        case let .reasoning(text, _):
            return text.isEmpty ? nil : text
        case let .commandExecution(input, output, _, liveness):
            // While a background command runs, what it is printing beats what
            // it was asked to do — the command text is already in the summary.
            if liveness.background == true, !item.status.isTerminal {
                return backgroundCommandTail(output) ?? (input.isEmpty ? nil : input)
            }
            return input.isEmpty ? nil : input
        case let .fileChange(fileName, _, _, _, _, _):
            return fileName
        case let .fileSearch(pattern, _):
            return pattern
        case let .webSearch(patterns, _):
            guard let patterns, !patterns.isEmpty else { return nil }
            return patterns.joined(separator: ", ")
        case let .approvalRequest(_, _, prompt):
            return prompt
        case let .userInputRequest(_, questions):
            let joined = questions.map(\.question).joined(separator: " · ")
            return joined.isEmpty ? nil : joined
        case let .checkpoint(_, _, files):
            return files.count == 1 ? files[0].path : "\(files.count) changed files"
        case let .runInterruptRequest(message), let .runInterruptResult(message):
            return message.isEmpty ? nil : message
        case let .error(failure, _):
            // Provider failures arrive wrapped in adapter names, run ids and
            // provider-thread ids. Present the operational next step instead.
            return ProviderErrorPresentation.present(failure.message)
        case let .checkpointRollback(_, _, restoredFileCount, rolledBackRunCount):
            return ThreadLifecycle.rollbackDetail(
                rolledBackRunCount: rolledBackRunCount,
                restoredFileCount: restoredFileCount
            )
        case let .compaction(_, summary, _, _):
            return summary
        case let .handoff(_, _, _, _, _, _, _, summary):
            return summary
        case let .fork(_, targetThreadID, _):
            return targetThreadID
        case let .threadCreated(targetThreadID, _, _, _):
            return targetThreadID
        case let .subagent(_, _, _, _, _, prompt, progress, result):
            return result ?? progress ?? prompt
        case let .dynamicTool(_, input, _):
            // Surface read-style tool arguments inline — otherwise a Read row is
            // just "Read" with the path hidden in the inspector.
            return DynamicToolInputPreview.resolve(input)?.value
        case let .proposedPlan(_, markdown, _):
            return markdown.isEmpty ? nil : markdown
        case let .todoList(_, steps, _):
            let completed = steps.filter { $0.status == "completed" }.count
            return "\(completed)/\(steps.count) completed"
        case let .userMessage(_, _, text, _):
            return text.isEmpty ? nil : text
        case let .assistantMessage(_, text, _):
            return text.isEmpty ? nil : text
        case .unknown:
            return nil
        }
    }

    /// Last line a background command printed, which is its only live signal.
    static func backgroundCommandTail(_ output: String?) -> String? {
        guard let output else { return nil }
        for line in output.split(separator: "\n", omittingEmptySubsequences: false).reversed() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    static func capitalizePhrase(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return value }
        return String(first).uppercased() + trimmed.dropFirst()
    }

    /// The row detail as it is shown: shell wrappers stripped and whitespace
    /// collapsed, so a multi-line command still occupies one line.
    public static func compactDetail(_ detail: String?) -> String? {
        guard let detail else { return nil }
        let cleaned = stripShellWrapper(detail)
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        return cleaned.isEmpty ? nil : cleaned
    }

    static func stripShellWrapper(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefixes = ["/bin/zsh -lc "]
        for prefix in prefixes where trimmed.hasPrefix(prefix) {
            var body = String(trimmed.dropFirst(prefix.count))
            if let first = body.first, first == "'" || first == "\"" {
                body = String(body.dropFirst())
                if body.last == first { body = String(body.dropLast()) }
            }
            return body.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return trimmed
    }

    /// The collapsed log keeps the last row, plus every row still reporting
    /// from the background.
    public static func collapsed(_ rows: [ThreadWorkLogRow]) -> [ThreadWorkLogRow] {
        guard rows.count > maxVisibleEntries else { return rows }
        var kept = Set(rows.suffix(maxVisibleEntries).map(\.id))
        for row in rows where row.isLiveBackgroundCommand { kept.insert(row.id) }
        return rows.filter { kept.contains($0.id) }
    }
}

// MARK: - Dynamic tool input preview

/// Ported from packages/shared/src/dynamicToolPreview.ts.
public enum DynamicToolInputPreview {
    public enum Kind: Equatable, Sendable { case path, pattern }

    public struct Preview: Equatable, Sendable {
        public let kind: Kind
        public let value: String
    }

    /// Argument keys that native read-style tools (Read, NotebookRead, Glob,
    /// Grep, LS, …) use across provider adapters. Paths outrank patterns, so a
    /// Grep with both previews as its pattern only when no file path is present.
    private static let previewKeys: [(key: String, kind: Kind)] = [
        ("file_path", .path),
        ("notebook_path", .path),
        ("pattern", .pattern),
        ("path", .path),
    ]

    public static func resolve(_ input: JSONValue?) -> Preview? {
        guard let input, case .object = input else { return nil }
        for entry in previewKeys {
            guard let value = input[entry.key]?.stringValue else { continue }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return Preview(kind: entry.kind, value: trimmed) }
        }
        return nil
    }
}

// MARK: - T3 MCP tool names

/// Ported from packages/shared/src/t3McpToolPresentation.ts. Without it a
/// delegated-task row reads as `mcp__t3-code__delegate_task`.
public enum T3McpToolPresentation {
    private static let serverAliases: Set<String> = ["t3-code", "t3_code", "t3code"]

    private static let displayNames: [String: String] = [
        "orchestrator_capabilities": "Get orchestration capabilities",
        "delegate_task": "Delegate a child task",
        "task_status": "Get delegated task status",
        "task_cancel": "Cancel delegated task",
        "schedule_task": "Schedule a recurring task",
        "list_scheduled_tasks": "List scheduled tasks",
        "update_scheduled_task": "Update a scheduled task",
        "delete_scheduled_task": "Delete a scheduled task",
        "create_threads": "Create T3 threads",
        "t3_thread_start": "Start a T3 thread",
        "t3_thread_list": "List T3 threads",
        "t3_thread_read": "Read a T3 thread",
        "t3_thread_send": "Send to a T3 thread",
        "t3_thread_wait": "Wait for a T3 thread",
        "t3_thread_interrupt": "Interrupt a T3 thread",
        "t3_worktree_handoff": "Hand off thread to a git worktree",
        "t3_worktree_status": "Get thread worktree status",
        "preview_status": "Get preview browser status",
        "preview_open": "Open a page in the preview browser",
        "preview_navigate": "Navigate the preview browser",
        "preview_snapshot": "Snapshot the preview page",
        "preview_click": "Click in the preview browser",
        "preview_press": "Press a key in the preview browser",
        "preview_type": "Type in the preview browser",
        "preview_scroll": "Scroll the preview browser",
        "preview_resize": "Resize the preview browser",
        "preview_evaluate": "Evaluate script in the preview browser",
        "preview_wait_for": "Wait for the preview page",
        "preview_set_appearance": "Set preview browser appearance",
        "preview_recording_start": "Start recording the preview browser",
        "preview_recording_stop": "Stop recording the preview browser",
    ]

    /// Only dynamic tool rows carry an MCP tool name; every other item type
    /// keeps its own title.
    public static func displayName(for item: OrchestrationV2TurnItem) -> String? {
        guard case let .dynamicTool(toolName, _, _) = item.payload else { return nil }
        return displayName(for: toolName) ?? displayName(for: item.base.title)
    }

    public static func displayName(for toolName: String?) -> String? {
        guard let toolName, let resolved = resolveToolName(toolName) else { return nil }
        return displayNames[resolved]
    }

    private static func resolveToolName(_ value: String) -> String? {
        let label = normalizeLabel(value)
        if label.hasPrefix("mcp__") {
            let body = label.dropFirst("mcp__".count)
            guard let separator = body.range(of: "__") else { return nil }
            let server = String(body[body.startIndex ..< separator.lowerBound]).lowercased()
            let tool = String(body[separator.upperBound...])
            return serverAliases.contains(server) && !tool.isEmpty ? tool : nil
        }
        for alias in serverAliases {
            for separator in [".", ":", "/"] {
                let prefix = alias + separator
                if label.lowercased().hasPrefix(prefix) {
                    let tool = String(label.dropFirst(prefix.count))
                    return tool.isEmpty ? nil : tool
                }
            }
        }
        return displayNames[label] != nil ? label : nil
    }

    /// Providers append a completion word to the tool label once it settles.
    private static func normalizeLabel(_ value: String) -> String {
        var label = value.trimmingCharacters(in: .whitespacesAndNewlines)
        for suffix in [" complete", " completed"] where label.lowercased().hasSuffix(suffix) {
            label = String(label.dropLast(suffix.count))
            break
        }
        return label.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Provider errors

/// Ported from packages/client-runtime/src/errors/providerErrors.ts. Provider
/// errors cross several RPC wrappers before reaching the timeline; present the
/// operational next step instead of adapter names and run ids.
public enum ProviderErrorPresentation {
    private static let protocolPrefix = try? NSRegularExpression(
        pattern: "^(?:ProviderAdapterProtocolError:\\s*)?([a-z][a-z0-9_-]*) provider protocol error:\\s*",
        options: [.caseInsensitive]
    )
    private static let turnStart = try? NSRegularExpression(
        pattern: "^Failed to start run .+ on ([a-z][a-z0-9_-]*) provider thread .+\\.?$",
        options: [.caseInsensitive]
    )
    private static let unsupportedAttachment = try? NSRegularExpression(
        pattern: "^This Hermes gateway does not support (image|PDF|video|file) attachments$",
        options: [.caseInsensitive]
    )

    public static func present(_ message: String) -> String {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(trimmed.startIndex ..< trimmed.endIndex, in: trimmed)

        if let match = protocolPrefix?.firstMatch(in: trimmed, range: range),
            let slug = substring(trimmed, match.range(at: 1)),
            let whole = Range(match.range, in: trimmed) {
            let detail = withoutTrailingPeriod(String(trimmed[whole.upperBound...]))
            let lowered = detail.lowercased()
            if lowered == "attachments are disabled for this hermes instance" {
                return "Hermes attachments are turned off. Enable Attachments in Settings → Providers, then try again."
            }
            if lowered == "hermes attachment storage is unavailable" {
                return "T3 couldn't access the Hermes attachment storage. Remove and reattach the file, then try again."
            }
            let detailRange = NSRange(detail.startIndex ..< detail.endIndex, in: detail)
            if let attachment = unsupportedAttachment?.firstMatch(in: detail, range: detailRange),
                let kind = substring(detail, attachment.range(at: 1))?.lowercased() {
                return "This Hermes gateway does not support \(kind) attachments. Remove the \(kind) attachment or update the gateway, then try again."
            }
            return "\(providerLabel(slug)) couldn't complete the request: \(detail). Check the provider connection in Settings → Providers, then try again."
        }

        if let match = turnStart?.firstMatch(in: trimmed, range: range),
            let slug = substring(trimmed, match.range(at: 1)) {
            return "\(providerLabel(slug)) couldn't start this message. Check the provider connection in Settings → Providers, then try again."
        }

        return trimmed
    }

    private static func substring(_ value: String, _ range: NSRange) -> String? {
        guard let swiftRange = Range(range, in: value) else { return nil }
        return String(value[swiftRange])
    }

    private static func providerLabel(_ slug: String) -> String {
        if slug.lowercased() == "hermes" { return "Hermes" }
        guard let first = slug.first else { return slug }
        return String(first).uppercased() + slug.dropFirst()
    }

    private static func withoutTrailingPeriod(_ value: String) -> String {
        var trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix(".") { trimmed = String(trimmed.dropLast()) }
        return trimmed
    }
}

// MARK: - Workspace paths

/// Ported from apps/mobile/src/features/files/filePath.ts, narrowed to what the
/// timeline needs: a workspace-relative path, and its split into muted
/// directories plus a full-weight file name.
public enum ThreadWorkspaceFilePath {
    public static func relative(workspaceRoot: String?, target: String) -> String? {
        guard isAbsolute(target) else {
            // `~` paths are outside the workspace by construction.
            if target.hasPrefix("~/") || target.hasPrefix("~\\") { return nil }
            return normalize(target)
        }
        guard let workspaceRoot, !workspaceRoot.isEmpty else { return nil }
        let normalizedTarget = target.replacingOccurrences(of: "\\", with: "/")
        var normalizedRoot = workspaceRoot.replacingOccurrences(of: "\\", with: "/")
        while normalizedRoot.hasSuffix("/") { normalizedRoot = String(normalizedRoot.dropLast()) }
        let caseInsensitive = isWindowsAbsolute(target) || isWindowsAbsolute(workspaceRoot)
        let comparableTarget = caseInsensitive ? normalizedTarget.lowercased() : normalizedTarget
        let comparableRoot = caseInsensitive ? normalizedRoot.lowercased() : normalizedRoot
        guard comparableTarget.hasPrefix(comparableRoot + "/") else { return nil }
        return normalize(String(normalizedTarget.dropFirst(normalizedRoot.count + 1)))
    }

    /// Trailing directories stay muted while the file name carries full
    /// foreground weight, mirroring the web timeline.
    public static func displayComponents(
        _ path: String,
        workspaceRoot: String?
    ) -> (prefix: String, name: String) {
        let relativePath = relative(workspaceRoot: workspaceRoot, target: path) ?? path
        let segments = relativePath
            .replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/")
            .map(String.init)
        let name = segments.last ?? relativePath
        let directories = segments.dropLast()
        let shown = directories.suffix(2)
        let prefix = shown.isEmpty
            ? ""
            : "\(directories.count > shown.count ? "…/" : "")\(shown.joined(separator: "/"))/"
        return (prefix, name)
    }

    private static func isAbsolute(_ value: String) -> Bool {
        value.hasPrefix("/") || isWindowsAbsolute(value)
    }

    private static func isWindowsAbsolute(_ value: String) -> Bool {
        if value.hasPrefix("\\\\") { return true }
        let characters = Array(value)
        guard characters.count >= 3, characters[1] == ":" else { return false }
        guard characters[0].isLetter, characters[0].isASCII else { return false }
        return characters[2] == "\\" || characters[2] == "/"
    }

    private static func normalize(_ value: String) -> String? {
        var segments: [String] = []
        for segment in value.replacingOccurrences(of: "\\", with: "/").split(
            separator: "/", omittingEmptySubsequences: false
        ) {
            if segment.isEmpty || segment == "." { continue }
            if segment == ".." {
                if segments.isEmpty { return nil }
                segments.removeLast()
                continue
            }
            segments.append(String(segment))
        }
        return segments.isEmpty ? nil : segments.joined(separator: "/")
    }
}

// MARK: - Changed files preview

/// Ported from packages/shared/src/changedFilesPreview.ts.
public enum ChangedFilesPreview {
    public static let fileLimit = 3
    public static let scopeLimit = 4

    public struct ScopeSummary: Equatable, Sendable {
        public let label: String
        public let fileCount: Int
    }

    public static func fileName(_ path: String) -> String {
        let segments = path.replacingOccurrences(of: "\\", with: "/").split(separator: "/")
        return segments.last.map(String.init) ?? path
    }

    static func scope(_ path: String) -> String {
        let segments = path.replacingOccurrences(of: "\\", with: "/").split(separator: "/")
        return segments.count > 1 ? String(segments[0]) : "root"
    }

    /// Which top-level scopes to headline, busiest first and stable on ties.
    public static func summarizeScopes(
        _ files: [OrchestrationV2CheckpointFileSummary],
        limit: Int = scopeLimit
    ) -> [ScopeSummary] {
        var counts: [String: (fileCount: Int, firstIndex: Int)] = [:]
        for (index, file) in files.enumerated() {
            let label = scope(file.path)
            let current = counts[label]
            counts[label] = (
                fileCount: (current?.fileCount ?? 0) + 1,
                firstIndex: current?.firstIndex ?? index
            )
        }
        return counts
            .map { (label: $0.key, fileCount: $0.value.fileCount, firstIndex: $0.value.firstIndex) }
            .sorted { left, right in
                if left.fileCount != right.fileCount { return left.fileCount > right.fileCount }
                if left.firstIndex != right.firstIndex { return left.firstIndex < right.firstIndex }
                return left.label < right.label
            }
            .prefix(limit)
            .map { ScopeSummary(label: $0.label, fileCount: $0.fileCount) }
    }

    /// Chips for the collapsed card: one file per scope first, so the preview
    /// shows the breadth of the change rather than three files from one folder.
    public static func preview(
        _ files: [OrchestrationV2CheckpointFileSummary],
        limit: Int = fileLimit
    ) -> [OrchestrationV2CheckpointFileSummary] {
        var selected: [OrchestrationV2CheckpointFileSummary] = []
        var selectedPaths: Set<String> = []
        var selectedScopes: Set<String> = []

        for file in files {
            let fileScope = scope(file.path)
            if selectedScopes.contains(fileScope) { continue }
            selected.append(file)
            selectedPaths.insert(file.path)
            selectedScopes.insert(fileScope)
            if selected.count == limit { return selected }
        }

        for file in files {
            if selectedPaths.contains(file.path) { continue }
            selected.append(file)
            if selected.count == limit { break }
        }

        return selected
    }
}

// MARK: - Row expansion

/// Which work-log rows are open.
///
/// Three states per row rather than two — open, closed, and "not asked" — which
/// is what lets `FeatureSettings.alwaysExpandActivity` mean *default* instead of
/// *lock*. The preference only decides rows the reader has not touched; a row
/// they closed stays closed while it is on, and a row they opened stays open
/// after it is turned off.
public struct ThreadWorkLogExpansion: Equatable, Sendable {
    private var openedIDs: Set<String> = []
    private var closedIDs: Set<String> = []

    public init() {}

    public func isExpanded(_ id: String, expandedByDefault: Bool) -> Bool {
        if closedIDs.contains(id) { return false }
        return expandedByDefault || openedIDs.contains(id)
    }

    /// Records what the reader asked for, against what they can currently see:
    /// toggling a row the preference opened has to register as a close, not as
    /// the absence of an open.
    public mutating func toggle(_ id: String, expandedByDefault: Bool) {
        if isExpanded(id, expandedByDefault: expandedByDefault) {
            openedIDs.remove(id)
            closedIDs.insert(id)
        } else {
            closedIDs.remove(id)
            openedIDs.insert(id)
        }
    }
}

// MARK: - Views

/// Additions and deletions, the first thing a reader looks for on a file row.
struct WorkRowDiffStat: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        if additions > 0 || deletions > 0 {
            HStack(spacing: 4) {
                if additions > 0 {
                    Text(verbatim: "+\(additions)").foregroundStyle(T3Colors.success)
                }
                if deletions > 0 {
                    Text(verbatim: "−\(deletions)").foregroundStyle(T3Colors.danger)
                }
            }
            .font(ChatTimelineStyle.smallMono)
            .monospacedDigit()
            .padding(.leading, 4)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(additions) additions, \(deletions) deletions")
        }
    }
}

/// The work log under a turn: what the agent actually did, one line per step.
struct ThreadWorkLog: View {
    let rows: [ThreadWorkLogRow]
    let currentThreadID: String
    let currentWireThreadID: String
    var workspaceRoot: String?
    /// Relational V2 support for one row, when the caller has the projection.
    var itemSupport: (OrchestrationV2ProjectedTurnItem) -> ThreadActivityItemSupport = { _ in
        .empty
    }
    var onOpenThread: (String) -> Void = { _ in }
    var onOpenFile: (ThreadActivityFileOpenRequest) -> Void = { _ in }
    var onOpenURL: (URL) -> Void = { _ in }
    /// Checkpoint id and, when a chip was tapped, the file to select.
    var onOpenDiff: (String, String?) -> Void = { _, _ in }
    var onRollback: (ThreadActivityRollbackTarget) -> Void = { _ in }
    /// `FeatureSettings.alwaysExpandActivity`: the log opens unfolded and every
    /// row opens with it, the way a provider CLI leaves its scrollback alone.
    var alwaysExpandActivity: Bool = false

    /// `nil` until the reader touches the fold, so the preference decides it.
    @State private var overflowExpanded: Bool?
    @State private var expansion = ThreadWorkLogExpansion()
    @State private var copiedRowID: String?

    private var isExpanded: Bool { overflowExpanded ?? alwaysExpandActivity }

    private var visibleCandidates: [ThreadWorkLogRow] { ThreadWorkLogRow.visible(rows) }

    private var onlyToolRows: Bool {
        !visibleCandidates.isEmpty && visibleCandidates.allSatisfy(\.toolLike)
    }

    private var displayedRows: [ThreadWorkLogRow] {
        isExpanded ? visibleCandidates : ThreadWorkLogPresentation.collapsed(visibleCandidates)
    }

    private var hiddenRows: [ThreadWorkLogRow] {
        let shown = Set(displayedRows.map(\.id))
        return visibleCandidates.filter { !shown.contains($0.id) }
    }

    var body: some View {
        if visibleCandidates.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 0) {
                if !onlyToolRows {
                    Text(verbatim: "work log")
                        .font(ChatTimelineStyle.smallStrong)
                        .foregroundStyle(T3Colors.textTertiary)
                        .padding(.bottom, 2)
                }

                VStack(alignment: .leading, spacing: 1) {
                    ForEach(displayedRows) { row in
                        rowView(row)
                    }
                }

                if visibleCandidates.count > ThreadWorkLogPresentation.maxVisibleEntries,
                    isExpanded || !hiddenRows.isEmpty {
                    overflowToggle
                }
            }
            .padding(.bottom, 12)
        }
    }

    @ViewBuilder
    private func rowView(_ row: ThreadWorkLogRow) -> some View {
        if case let .checkpoint(checkpointID, _, files) = row.item.payload, !files.isEmpty {
            ChangedFilesSummaryCard(
                checkpointID: checkpointID,
                files: files,
                workspaceRoot: workspaceRoot,
                isExpanded: isRowExpanded(row.id),
                onToggle: { toggleRow(row.id) },
                onOpenDiff: { onOpenDiff(checkpointID, $0) }
            )
        } else {
            VStack(alignment: .leading, spacing: 0) {
                WorkLogRowButton(
                    row: row,
                    workspaceRoot: workspaceRoot,
                    isExpanded: isRowExpanded(row.id),
                    isCopied: copiedRowID == row.id,
                    onToggle: { toggleRow(row.id) },
                    onCopy: { copy(row) }
                )

                if isRowExpanded(row.id) {
                    ThreadActivityInspectorView(
                        model: ThreadActivityInspector.build(
                            row: row.projectedItem,
                            support: itemSupport(row.projectedItem),
                            currentThreadID: currentThreadID,
                            currentWireThreadID: currentWireThreadID
                        ),
                        currentThreadID: currentThreadID,
                        currentWireThreadID: currentWireThreadID,
                        activitySourceThreadID: row.projectedItem.sourceThreadId,
                        workspaceRoot: workspaceRoot,
                        onOpenFile: onOpenFile,
                        onOpenURL: onOpenURL,
                        onRollback: onRollback
                    )
                    .padding(.leading, 12)
                    .padding(.top, 2)
                    .padding(.bottom, 6)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(ChatTimelineStyle.hairline)
                            .frame(width: 1)
                    }
                    .padding(.leading, 28)
                }

                if row.prominent {
                    ThreadActivityThreadLink(row: row, onOpenThread: onOpenThread)
                }
            }
            .background {
                if row.prominent { prominentRowSurface }
            }
            .padding(.bottom, row.prominent ? 8 : 0)
        }
    }

    private var prominentRowSurface: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(T3Colors.surface)
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(T3Colors.border, lineWidth: 1)
            )
    }

    private var overflowToggle: some View {
        let hiddenCount = hiddenRows.count
        let noun = ThreadWorkLogRow.overflowNoun(onlyToolRows: onlyToolRows, count: hiddenCount)
        let stats = ThreadWorkLogRow.totalDiffStat(hiddenRows)
        return Button {
            overflowExpanded = !isExpanded
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(T3Colors.textTertiary)
                    .frame(width: 20)
                Text(verbatim: isExpanded
                    ? "Show fewer \(noun)"
                    : "+\(hiddenCount) previous \(noun)")
                    .font(ChatTimelineStyle.bodyStrong)
                    .foregroundStyle(T3Colors.textSecondary)
                if !isExpanded {
                    Spacer(minLength: 0)
                    WorkRowDiffStat(additions: stats.additions, deletions: stats.deletions)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            isExpanded ? "Show fewer \(noun)" : "Show \(hiddenCount) previous \(noun)"
        )
    }

    private func isRowExpanded(_ id: String) -> Bool {
        expansion.isExpanded(id, expandedByDefault: alwaysExpandActivity)
    }

    private func toggleRow(_ id: String) {
        expansion.toggle(id, expandedByDefault: alwaysExpandActivity)
    }

    private func copy(_ row: ThreadWorkLogRow) {
        let model = ThreadActivityInspector.build(
            row: row.projectedItem,
            support: itemSupport(row.projectedItem),
            currentThreadID: currentThreadID,
            currentWireThreadID: currentWireThreadID
        )
        UIPasteboard.general.string = row.copyText(structuredDetails: model.structuredDetails)
        copiedRowID = row.id
        // The confirmation is a flash, not a state: leaving it up would make
        // the row read as permanently marked.
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.6))
            if copiedRowID == row.id { copiedRowID = nil }
        }
    }
}

private struct WorkLogRowButton: View {
    let row: ThreadWorkLogRow
    let workspaceRoot: String?
    let isExpanded: Bool
    let isCopied: Bool
    let onToggle: () -> Void
    let onCopy: () -> Void

    private var detail: String? { ThreadWorkLogPresentation.compactDetail(row.detail) }

    private var isDestructive: Bool { row.icon == .alert || row.icon == .warning }

    /// The icon already communicates the tool kind on these rows, so the detail
    /// (command text, search pattern) is the whole row.
    private var hidesSummaryLabel: Bool {
        detail != nil
            && (row.item.type == "command_execution" || row.item.type == "file_search")
    }

    private var filePath: (prefix: String, name: String)? {
        if case let .fileChange(fileName, _, _, _, _, _) = row.item.payload {
            return ThreadWorkspaceFilePath.displayComponents(fileName, workspaceRoot: workspaceRoot)
        }
        if case let .dynamicTool(_, input, _) = row.item.payload,
            let preview = DynamicToolInputPreview.resolve(input), preview.kind == .path {
            return ThreadWorkspaceFilePath.displayComponents(
                preview.value, workspaceRoot: workspaceRoot
            )
        }
        return nil
    }

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 6) {
                Image(systemName: row.icon.symbolName)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(isDestructive ? T3Colors.danger : T3Colors.textTertiary)
                    .frame(width: 20, height: 20)

                rowText
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .shimmering(row.inProgress)

                HStack(spacing: 1) {
                    if let stat = row.diffStat {
                        WorkRowDiffStat(additions: stat.additions, deletions: stat.deletions)
                    }
                    if isCopied {
                        Text(verbatim: "Copied")
                            .font(ChatTimelineStyle.microStrong)
                            .foregroundStyle(T3Colors.success)
                            .padding(.trailing, 4)
                    }
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(width: 16, height: 16)
                    // Success is the default outcome — only surface deviations.
                    if row.status == .failure || row.status == .neutral {
                        Image(systemName: row.status == .failure ? "xmark" : "minus")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(
                                row.status == .failure ? T3Colors.danger : T3Colors.textTertiary
                            )
                            .frame(width: 16, height: 16)
                    }
                }
            }
            .frame(minHeight: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                onCopy()
            } label: {
                Label("Copy details", systemImage: "doc.on.doc")
            }
        }
        .accessibilityLabel(detail.map { "\(row.summary) \($0)" } ?? row.summary)
        .accessibilityHint("Double tap to show full details.")
        .accessibilityAction(named: "Copy details", onCopy)
    }

    @ViewBuilder
    private var rowText: some View {
        if let filePath {
            (Text(verbatim: filePath.prefix).foregroundStyle(T3Colors.textTertiary)
                + Text(verbatim: filePath.name).foregroundStyle(T3Colors.textPrimary))
                .font(ChatTimelineStyle.bodyMono)
        } else if hidesSummaryLabel, let detail {
            Text(verbatim: detail)
                .font(ChatTimelineStyle.bodyMono)
                .foregroundStyle(T3Colors.textSecondary)
        } else {
            (Text(verbatim: row.summary)
                .font(ChatTimelineStyle.bodyStrong)
                .foregroundStyle(isDestructive ? T3Colors.danger : T3Colors.textPrimary)
                + Text(verbatim: detail.map { " \($0)" } ?? "")
                .font(ChatTimelineStyle.body)
                .foregroundStyle(T3Colors.textTertiary))
        }
    }
}

/// Checkpoint rows render as a "changed files" summary card: a header with the
/// file count, total diffstat, and an Open diff shortcut into the review
/// screen. Collapsed, it previews the touched scopes and a few file chips;
/// expanded, one row per file.
private struct ChangedFilesSummaryCard: View {
    let checkpointID: String
    let files: [OrchestrationV2CheckpointFileSummary]
    let workspaceRoot: String?
    let isExpanded: Bool
    let onToggle: () -> Void
    let onOpenDiff: (String?) -> Void

    private var totals: ThreadWorkLogDiffStat {
        ThreadWorkLogDiffStat(
            additions: files.reduce(0) { $0 + $1.additions },
            deletions: files.reduce(0) { $0 + $1.deletions }
        )
    }

    private var fileCountLabel: String {
        "\(files.count) changed \(files.count == 1 ? "file" : "files")"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if isExpanded {
                Divider().overlay(ChatTimelineStyle.hairline)
                expandedFileList
            } else {
                Divider().overlay(ChatTimelineStyle.hairline)
                collapsedPreview
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(T3Colors.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(T3Colors.border, lineWidth: 1)
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(.bottom, 8)
    }

    private var header: some View {
        HStack(spacing: 0) {
            Button(action: onToggle) {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(width: 16, height: 16)
                    Text(verbatim: fileCountLabel)
                        .font(ChatTimelineStyle.bodyStrong)
                        .foregroundStyle(T3Colors.textPrimary)
                    WorkRowDiffStat(additions: totals.additions, deletions: totals.deletions)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .frame(minHeight: 36)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(fileCountLabel)
            .accessibilityHint(isExpanded ? "Double tap to hide files." : "Double tap to show files.")

            Button { onOpenDiff(nil) } label: {
                HStack(spacing: 4) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(T3Colors.textTertiary)
                    Text(verbatim: "Open diff")
                        .font(ChatTimelineStyle.smallStrong)
                        .foregroundStyle(T3Colors.textPrimary)
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(T3Colors.border, lineWidth: 1)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .accessibilityLabel("Open diff")
        }
    }

    private var collapsedPreview: some View {
        VStack(alignment: .leading, spacing: 6) {
            ChatFlowLayout(horizontalSpacing: 6, verticalSpacing: 2) {
                ForEach(ChangedFilesPreview.summarizeScopes(files), id: \.label) { scope in
                    HStack(spacing: 4) {
                        Text(verbatim: scope.label)
                            .font(ChatTimelineStyle.smallMono)
                            .foregroundStyle(T3Colors.textSecondary)
                        Text(verbatim: "\(scope.fileCount) file\(scope.fileCount == 1 ? "" : "s")")
                            .font(ChatTimelineStyle.small)
                            .foregroundStyle(T3Colors.textTertiary)
                    }
                }
            }

            ChatFlowLayout(horizontalSpacing: 6, verticalSpacing: 6) {
                ForEach(ChangedFilesPreview.preview(files), id: \.path) { file in
                    Button { onOpenDiff(file.path) } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "doc")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(T3Colors.textTertiary)
                            Text(verbatim: ChangedFilesPreview.fileName(file.path))
                                .font(ChatTimelineStyle.smallMono)
                                .foregroundStyle(T3Colors.textSecondary)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 4)
                        .overlay(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .strokeBorder(T3Colors.border, lineWidth: 1)
                        )
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open diff for \(ChangedFilesPreview.fileName(file.path))")
                }

                Button(action: onToggle) {
                    Text(verbatim: "Show all \(files.count) files")
                        .font(ChatTimelineStyle.smallStrong)
                        .foregroundStyle(T3Colors.textSecondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private var expandedFileList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(files, id: \.path) { file in
                let display = ThreadWorkspaceFilePath.displayComponents(
                    file.path, workspaceRoot: workspaceRoot
                )
                HStack(spacing: 6) {
                    (Text(verbatim: display.prefix).foregroundStyle(T3Colors.textTertiary)
                        + Text(verbatim: display.name).foregroundStyle(T3Colors.textPrimary))
                        .font(ChatTimelineStyle.bodyMono)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if file.kind != "modified" {
                        Text(verbatim: file.kind.uppercased())
                            .font(ChatTimelineStyle.micro)
                            .foregroundStyle(T3Colors.textTertiary)
                    }
                    WorkRowDiffStat(additions: file.additions, deletions: file.deletions)
                }
                .frame(minHeight: 32)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }
}

private struct ThreadActivityThreadLink: View {
    let row: ThreadWorkLogRow
    let onOpenThread: (String) -> Void

    private var target: (threadID: String, label: String)? {
        switch row.item.payload {
        case let .threadCreated(targetThreadID, _, _, _):
            return (targetThreadID, "Open created thread")
        case let .fork(source, targetThreadID, _):
            // A fork row on the thread it created points back at its parent.
            if targetThreadID == row.projectedItem.sourceThreadId,
                case let .run(parentThreadID, _) = source {
                return (parentThreadID, "Open parent thread")
            }
            return (targetThreadID, "Open forked thread")
        default:
            return nil
        }
    }

    var body: some View {
        if let target {
            Button { onOpenThread(target.threadID) } label: {
                HStack(spacing: 6) {
                    Text(verbatim: target.label)
                        .font(ChatTimelineStyle.smallStrong)
                        .foregroundStyle(T3Colors.textPrimary)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(T3Colors.textTertiary)
                }
                .frame(maxWidth: .infinity, minHeight: 36)
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(T3Colors.border, lineWidth: 1)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        }
    }
}

/// The feed-level toggle for a work group whose rows were folded away, so a
/// settled turn shows one line instead of its whole tool history.
struct ThreadWorkGroupToggle: View {
    let hiddenCount: Int
    let onlyToolActivities: Bool
    var hiddenAdditions: Int = 0
    var hiddenDeletions: Int = 0
    @Binding var isExpanded: Bool

    private var noun: String {
        ThreadWorkLogRow.overflowNoun(onlyToolRows: onlyToolActivities, count: hiddenCount)
    }

    var body: some View {
        Button { isExpanded.toggle() } label: {
            HStack(spacing: 6) {
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(T3Colors.textTertiary)
                    .frame(width: 20)
                Text(verbatim: isExpanded
                    ? "Show fewer \(noun)"
                    : "+\(hiddenCount) previous \(noun)")
                    .font(ChatTimelineStyle.bodyStrong)
                    .foregroundStyle(T3Colors.textSecondary)
                if !isExpanded {
                    Spacer(minLength: 0)
                    WorkRowDiffStat(additions: hiddenAdditions, deletions: hiddenDeletions)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.bottom, 4)
        .accessibilityLabel(
            isExpanded ? "Show fewer \(noun)" : "Show \(hiddenCount) previous \(noun)"
        )
    }
}

/// A wrapping row of chips. `Layout` rather than a fixed grid: the chips are
/// file names of wildly different widths, and a grid would leave ragged gaps.
struct ChatFlowLayout: Layout {
    var horizontalSpacing: CGFloat = 6
    var verticalSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalHeight: CGFloat = 0
        var widestRow: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if rowWidth > 0, rowWidth + horizontalSpacing + size.width > maxWidth {
                totalHeight += rowHeight + verticalSpacing
                widestRow = max(widestRow, rowWidth)
                rowWidth = 0
                rowHeight = 0
            }
            rowWidth += (rowWidth > 0 ? horizontalSpacing : 0) + size.width
            rowHeight = max(rowHeight, size.height)
        }
        widestRow = max(widestRow, rowWidth)
        totalHeight += rowHeight
        return CGSize(
            width: proposal.width ?? widestRow,
            height: totalHeight
        )
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + verticalSpacing
                rowHeight = 0
            }
            subview.place(
                at: CGPoint(x: x, y: y),
                proposal: ProposedViewSize(size)
            )
            x += size.width + horizontalSpacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
