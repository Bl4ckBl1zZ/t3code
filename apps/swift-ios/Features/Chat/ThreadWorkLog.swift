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

/// A work row's state as its trailing glyph. Done has no case: success is the
/// default, and only a deviation earns a mark.
public enum WorkRowStatus: Equatable, Sendable {
    case running, failed, stopped

    /// Reads turn-item and subagent statuses alike, so a subagent's feed row,
    /// its lineage rows and the agents sheet agree on what it is doing.
    /// Mirrors `relatedThreadStatus` in apps/mobile/src/lib/threadLifecycle.ts.
    public init?(agentStatus: String?) {
        switch agentStatus {
        case "pending", "running", "waiting": self = .running
        case "failed", "error": self = .failed
        case "cancelled", "interrupted": self = .stopped
        default: return nil
        }
    }

    public var accessibilityLabel: String {
        switch self {
        case .running: "Running"
        case .failed: "Failed"
        case .stopped: "Stopped"
        }
    }
}

/// Which in-flight rows are still going.
///
/// An item only runs while the run that owns it does. One a crashed or
/// interrupted run never closed stays non-terminal forever, and reads as
/// stopped rather than as work in progress.
public struct ThreadWorkLogLiveRun: Equatable, Sendable {
    /// Whether any run of the thread is in flight.
    public let isActive: Bool
    /// The run in flight, when the projection names one. Nil scopes nothing.
    public let activeRunID: String?

    /// Every in-flight row counts as running, for callers with no thread state
    /// to scope by.
    public static let unscoped = ThreadWorkLogLiveRun(isActive: true, activeRunID: nil)

    public init(isActive: Bool, activeRunID: String?) {
        self.isActive = isActive
        self.activeRunID = activeRunID
    }

    init(threadState: FeatureThreadState, activeRunID: String?) {
        let stateIsActive = switch threadState {
        case .queued, .working, .waitingForApproval, .waitingForInput: true
        case .idle, .failed, .completed: false
        }
        self.init(isActive: stateIsActive || activeRunID != nil, activeRunID: activeRunID)
    }

    /// Whether an in-flight item from `runID` is still going.
    func owns(runID: String?) -> Bool {
        guard isActive else { return false }
        guard let activeRunID, let runID else { return true }
        return runID == activeRunID
    }
}

/// One line of the work log: what a turn item did, in the terms a reader scans.
public struct ThreadWorkLogRow: Identifiable, Equatable, Sendable {
    public enum Icon: String, Equatable, Sendable {
        case agent, alert, check, command, edit, eye, globe, hammer, message, warning, wrench, zap, pullRequest, computer

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
            case .pullRequest: T3Symbol.pullRequest
            case .computer: "desktopcomputer"
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
    /// The item has not reached a terminal status. See `isRunning` for which of
    /// these are actually still going.
    public let inProgress: Bool
    /// In flight on paper, but the run that owned it ended without closing it.
    public let isStranded: Bool
    public let projectedItem: OrchestrationV2ProjectedTurnItem

    /// What an approval or question row is waiting for, while it waits.
    public enum Waiting: Equatable, Sendable { case approval, input }

    public var item: OrchestrationV2TurnItem { projectedItem.item }
    var activityIcon: ToolActivityIcon? { icon == .pullRequest ? nil : item.toolIcon ?? item.toolSource?.icon }

