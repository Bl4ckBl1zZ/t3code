import Foundation

// Presentation for the turn items that render as first-class timeline rows
// rather than work-log entries. Ported from apps/mobile/src/lib/threadLifecycle.ts
// so both clients divide the timeline the same way; checkpoints deliberately
// stay in the work log in both.

/// The subset of a run that handoff rows read to recover models.
public struct LifecycleTimelineRun: Equatable, Sendable {
    public let id: String
    public let ordinal: Int
    public let providerInstanceID: String
    public let model: String
    public let status: String
    /// The run records how its workspace is prepared, so a failed preparation
    /// can be retried with `prepared-run.retry`.
    public let preparesWorkspace: Bool

    public init(
        id: String,
        ordinal: Int,
        providerInstanceID: String,
        model: String,
        status: String = "",
        preparesWorkspace: Bool = false
    ) {
        self.id = id
        self.ordinal = ordinal
        self.providerInstanceID = providerInstanceID
        self.model = model
        self.status = status
        self.preparesWorkspace = preparesWorkspace
    }
}

/// Ports client-runtime's turn-item presentation for workspace preparation.
public enum ThreadWorkspacePreparationRetry {
    /// The failure item a preparation left before a retry replaced it. The
    /// retry cancels it, after which it has nothing left to say.
    public static func isRetriedFailure(_ item: OrchestrationV2TurnItem) -> Bool {
        guard case let .error(failure, _) = item.payload else { return false }
        return item.status == .cancelled && failure.code == orchestrationV2WorkspacePreparationFailureCode
    }

    /// Runs Retry Setup can prepare again: their workspace preparation failed
    /// and the run still ended there. Older servers record no preparation on
    /// the run, so they never offer it.
    public static func retryableRunIDs(
        runs: [LifecycleTimelineRun],
        items: [OrchestrationV2TurnItem]
    ) -> Set<String> {
        let failedRuns = Set(runs.filter { $0.status == "failed" && $0.preparesWorkspace }.map(\.id))
        guard !failedRuns.isEmpty else { return [] }
        var retryable = Set<String>()
        for item in items {
            guard case let .error(failure, _) = item.payload,
                  item.status == .failed,
                  failure.code == orchestrationV2WorkspacePreparationFailureCode,
                  let runID = item.base.runId, failedRuns.contains(runID) else { continue }
            retryable.insert(runID)
        }
        return retryable
    }
}

public enum LifecyclePresentation: Equatable, Sendable {
    case divider(Divider)
    case relatedThread(RelatedThread)

    public struct Divider: Equatable, Sendable {
        public enum Tone: Equatable, Sendable { case neutral, danger }
        /// Detail on its own line under the label. Handoffs need it; the
        /// endpoint list is too long to read inline.
        public enum Layout: Equatable, Sendable { case inline, stacked }

        public let label: String
        public let detail: String?
        public let tone: Tone
        public let symbol: String
        public let layout: Layout
        /// In-flight system work, e.g. a handoff summary still being generated.
        public let busy: Bool
        public let actionLabel: String?
        public let openThreadID: String?
    }

    /// A subagent or created thread, drawn as an ordinary tool row.
    public struct RelatedThread: Equatable, Sendable {
        public enum OrbState: Equatable, Sendable { case active, done, failed }

        public let symbol: String
        /// The agent's or thread's name.
        public let title: String
        /// Its task, muted after the name.
        public let preview: String?
        /// Latest progress or result: the one line under the row.
        public let detail: String?
        /// Muted note for what is not a status, such as "Created".
        public let meta: String?
        /// The trailing glyph; nil once it is simply done.
        public let status: WorkRowStatus?
        public let threadID: String?
        /// Stable per-agent seed; present means the row leads with an orb.
        public let orbSeed: String?
        public let orbState: OrbState?
    }
}

/// What a subagent runs on and where, for the line under its name. Resolved
/// once per projection from data the client already holds, never by loading
/// the child's transcript.
public struct SubagentRowMetadata: Equatable, Sendable {
    public struct WorkspaceEntry: Equatable, Sendable {
        /// "Project", "Branch", "Worktree" or "Workspace".
        public let label: String
        public let value: String

