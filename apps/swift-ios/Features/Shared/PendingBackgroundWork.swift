import Foundation

/// Names what a settled thread still runs, grouped by kind, from the shell's
/// `pendingBackgroundTasks`. Mirrors client-runtime's
/// `presentPendingBackgroundWork`, so a thread says the same thing on every
/// surface: "Waiting on subagent Review Diff", "Waiting on 2 subagents and 1
/// command", or "Running: Start the dev server" when only commands remain.
struct PendingBackgroundWorkPresentation: Equatable, Sendable {
    typealias Kind = OrchestrationV2PendingBackgroundTask.Kind

    struct Item: Equatable, Sendable {
        let taskId: String
        let kind: Kind
        /// The work's name, or its noun when the server gave none.
        let label: String
        /// A subagent's own thread, when it has one.
        let childThreadId: String?
    }

    let title: String
    let items: [Item]
    /// True when the work will wake the agent (subagents, monitors). False
    /// when only commands remain, such as a dev server: the agent is done.
    let waiting: Bool

    init?(_ tasks: [OrchestrationV2PendingBackgroundTask]) {
        guard !tasks.isEmpty else { return nil }
        let waiting = OrchestrationV2PendingBackgroundTask.holdCompletion(tasks)
        // Agents first, loose tasks last. Sorted on the original index too so
        // the order within a kind is the server's, as with a stable sort.
        let items = tasks.enumerated()
            .sorted { left, right in
                let leftOrder = Self.order(left.element.kind)
                let rightOrder = Self.order(right.element.kind)
                return leftOrder != rightOrder ? leftOrder < rightOrder : left.offset < right.offset
            }
            .map { Self.item($0.element) }

        let title: String
        if items.count == 1, let only = items.first {
            let noun = Self.singular(only.kind)
            let named = only.label != noun
            title = waiting
                ? (named ? "Waiting on \(noun) \(only.label)" : "Waiting on a \(noun)")
                : (named ? "Running: \(only.label)" : "Running a \(noun)")
        } else {
            var kinds: [Kind] = []
            var counts: [Kind: Int] = [:]
            for item in items {
                if counts[item.kind] == nil { kinds.append(item.kind) }
                counts[item.kind, default: 0] += 1
            }
            let groups = kinds.map { kind -> String in
                let count = counts[kind] ?? 0
                return "\(count) \(count == 1 ? Self.singular(kind) : Self.plural(kind))"
            }
            title = "\(waiting ? "Waiting on" : "Running") \(Self.joinWithAnd(groups))"
        }
        self.title = title
        self.items = items
        self.waiting = waiting
    }

    private static func item(_ task: OrchestrationV2PendingBackgroundTask) -> Item {
        let description = task.description?.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = task.kind == .subagent
            ? description.map { SubagentDisplayTitle.format($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            : description
        return Item(
            taskId: task.taskId,
            kind: task.kind,
            label: label.flatMap { $0.isEmpty ? nil : $0 } ?? singular(task.kind),
            childThreadId: task.kind == .subagent ? task.childThreadId : nil
        )
    }

    private static func order(_ kind: Kind) -> Int {
        switch kind {
        case .subagent: 0
        case .command: 1
        case .monitor: 2
        case .backgroundTask: 3
        }
    }

    private static func singular(_ kind: Kind) -> String {
        switch kind {
        case .subagent: "subagent"
        case .command: "command"
        case .monitor: "monitor"
        case .backgroundTask: "background task"
        }
    }

    private static func plural(_ kind: Kind) -> String {
        switch kind {
        case .subagent: "subagents"
        case .command: "commands"
        case .monitor: "monitors"
        case .backgroundTask: "background tasks"
        }
    }

    private static func joinWithAnd(_ parts: [String]) -> String {
        guard parts.count > 1, let last = parts.last else { return parts.joined() }
        return "\(parts.dropLast().joined(separator: ", ")) and \(last)"
    }
}

/// Mirrors client-runtime's `formatSubagentDisplayTitle`: drops a leading
/// "Subagent:" and turns a Codex task path such as `/root/review_diff` into
/// "Review Diff". Anything else passes through.
enum SubagentDisplayTitle {
    static func format(_ title: String) -> String {
        var display = Substring(title)
        if let prefix = display.range(of: "Subagent:", options: [.caseInsensitive, .anchored]) {
            display = display[prefix.upperBound...].drop(while: \.isWhitespace)
        }
        let root = "/root/"
        guard display.hasPrefix(root) else { return String(display) }
        var path = display.dropFirst(root.count)
        if path.hasSuffix("/") { path = path.dropLast() }
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        guard let last = segments.last, segments.allSatisfy({ !$0.isEmpty }) else {
            return String(display)
        }
        let words = last.split { $0 == "_" || $0.isWhitespace }
        guard !words.isEmpty else { return String(display) }
        return words.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
}

extension FeatureThread {
    /// What a Background thread is waiting on, in words. Nil when the thread
    /// is not in Background or the server sent no names.
    var backgroundWorkStatusTitle: String? {
        guard homeStatus == .background, let pendingBackgroundTasks else { return nil }
        return PendingBackgroundWorkPresentation(pendingBackgroundTasks)?.title
    }

    /// Commands the thread left running, such as a dev server. They never hold
    /// the thread in Background, so the home row marks them with a glyph of
    /// their own, as the desktop sidebar marks a running terminal. Empty on
    /// servers that send only counts, which cannot tell a command apart.
    var runningBackgroundCommands: [OrchestrationV2PendingBackgroundTask] {
        pendingBackgroundTasks?.filter { $0.kind == .command } ?? []
    }

    /// The running commands in words ("Running: vp run dev"), for a row whose
    /// status does not already name them. Background's title already does.
    var runningBackgroundCommandsTitle: String? {
        guard homeStatus != .background else { return nil }
        return PendingBackgroundWorkPresentation(runningBackgroundCommands)?.title
    }
}