    /// A `file_change` row headlines its own diffstat.
    public var diffStat: ThreadWorkLogDiffStat? {
        guard case let .fileChange(_, additions, deletions, _, _, _, _) = item.payload else {
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

    /// Still going: in flight and owned by a run that is. Nothing on a running
    /// row repaints; it carries the running tint, and the live focus row
    /// bounces its symbol once when the step changes.
    public var isRunning: Bool { inProgress && !isStranded }

    /// An approval or question the agent is blocked on. Static: it can wait
    /// for hours, and the answer happens in the composer panel.
    public var waiting: Waiting? {
        guard isRunning else { return nil }
        switch item.payload {
        case .approvalRequest: return .approval
        case .userInputRequest: return .input
        default: return nil
        }
    }

    /// The row's trailing glyph. Success is the default outcome, so only
    /// deviations earn one. A running row is not stopped, whatever its
    /// provisional status says; a stranded one is.
    var trailingStatus: WorkRowStatus? {
        if isStranded { return .stopped }
        switch status {
        case .failure: return .failed
        case .neutral: return inProgress ? nil : .stopped
        case .success, nil: return nil
        }
    }

    var liveFocusItem: ThreadLiveWorkItem {
        ThreadLiveWorkItem(id: id, runID: runID, running: isRunning, successful: status == .success,
            background: isLiveBackgroundCommand, boundary: prominent || status == .failure || item.type == "error" || item.type == "compaction")
    }

    var historicalSummaryItem: ThreadHistoricalWorkItem {
        let action: ThreadHistoricalWorkItem.Action
        var files: [String] = []
        switch item.payload {
        case .commandExecution: action = .command
        case .fileChange(let file, _, _, _, _, _, let changes):
            action = .edit
            files = changes.map { $0.map(\.path) } ?? [file]
        case .fileSearch: action = .codeSearch
        case .webSearch: action = .webSearch
        case .dynamicTool(_, let input, _): action = T3McpToolPresentation.historicalAction(for: item) ?? (DynamicToolInputPreview.resolve(input)?.kind == .path ? .read : .tool)
        default: action = .tool
        }
        return ThreadHistoricalWorkItem(action: action, files: files, successful: toolLike && status == .success,
            running: isRunning, persistent: prominent || isLiveBackgroundCommand || item.type == "compaction", source: item.toolSource)
    }

    public static func make(
        _ row: OrchestrationV2ProjectedTurnItem,
        liveRun: ThreadWorkLogLiveRun = .unscoped
    ) -> ThreadWorkLogRow {
        let item = row.item
        let toolDisplayName = T3McpToolPresentation.displayName(for: item)
        let inProgress = !item.status.isTerminal
        // A background command outlives its turn on purpose, so it is never
        // stranded by the turn ending.
        let isBackground: Bool = if case let .commandExecution(_, _, _, liveness) = item.payload {
            liveness.background == true
        } else {
            false
        }
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
            inProgress: inProgress,
            isStranded: inProgress && !isBackground && !liveRun.owns(runID: item.base.runId),
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

    /// Running V2 items carry activity even before they have a result. Only
    /// terminal neutral markers are omitted from the work log.
    public static func visible(_ rows: [ThreadWorkLogRow]) -> [ThreadWorkLogRow] {
        rows.filter { $0.inProgress || !($0.toolLike && $0.status == .neutral) }
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
            if !groups.isEmpty, openRunID == row.runID, !row.liveFocusItem.boundary, !openHasProminent {
                groups[groups.count - 1].append(row)
                continue
            }
            groups.append([row])
            openRunID = row.runID
            openHasProminent = row.liveFocusItem.boundary
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

    /// "1 step" / "7 steps": a bare count next to the live row said nothing.
    public static func stepCount(_ count: Int) -> String {
        "\(count) \(count == 1 ? "step" : "steps")"
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
            T3McpToolPresentation.icon(for: item) ?? (item.toolSurface == "browser" ? .globe : item.toolSurface == "computer" ? .computer : DynamicToolInputPreview.resolve(input)?.kind == .path ? .eye : .wrench)
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
        case let .fileChange(fileName, _, _, _, _, _, changes):
            // `fileName` names the first file only, so count when there are more.
            if let changes, changes.count > 1 { return "Changed \(changes.count) files" }
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
        case let .fileChange(fileName, _, _, _, _, _, _):
            return fileName
        case let .fileSearch(pattern, _):
            return pattern
        case let .webSearch(patterns, _):
            guard let patterns, !patterns.isEmpty else { return nil }
            return patterns.joined(separator: ", ")
        case let .approvalRequest(_, _, prompt, _):
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

    private static let labels: [String: (String, String, String, String)] = [
        "link_pull_request": ("Link", "Linking", "Linked", "a pull request"),
        "unlink_pull_request": ("Unlink", "Unlinking", "Unlinked", "a pull request"),
        "list_thread_pull_requests": ("Check", "Checking", "Checked", "linked pull requests"),
        "orchestrator_capabilities": ("Get", "Getting", "Got", "orchestration capabilities"),
        "delegate_task": ("Delegate", "Delegating", "Delegated", "a child task"),
        "task_status": ("Get", "Getting", "Got", "delegated task status"),
        "task_cancel": ("Cancel", "Canceling", "Canceled", "delegated task"),
        "schedule_task": ("Schedule", "Scheduling", "Scheduled", "a recurring task"),
        "list_scheduled_tasks": ("List", "Listing", "Listed", "scheduled tasks"),
        "update_scheduled_task": ("Update", "Updating", "Updated", "a scheduled task"),
        "delete_scheduled_task": ("Delete", "Deleting", "Deleted", "a scheduled task"),
        "create_threads": ("Create", "Creating", "Created", "T3 threads"),
        "t3_thread_launch": ("Launch", "Launching", "Launched", "a project thread"),
        "t3_thread_list": ("List", "Listing", "Listed", "T3 threads"),
        "t3_thread_read": ("Read", "Reading", "Read", "a T3 thread"),
        "t3_thread_send": ("Send", "Sending", "Sent", "to a T3 thread"),
        "t3_thread_wait": ("Wait", "Waiting", "Waited", "for a T3 thread"),
        "t3_thread_interrupt": ("Interrupt", "Interrupting", "Interrupted", "a T3 thread"),
        "t3_worktree_handoff": ("Hand off", "Handing off", "Handed off", "thread to a git worktree"),
        "t3_worktree_status": ("Get", "Getting", "Got", "thread worktree status"),
        "preview_status": ("Get", "Getting", "Got", "preview browser status"),
        "preview_open": ("Open", "Opening", "Opened", "a page in the preview browser"),
        "preview_navigate": ("Navigate", "Navigating", "Navigated", "the preview browser"),
        "preview_snapshot": ("Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"),
        "preview_click": ("Click", "Clicking", "Clicked", "in the preview browser"),
        "preview_press": ("Press", "Pressing", "Pressed", "a key in the preview browser"),
        "preview_type": ("Type", "Typing", "Typed", "in the preview browser"),
        "preview_scroll": ("Scroll", "Scrolling", "Scrolled", "the preview browser"),
        "preview_resize": ("Resize", "Resizing", "Resized", "the preview browser"),
        "preview_evaluate": ("Evaluate", "Evaluating", "Evaluated", "script in the preview browser"),
        "preview_wait_for": ("Wait", "Waiting", "Waited", "for the preview page"),
        "preview_set_appearance": ("Set", "Setting", "Set", "preview browser appearance"),
        "preview_recording_start": ("Start", "Starting", "Started", "recording the preview browser"),
        "preview_recording_stop": ("Stop", "Stopping", "Stopped", "recording the preview browser"),
    ]

    public static func displayName(for item: OrchestrationV2TurnItem) -> String? {
        guard case let .dynamicTool(toolName, input, _) = item.payload else { return nil }
        return displayName(for: toolName, status: item.status.rawValue, input: input)
            ?? displayName(for: item.base.title, status: item.status.rawValue, input: input)
    }

    public static func displayName(for toolName: String?, status: String? = nil, input: JSONValue? = nil) -> String? {
        guard let toolName, let resolved = resolveToolName(toolName), let (action, running, completed, detail) = labels[resolved] else { return nil }
        let verb: String
        switch status {
        case "running", "waiting", "pending", "inProgress": verb = running
        case "completed": verb = completed
        case "failed": verb = "Failed to \(action.lowercased())"
        case "declined": verb = "Declined to \(action.lowercased())"
        case "stopped", "cancelled", "interrupted": verb = "Stopped \(running.lowercased())"
        default: verb = action
        }
        let target: String
        if ["link_pull_request", "unlink_pull_request"].contains(resolved), let number = pullRequestNumber(input) {
            target = "PR #\(number)"
        } else { target = detail }
        return "\(verb) \(target)"
    }

    static func historicalAction(for item: OrchestrationV2TurnItem) -> ThreadHistoricalWorkItem.Action? {
        guard case let .dynamicTool(toolName, _, _) = item.payload,
            let name = [toolName, item.base.title].compactMap({ $0 }).compactMap(resolveToolName).first(where: { labels[$0] != nil }),
            labels[name] != nil else { return nil }
        switch name {
        case "link_pull_request": return .linkPR
        case "unlink_pull_request": return .unlinkPR
        case "list_thread_pull_requests": return .listPRs
        default: return name.hasPrefix("preview_") ? .browser : nil
        }
    }

    static func icon(for item: OrchestrationV2TurnItem) -> ThreadWorkLogRow.Icon? {
        switch historicalAction(for: item) {
        case .linkPR, .unlinkPR, .listPRs: .pullRequest
        case .browser: .globe
        default: nil
        }
    }

    private static func pullRequestNumber(_ input: JSONValue?) -> Int64? {
        if let text = input?["url"]?.stringValue, let number = changeRequestNumber(text) { return number }
        switch input?["number"] {
        case .integer(let number) where number > 0 && number <= 9_007_199_254_740_991: return number
        case .unsignedInteger(let number) where number > 0 && number <= 9_007_199_254_740_991: return Int64(number)
        case .number(let number) where number.isFinite && number > 0 && number <= 9_007_199_254_740_991 && number.rounded() == number: return Int64(number)
        default: return nil
        }
    }

    /// Match the shared change-request parser's host and route rules, including self-hosted GitLab.
    private static func changeRequestNumber(_ text: String) -> Int64? {
        guard let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let host = url.host?.lowercased() else { return nil }
        func isHost(_ apex: String, _ label: String? = nil) -> Bool {
            host == apex || host.hasSuffix("." + apex) || (label.map { host.split(separator: ".").contains(Substring($0)) } ?? false)
        }
        let pattern: String
        if isHost("github.com", "github") { pattern = #"^/[^/]+/[^/]+/pull/(\d+)(?:/|$)"# }
        else if url.path.contains("/-/merge_requests/") { pattern = #"^/[^/]+(?:/[^/]+)+/-/merge_requests/(\d+)(?:/|$)"# }
        else if isHost("bitbucket.org", "bitbucket") { pattern = #"^/[^/]+/[^/]+/pull-requests/(\d+)(?:/|$)"# }
        else if isHost("dev.azure.com") || host.hasSuffix(".visualstudio.com") { pattern = #"^/(?:[^/]+/)*_git/[^/]+/pullrequest/(\d+)(?:/|$)"# }
        else { return nil }
        guard let regex = try? NSRegularExpression(pattern: pattern),
            let match = regex.firstMatch(in: url.path, range: NSRange(url.path.startIndex..., in: url.path)),
            let range = Range(match.range(at: 1), in: url.path),
            let number = Int64(url.path[range]), number > 0, number <= 9_007_199_254_740_991 else { return nil }
        return number
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
            for separator in [".", ":", "/", " · ", "·"] {
                let prefix = alias + separator
                if label.lowercased().hasPrefix(prefix) {
                    let tool = String(label.dropFirst(prefix.count))
                    return tool.isEmpty ? nil : tool
                }
            }
        }
        return labels[label] != nil ? label : nil
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
// MARK: - Views

/// Additions and deletions, the first thing a reader looks for on a file row.
struct WorkRowDiffStat: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        if additions > 0 || deletions > 0 {
            HStack(spacing: 4) {
                if additions > 0 {
                    Text(verbatim: "+\(additions)").foregroundStyle(T3Colors.diffAddition)
                }
                if deletions > 0 {
                    Text(verbatim: "−\(deletions)").foregroundStyle(T3Colors.diffDeletion)
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

/// The trailing mark for a work row that did not simply finish. Static on
/// purpose: a row can sit in any of these states for minutes.
struct WorkRowStatusGlyph: View {
    let status: WorkRowStatus?
    /// Red belongs to rows whose failure is the headline; a failed tool call
    /// inside a turn that carried on stays quiet.
    var failureTint: Color = T3Colors.danger

    var body: some View {
        switch status {
        case .stopped:
            // A word, not a dash: a bare minus read as a divider.
            Text(verbatim: "Stopped")
                .font(ChatTimelineStyle.small)
                .foregroundStyle(T3Colors.textTertiary)
                .accessibilityHidden(true)
        case .failed:
            Image(systemName: "exclamationmark.circle")
                .font(ChatTimelineStyle.small.weight(.medium))
                .foregroundStyle(failureTint)
                .accessibilityHidden(true)
        case .running:
            Image(systemName: "ellipsis")
                .font(ChatTimelineStyle.small.weight(.medium))
                .foregroundStyle(T3Colors.textTertiary)
                .accessibilityHidden(true)
        case nil:
            EmptyView()
        }
    }
}

/// The one disclosure convention in the transcript: a trailing chevron that
/// turns down when open, the way `DisclosureGroup` draws it.
struct TimelineDisclosureChevron: View {
    let isExpanded: Bool

    var body: some View {
        Image(systemName: "chevron.right")
            .font(ChatTimelineStyle.small.weight(.semibold))
            .foregroundStyle(T3Colors.textTertiary)
            .rotationEffect(.degrees(isExpanded ? 90 : 0))
            .animation(.snappy, value: isExpanded)
            .accessibilityHidden(true)
    }
}

/// The work log under a turn: what the agent actually did, one line per step.
struct ThreadWorkLog: View {
    let rows: [ThreadWorkLogRow]
    var liveEntryID: String? = nil
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
    /// Checkpoint id and, when a file row was tapped, the file to select.
    var onOpenDiff: (String, String?) -> Void = { _, _ in }
    var onRollback: (ThreadActivityRollbackTarget) -> Void = { _ in }
    /// Resends the last user message after a failed turn.
    var onRetryTurn: (() -> Void)? = nil
    /// `FeatureSettings.alwaysExpandActivity`: the log opens unfolded and every
    /// row opens with it, the way a provider CLI leaves its scrollback alone.
    var alwaysExpandActivity: Bool = false

    /// `nil` until the reader touches the fold, so the preference decides it.
    @SwiftUI.Environment(\.threadWorkLogHistory) private var sharedHistory
    @State private var localHistory = ThreadWorkLogHistoryStore()
    private var history: ThreadWorkLogHistory {
        (sharedHistory ?? localHistory).entry("\(currentThreadID):\(rows.first?.id ?? "empty")")
    }

    private var isExpanded: Bool { history.groupExpanded ?? alwaysExpandActivity }

    private var visibleCandidates: [ThreadWorkLogRow] { ThreadWorkLogRow.visible(rows) }

    private var onlyToolRows: Bool {
        !visibleCandidates.isEmpty && visibleCandidates.allSatisfy(\.toolLike)
    }

    private var historicalSummary: String? { ThreadHistoricalWorkSummary.label(visibleCandidates.map(\.historicalSummaryItem)) }

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
                if let focus = visibleCandidates.first(where: { $0.id == liveEntryID }) {
                    focusRow(focus)
                    if isExpanded {
                        expandedHistory
                    } else {
                        ForEach(visibleCandidates.filter(\.isLiveBackgroundCommand)) { rowView($0) }
                    }
                } else if let summary = historicalSummary {
                    Button { toggleGroup() } label: {
                        HStack(spacing: 8) {
                            ThreadToolActivityIcon(icon: visibleCandidates.allSatisfy { $0.icon != .pullRequest && $0.item.toolSource?.key != nil && $0.item.toolSource?.key == visibleCandidates.first?.item.toolSource?.key } ? visibleCandidates.first?.item.toolSource?.icon : nil, fallback: Set(visibleCandidates.map(\.icon)).count == 1 ? (visibleCandidates.first?.icon.symbolName ?? "hammer") : "hammer")
                                .foregroundStyle(T3Colors.textTertiary)
                                .frame(width: 20)
                            Text(summary).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                            TimelineDisclosureChevron(isExpanded: isExpanded)
                        }
                        .font(ChatTimelineStyle.bodyStrong)
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
                    if isExpanded {
                        expandedHistory
                    }
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(displayedRows) { row in rowView(row) }
                    }
                }

                if liveEntryID == nil, historicalSummary == nil, visibleCandidates.count > ThreadWorkLogPresentation.maxVisibleEntries,
                    isExpanded || !hiddenRows.isEmpty {
                    overflowToggle
                }
            }
            .padding(.bottom, 12)
        }
    }

    /// The live row: what the agent is doing now, in the running tint. Its
    /// symbol bounces once when the step changes; nothing on it loops.
    private func focusRow(_ focus: ThreadWorkLogRow) -> some View {
        let count = ThreadWorkLogRow.stepCount(visibleCandidates.count)
        return Button { toggleGroup() } label: {
            HStack(spacing: 8) {
                ThreadToolActivityIcon(icon: focus.activityIcon, fallback: focus.icon.symbolName)
                    .foregroundStyle(focus.isRunning ? T3Colors.statusRunning : T3Colors.textTertiary)
                    .symbolEffect(.bounce, value: liveEntryID)
                    .frame(width: 20)
                WorkLogRowText(row: focus, workspaceRoot: workspaceRoot)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(verbatim: count)
                    .font(ChatTimelineStyle.small)
                    .monospacedDigit()
                    .foregroundStyle(T3Colors.textTertiary)
                TimelineDisclosureChevron(isExpanded: isExpanded)
            }
            .font(ChatTimelineStyle.bodyStrong)
            .foregroundStyle(T3Colors.textSecondary)
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(focus.summary), \(count)")
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
    }

    /// Every row, inline. A nested scroll view here trapped the transcript's
    /// own scrolling, and the transcript already recycles whole groups.
    private var expandedHistory: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(visibleCandidates) { row in rowView(row) }
        }
    }

    private func toggleGroup() {
        withAnimation(.snappy) { history.groupExpanded = !isExpanded }
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
        } else if row.item.type == "error" {
            ProviderErrorCallout(row: row, onRetry: onRetryTurn)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                WorkLogRowButton(
                    row: row,
                    workspaceRoot: workspaceRoot,
                    isExpanded: isRowExpanded(row.id),
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
                if row.prominent {
                    RoundedRectangle(cornerRadius: 12, style: .continuous).fill(T3Colors.surface)
                }
            }
            .padding(.bottom, row.prominent ? 8 : 0)
        }
    }

    private var overflowToggle: some View {
        let hiddenCount = hiddenRows.count
        let noun = ThreadWorkLogRow.overflowNoun(onlyToolRows: onlyToolRows, count: hiddenCount)
        let stats = ThreadWorkLogRow.totalDiffStat(hiddenRows)
        return Button {
            toggleGroup()
        } label: {
            HStack(spacing: 8) {
                Text(verbatim: isExpanded ? "Show fewer \(noun)" : "\(hiddenCount) more \(noun)")
                    .font(ChatTimelineStyle.bodyStrong)
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer(minLength: 0)
                if !isExpanded {
                    WorkRowDiffStat(additions: stats.additions, deletions: stats.deletions)
                }
                TimelineDisclosureChevron(isExpanded: isExpanded)
            }
            .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            isExpanded ? "Show fewer \(noun)" : "Show \(hiddenCount) more \(noun)"
        )
    }

    private func isRowExpanded(_ id: String) -> Bool {
        history.rowExpansion.isExpanded(id, expandedByDefault: alwaysExpandActivity)
    }

    private func toggleRow(_ id: String) {
        withAnimation(.snappy) {
            history.rowExpansion.toggle(id, expandedByDefault: alwaysExpandActivity)
        }
    }

    private func copy(_ row: ThreadWorkLogRow) {
        let model = ThreadActivityInspector.build(
            row: row.projectedItem,
            support: itemSupport(row.projectedItem),
            currentThreadID: currentThreadID,
            currentWireThreadID: currentWireThreadID
        )
        UIPasteboard.general.string = row.copyText(structuredDetails: model.structuredDetails)
        T3HUD.show("Copied", systemImage: "doc.on.doc")
    }
}

/// What a work row says: the file for an edit, the command for a command, the
/// summary and its detail otherwise, and what it is waiting for while it waits.
private struct WorkLogRowText: View {
    let row: ThreadWorkLogRow
    let workspaceRoot: String?

    private var detail: String? { ThreadWorkLogPresentation.compactDetail(row.detail) }

    private var isDestructive: Bool { row.icon == .alert || row.icon == .warning }

    /// The icon already communicates the tool kind on these rows, so the detail
    /// (command text, search pattern) is the whole row.
    private var hidesSummaryLabel: Bool {
        detail != nil
            && (row.item.type == "command_execution" || row.item.type == "file_search")
    }

    private var filePath: (prefix: String, name: String)? {
        if case let .fileChange(fileName, _, _, _, _, _, _) = row.item.payload {
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
        if let waiting = row.waiting {
            (Text(verbatim: waiting == .approval ? "Waiting for approval" : "Waiting for your answer")
                .font(ChatTimelineStyle.bodyStrong)
                .foregroundStyle(T3Colors.textPrimary)
                + Text(verbatim: detail.map { " \($0)" } ?? "")
                .font(ChatTimelineStyle.body)
                .foregroundStyle(T3Colors.textTertiary))
        } else if let filePath {
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

private struct WorkLogRowButton: View {
    let row: ThreadWorkLogRow
    let workspaceRoot: String?
    let isExpanded: Bool
    let onToggle: () -> Void
    let onCopy: () -> Void

    private var isDestructive: Bool { row.icon == .alert || row.icon == .warning }

    private var symbolName: String {
        switch row.waiting {
        case .approval: "hand.raised"
        case .input: "questionmark.bubble"
        case nil: row.icon.symbolName
        }
    }

    private var iconTint: Color {
        if isDestructive { return T3Colors.danger }
        switch row.waiting {
        case .approval: return T3Colors.warning
        case .input: return T3Colors.statusInput
        case nil: return row.isRunning && !row.isLiveBackgroundCommand ? T3Colors.statusRunning : T3Colors.textTertiary
        }
    }

    private var accessibilityText: String {
        let detail = ThreadWorkLogPresentation.compactDetail(row.detail)
        let summary = switch row.waiting {
        case .approval: "Waiting for approval"
        case .input: "Waiting for your answer"
        case nil: row.summary
        }
        return detail.map { "\(summary) \($0)" } ?? summary
    }

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 8) {
                ThreadToolActivityIcon(icon: row.waiting == nil ? row.activityIcon : nil, fallback: symbolName)
                    .font(ChatTimelineStyle.bodyStrong)
                    .foregroundStyle(iconTint)
                    .frame(width: 20)

                WorkLogRowText(row: row, workspaceRoot: workspaceRoot)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 6) {
                    if let stat = row.diffStat {
                        WorkRowDiffStat(additions: stat.additions, deletions: stat.deletions)
                    }
                    WorkRowStatusGlyph(
                        status: row.trailingStatus,
                        failureTint: isDestructive ? T3Colors.danger : T3Colors.textTertiary
                    )
                    TimelineDisclosureChevron(isExpanded: isExpanded)
                }
            }
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                onCopy()
            } label: {
                Label("Copy Details", systemImage: "doc.on.doc")
            }
        }
        .accessibilityLabel(accessibilityText)
        .accessibilityValue([row.trailingStatus?.accessibilityLabel, isExpanded ? "Expanded" : "Collapsed"].compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint("Double tap to show full details.")
        .accessibilityAction(named: "Copy details", onCopy)
    }
}

/// A turn's failure, said in full. `ProviderErrorPresentation` works to turn
/// adapter noise into the next step; a one-line row truncated exactly that.
private struct ProviderErrorCallout: View {
    let row: ThreadWorkLogRow
    let onRetry: (() -> Void)?

    private var message: String {
        row.detail?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? row.summary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(T3Colors.danger)
                    .accessibilityHidden(true)
                Text(verbatim: message)
                    .font(.footnote)
                    .foregroundStyle(T3Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let onRetry {
                Button("Try Again", systemImage: "arrow.clockwise", action: onRetry)
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .tint(T3Colors.textPrimary)
                    .padding(.leading, 24)
            }
        }
        .padding(14)
        .background(T3Colors.danger.opacity(0.10), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Error: \(message)")
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// Checkpoint rows render as a "changed files" summary: the file count and
/// total diffstat with an Open Diff shortcut into the review, then one row per
/// file that opens the diff at that file.
private struct ChangedFilesSummaryCard: View {
    let checkpointID: String
    let files: [OrchestrationV2CheckpointFileSummary]
    let workspaceRoot: String?
    let isExpanded: Bool
    let onToggle: () -> Void
    let onOpenDiff: (String?) -> Void

    /// Enough to see the shape of a change without scrolling past it.
    private static let collapsedLimit = 5

    private var totals: ThreadWorkLogDiffStat {
        ThreadWorkLogDiffStat(
            additions: files.reduce(0) { $0 + $1.additions },
            deletions: files.reduce(0) { $0 + $1.deletions }
        )
    }

    private var fileCountLabel: String {
        "\(files.count) changed \(files.count == 1 ? "file" : "files")"
    }

    private var shownFiles: [OrchestrationV2CheckpointFileSummary] {
        isExpanded ? files : ChangedFilesPreview.preview(files, limit: Self.collapsedLimit)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(ChatTimelineStyle.hairline)
            ForEach(shownFiles, id: \.path) { file in fileRow(file) }
            if files.count > Self.collapsedLimit {
                Button(action: onToggle) {
                    HStack(spacing: 8) {
                        Text(verbatim: isExpanded ? "Show Fewer Files" : "Show All \(files.count) Files")
                            .font(ChatTimelineStyle.bodyStrong)
                            .foregroundStyle(T3Colors.textSecondary)
                        Spacer(minLength: 0)
                        TimelineDisclosureChevron(isExpanded: isExpanded)
                    }
                    .frame(minHeight: T3Metrics.minimumTapTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
            }
        }
        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.bottom, 8)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(verbatim: fileCountLabel)
                .font(ChatTimelineStyle.bodyStrong)
                .foregroundStyle(T3Colors.textPrimary)
            WorkRowDiffStat(additions: totals.additions, deletions: totals.deletions)
            Spacer(minLength: 8)
            Button("Open Diff") { onOpenDiff(nil) }
                .font(ChatTimelineStyle.bodyStrong)
                .t3SecondaryButtonStyle()
                .buttonBorderShape(.capsule)
                .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: T3Metrics.minimumTapTarget + 4)
        .accessibilityElement(children: .contain)
    }

    private func fileRow(_ file: OrchestrationV2CheckpointFileSummary) -> some View {
        let display = ThreadWorkspaceFilePath.displayComponents(file.path, workspaceRoot: workspaceRoot)
        return Button { onOpenDiff(file.path) } label: {
            HStack(spacing: 8) {
                (Text(verbatim: display.prefix).foregroundStyle(T3Colors.textTertiary)
                    + Text(verbatim: display.name).foregroundStyle(T3Colors.textPrimary))
                    .font(ChatTimelineStyle.bodyMono)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let kind = Self.kindLabel(file.kind) {
                    Text(verbatim: kind)
                        .font(ChatTimelineStyle.small.weight(.medium))
                        .foregroundStyle(T3Colors.textSecondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(T3Colors.subtle, in: Capsule())
                }
                WorkRowDiffStat(additions: file.additions, deletions: file.deletions)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open diff for \(ChangedFilesPreview.fileName(file.path))")
    }

    /// Sentence case, and nothing for an ordinary modification.
    static func kindLabel(_ kind: String) -> String? {
        switch kind.lowercased() {
        case "modified", "": nil
        case "added", "created": "New"
        case "deleted", "removed": "Deleted"
        case "renamed": "Renamed"
        default: kind.prefix(1).uppercased() + kind.dropFirst()
        }
    }
}

/// Opens the thread a fork or thread-creation row points at.
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
                HStack(spacing: 8) {
                    Text(verbatim: target.label)
                        .font(ChatTimelineStyle.bodyStrong)
                        .foregroundStyle(T3Colors.accent)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(ChatTimelineStyle.small.weight(.semibold))
                        .foregroundStyle(T3Colors.textTertiary)
                }
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}

private struct ThreadToolActivityIcon: View {
    let icon: ToolActivityIcon?
    let fallback: String
    @SwiftUI.Environment(\.colorScheme) private var colorScheme
    var body: some View {
        if icon?._tag == "native-app", let app = icon?.app {
            NativeAppToolIcon(app: app, fallback: fallback)
        } else if let url = icon?.imageURL(dark: colorScheme == .dark) {
            NativeToolLogo(url: url, fallback: fallback)
        } else { Image(symbol: fallback).accessibilityHidden(true) }
    }
}