        public init(label: String, value: String) {
            self.label = label
            self.value = value
        }
    }

    public let modelLabel: String
    /// The provider account, named only when the reader needs it to tell two
    /// accounts on the same provider apart.
    public let account: String?
    /// `#RRGGBB`, present only alongside `account`.
    public let accentColor: String?
    /// Only what differs from the parent's workspace.
    public let workspace: [WorkspaceEntry]

    public init(
        modelLabel: String,
        account: String? = nil,
        accentColor: String? = nil,
        workspace: [WorkspaceEntry] = []
    ) {
        self.modelLabel = modelLabel
        self.account = account
        self.accentColor = accentColor
        self.workspace = workspace
    }
}

/// When a provider instance names itself next to a model. Ports
/// `shouldShowInstanceBadge` / `normalizeProviderAccentColor` from
/// apps/web/src/providerInstances.ts so every surface badges the same accounts.
public enum ProviderAccountBadge {
    /// A configured accent always shows; otherwise only a driver with several
    /// instances needs telling apart.
    public static func shows(
        driver: String,
        accentColor: String?,
        amongDrivers drivers: [String]
    ) -> Bool {
        if normalizedAccent(accentColor) != nil { return true }
        return drivers.lazy.filter { $0 == driver }.prefix(2).count > 1
    }

    /// `#RRGGBB` or nil; anything else is ignored rather than guessed at.
    public static func normalizedAccent(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              trimmed.count == 7, trimmed.hasPrefix("#"),
              trimmed.dropFirst().allSatisfy(\.isHexDigit) else { return nil }
        return trimmed
    }
}

public enum ThreadLifecycle {
    /// The two ends of a subagent edge as `resolveSubagentMetadata` reads them.
    public struct SubagentWorkspaceThread: Equatable, Sendable {
        public var projectID: String
        public var branch: String?
        public var worktreePath: String?

        public init(projectID: String, branch: String? = nil, worktreePath: String? = nil) {
            self.projectID = projectID
            self.branch = branch
            self.worktreePath = worktreePath
        }
    }

    public struct SubagentWorkspaceProject: Equatable, Sendable {
        public var id: String
        public var title: String
        public var workspaceRoot: String

        public init(id: String, title: String, workspaceRoot: String) {
            self.id = id
            self.title = title
            self.workspaceRoot = workspaceRoot
        }
    }

    /// Ports `resolveSubagentMetadata` from
    /// packages/client-runtime/src/state/subagentDisplay.ts: the catalog's short
    /// name for the reported model, and only the workspace facts that differ
    /// from the parent's.
    public static func resolveSubagentMetadata(
        model: String?,
        provider: (driver: String, models: [ServerProviderModelSnapshot])? = nil,
        parentThread: SubagentWorkspaceThread? = nil,
        childThread: SubagentWorkspaceThread? = nil,
        parentProject: SubagentWorkspaceProject? = nil,
        childProject: SubagentWorkspaceProject? = nil
    ) -> (modelLabel: String, workspace: [SubagentRowMetadata.WorkspaceEntry]) {
        let reported = model?.trimmingCharacters(in: .whitespacesAndNewlines)
        let model = reported?.isEmpty == false ? reported : nil
        let catalogModel = model.flatMap { model in
            provider.flatMap { selectableModel(model, in: $0.models) }
        }
        let reportedLabel =
            catalogModel.map { ($0.shortName?.isEmpty == false ? $0.shortName : nil) ?? $0.name }
            ?? model.map(formatModelSlugName)
            ?? "Not reported"
        let modelLabel: String
        if let qualifier = catalogModel?.subProvider?.trimmingCharacters(in: .whitespaces),
           !qualifier.isEmpty {
            modelLabel = stripQualifier(qualifier, from: reportedLabel)
        } else {
            modelLabel = reportedLabel
        }

        let parentWorkspace = parentThread?.worktreePath ?? parentProject?.workspaceRoot
        let childWorkspace = childThread?.worktreePath ?? childProject?.workspaceRoot
        var workspace: [SubagentRowMetadata.WorkspaceEntry] = []
        if let parentThread, let childProject, childProject.id != parentThread.projectID {
            workspace.append(.init(label: "Project", value: childProject.title))
        }
        if let parentWorkspace, let childWorkspace, parentWorkspace != childWorkspace {
            let label =
                childThread?.branch != nil ? "Branch"
                : childThread?.worktreePath != nil ? "Worktree"
                : "Workspace"
            let value = childThread?.branch ?? URL(fileURLWithPath: childWorkspace).lastPathComponent
            workspace.append(.init(label: label, value: value))
        }
        return (modelLabel, workspace)
    }

    /// `resolveSelectableModel`, against the catalog alone: slug, then name,
    /// then the catalog's own aliases.
    private static func selectableModel(
        _ value: String,
        in models: [ServerProviderModelSnapshot]
    ) -> ServerProviderModelSnapshot? {
        models.first { $0.slug == value }
            ?? models.first { $0.name.caseInsensitiveCompare(value) == .orderedSame }
            ?? models.first { $0.aliases?.contains(value) == true }
    }

    /// "Cloud+ / My model" reads "My model" once the provider is already named.
    private static func stripQualifier(_ qualifier: String, from label: String) -> String {
        guard label.lowercased().hasPrefix(qualifier.lowercased()) else { return label }
        var rest = label.dropFirst(qualifier.count)
        let separators: Set<Character> = [".", ":", "/", "-"]
        let leading = rest.prefix { $0.isWhitespace }
        rest = rest.dropFirst(leading.count)
        if let first = rest.first, separators.contains(first) {
            rest = rest.dropFirst().drop { $0.isWhitespace }
        } else if leading.isEmpty {
            // "Cloud+Model" is not a qualifier followed by a name.
            return label
        }
        let stripped = rest.trimmingCharacters(in: .whitespaces)
        return stripped.isEmpty ? label : stripped
    }

    /// Ports `formatModelSlugName` from packages/shared/src/model.ts:
    /// "claude-opus-4-6" reads "Claude Opus 4.6", "gpt-5.4-mini" reads
    /// "GPT-5.4-Mini"; anything unrecognized is kept verbatim.
    static func formatModelSlugName(_ slug: String) -> String {
        let separator = slug.lastIndex(of: "/").map { slug.index(after: $0) } ?? slug.startIndex
        let prefix = String(slug[..<separator])
        let name = String(slug[separator...])
        if name.range(of: #"^gpt-\d"#, options: [.regularExpression, .caseInsensitive]) != nil {
            let upper = name.replacingOccurrences(
                of: "^gpt", with: "GPT", options: [.regularExpression, .caseInsensitive]
            )
            var result = ""
            var capitalizeNext = false
            for character in upper {
                if capitalizeNext, character.isLetter, character.isLowercase {
                    result.append(contentsOf: character.uppercased())
                } else {
                    result.append(character)
                }
                capitalizeNext = character == "-"
            }
            return prefix + result
        }
        guard name.range(
            of: #"^(claude-(opus|sonnet|haiku|fable)|gemini|grok|composer)-\d"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil else { return slug }
        let dotted = name.replacingOccurrences(
            of: #"^(claude-[a-z]+-\d+)-(\d{1,2})(?=-|\[|$)"#,
            with: "$1.$2",
            options: [.regularExpression, .caseInsensitive]
        )
        return prefix + dotted.split(separator: "-", omittingEmptySubsequences: false)
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    /// Ports `subagentDetailPreview`: live work leads with progress, settled
    /// work with its result, collapsed to one paragraph of at most 280
    /// characters for a three-line row.
    static func subagentDetailPreview(
        status: OrchestrationV2TurnItemStatus,
        progress: String?,
        result: String?
    ) -> String? {
        let progress = oneLine(progress)
        let result = oneLine(result)
        guard let detail = status.isTerminal ? (result ?? progress) : (progress ?? result) else {
            return nil
        }
        guard detail.count > 280 else { return detail }
        var clipped = String(detail.prefix(280))
        while clipped.last?.isWhitespace == true { clipped.removeLast() }
        return clipped + "…"
    }

    /// Turn items that become dividers or related-thread rows.
    static let lifecycleTypes: Set<String> = [
        "run_interrupt_request",
        "run_interrupt_result",
        "checkpoint_rollback",
        "compaction",
        "handoff",
        "fork",
        "subagent",
        "thread_created",
    ]

    public static func isLifecycleTimelineItem(_ item: OrchestrationV2TurnItem) -> Bool {
        lifecycleTypes.contains(item.type)
    }

    /// A handoff streams in non-terminal while the orchestrator generates the
    /// summary for the target model, which can be an AI call.
    private static func isHandoffInFlight(_ status: OrchestrationV2TurnItemStatus) -> Bool {
        switch status {
        case .pending, .running, .waiting: true
        default: false
        }
    }

    /// "128K" rather than "128000": the magnitude is the information.
    static func compactTokenCount(_ count: Int) -> String {
        count.formatted(.number.notation(.compactName))
    }

    static func rollbackDetail(rolledBackRunCount: Int, restoredFileCount: Int) -> String? {
        var parts: [String] = []
        if rolledBackRunCount > 0 {
            parts.append("\(rolledBackRunCount) \(rolledBackRunCount == 1 ? "turn" : "turns")")
        }
        if restoredFileCount > 0 {
            parts.append(
                "\(restoredFileCount) \(restoredFileCount == 1 ? "file" : "files") restored"
            )
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func endpointLabel(instanceID: String, model: String?) -> String {
        guard let model, !model.isEmpty else { return instanceID }
        return model
    }

    /// Newest run on an instance strictly before `beforeOrdinal`. Handoff items
    /// persisted before models were stamped only carry instance ids, so the
    /// origin model is recovered from the run history.
    private static func latestRunModelBefore(
        _ runs: [LifecycleTimelineRun],
        instanceID: String,
        beforeOrdinal: Int?
    ) -> String? {
        var best: LifecycleTimelineRun?
        for run in runs where run.providerInstanceID == instanceID {
            if let beforeOrdinal, run.ordinal >= beforeOrdinal { continue }
            if best == nil || run.ordinal > best!.ordinal { best = run }
        }
        return best?.model
    }

    private static func subagentOrbState(
        _ status: OrchestrationV2TurnItemStatus
    ) -> LifecyclePresentation.RelatedThread.OrbState {
        if status == .failed { return .failed }
        return status.isTerminal ? .done : .active
    }

    /// Collapses a prompt or streamed result to the single line a row has room for.
    private static func oneLine(_ value: String?) -> String? {
        let compact = value?.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return compact?.isEmpty == false ? compact : nil
    }

    public static func resolvePresentation(
        _ item: OrchestrationV2TurnItem,
        runs: [LifecycleTimelineRun] = []
    ) -> LifecyclePresentation? {
        switch item.payload {
        // Stopping is what the reader asked for, so it reads neutral. The
        // request only shows until its result lands; the feed drops a request
        // whose run already has one, so one Stop leaves one "Stopped".
        case let .runInterruptRequest(message):
            return .divider(
                .init(
                    label: item.status.isTerminal ? "Stop requested" : "Stopping…",
                    detail: message.isEmpty ? nil : message,
                    tone: .neutral,
                    symbol: "stop",
                    layout: .inline,
                    busy: false,
                    actionLabel: nil,
                    openThreadID: nil
                )
            )

        case let .runInterruptResult(message):
            let failed = item.status == .failed
            return .divider(
                .init(
                    label: failed ? "Couldn't stop" : "Stopped",
                    detail: message.isEmpty ? nil : message,
                    tone: failed ? .danger : .neutral,
                    symbol: failed ? "exclamationmark.circle" : "stop",
                    layout: .inline,
                    busy: false,
                    actionLabel: nil,
                    openThreadID: nil
                )
            )

        case let .checkpointRollback(_, _, restoredFileCount, rolledBackRunCount):
            return .divider(
                .init(
                    label: "Rolled back",
                    detail: rollbackDetail(
                        rolledBackRunCount: rolledBackRunCount,
                        restoredFileCount: restoredFileCount
                    ),
                    tone: .neutral,
                    symbol: "arrow.uturn.backward",
                    layout: .inline,
                    busy: false,
                    actionLabel: nil,
                    openThreadID: nil
                )
            )

        case let .compaction(_, summary, beforeTokenCount, afterTokenCount):
            let tokenDetail: String? =
                (beforeTokenCount == nil && afterTokenCount == nil)
                ? nil
                : "\(beforeTokenCount.map(compactTokenCount) ?? "?") → \(afterTokenCount.map(compactTokenCount) ?? "?") tokens"
            return .divider(
                .init(
                    label: "Chat compacted",
                    detail: summary ?? tokenDetail,
                    tone: .neutral,
                    symbol: "minus",
                    layout: .inline,
                    busy: false,
                    actionLabel: nil,
                    openThreadID: nil
                )
            )

        case let .handoff(_, fromInstanceIDs, fromModelSelections, _, toInstanceID, toModel, _, _):
            let handoffRun = item.base.runId.flatMap { runID in
                runs.first { $0.id == runID }
            }
            let resolvedToModel =
                toModel
                ?? (handoffRun?.providerInstanceID == toInstanceID ? handoffRun?.model : nil)

            let fromEndpoints: [String]
            if let fromModelSelections, !fromModelSelections.isEmpty {
                fromEndpoints = fromModelSelections.map {
                    endpointLabel(instanceID: $0.instanceId, model: $0.model)
                }
            } else {
                fromEndpoints = fromInstanceIDs.map { instanceID in
                    endpointLabel(
                        instanceID: instanceID,
                        model: latestRunModelBefore(
                            runs, instanceID: instanceID, beforeOrdinal: handoffRun?.ordinal
                        )
                    )
                }
            }

            let target = endpointLabel(instanceID: toInstanceID, model: resolvedToModel)
            let preparing = isHandoffInFlight(item.status)
            let label =
                preparing
                ? "Handing off…"
                : (item.status == .failed ? "Context handoff failed" : "Context handoff")
            return .divider(
                .init(
                    label: label,
                    detail: fromEndpoints.isEmpty
                        ? target
                        : "\(fromEndpoints.joined(separator: ", ")) → \(target)",
                    tone: item.status == .failed ? .danger : .neutral,
                    symbol: "bolt",
                    layout: .stacked,
                    busy: preparing,
                    actionLabel: nil,
                    openThreadID: nil
                )
            )

        case let .fork(source, targetThreadID, _):
            let sourceThreadID: String? = if case let .run(threadID, _) = source { threadID } else { nil }
            return .divider(
                .init(
                    label: sourceThreadID != nil ? "Forked from conversation" : "Conversation fork",
                    detail: nil,
                    tone: .neutral,
                    symbol: "arrow.triangle.branch",
                    layout: .inline,
                    busy: false,
                    actionLabel: sourceThreadID != nil
                        ? "Open source conversation"
                        : "Open fork",
                    openThreadID: sourceThreadID ?? targetThreadID
                )
            )

        case let .threadCreated(targetThreadID, _, targetProviderInstanceID, targetModel):
            return .relatedThread(
                .init(
                    symbol: "message",
                    title: item.base.title ?? "Created thread",
                    preview: "\(targetProviderInstanceID) · \(targetModel)",
                    detail: nil,
                    meta: "Created",
                    status: nil,
                    threadID: targetThreadID,
                    orbSeed: nil,
                    orbState: nil
                )
            )

        case let .subagent(subagentID, _, _, _, childThreadID, prompt, progress, result):
            let title = (item.base.title ?? "Subagent").trimmingCharacters(in: .whitespacesAndNewlines)
            return .relatedThread(
                .init(
                    symbol: "sparkles",
                    title: title.isEmpty ? "Subagent" : title,
                    preview: oneLine(prompt),
                    // Once it stops, the last streamed result says more than a
                    // stale progress line; while it runs, live progress comes first.
                    detail: subagentDetailPreview(status: item.status, progress: progress, result: result),
                    meta: nil,
                    status: WorkRowStatus(agentStatus: item.status.rawValue),
                    threadID: childThreadID,
                    // Child thread id first: the relationship surfaces only know
                    // thread ids, so this keeps one agent the same colour
                    // everywhere it appears.
                    orbSeed: childThreadID ?? subagentID,
                    orbState: subagentOrbState(item.status)
                )
            )

        default:
            return nil
        }
    }
}
