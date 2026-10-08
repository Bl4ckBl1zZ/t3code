import Foundation

// Ports apps/web/src/proposedPlan.ts and the plan halves of
// apps/web/src/session-logic.ts (`findLatestProposedPlan`,
// `deriveActivePlanState`, the follow-up gate in ChatView).

/// Pure text helpers for a proposed plan's markdown, shared by the transcript
/// card, the composer banner and the plan sheet so all three title, trim and
/// export a plan the same way web does.
enum ProposedPlanMarkdown {
    static let implementationPromptPrefix = "PLEASE IMPLEMENT THIS PLAN:\n"

    /// The first markdown heading, which is how web names a plan.
    static func title(_ markdown: String) -> String? {
        for line in markdown.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            if let text = headingText(line) { return text }
        }
        return nil
    }

    /// What the card shows under its own title: the plan without the heading
    /// that became the title, and without a redundant leading "Summary" heading.
    static func displayed(_ markdown: String) -> String {
        var lines = lines(of: trimmingTrailingWhitespace(markdown))
        if let first = lines.first, isHeading(first) { lines.removeFirst() }
        dropLeadingBlankLines(&lines)
        if let first = lines.first, headingText(Substring(first))?.lowercased() == "summary" {
            lines.removeFirst()
            dropLeadingBlankLines(&lines)
        }
        return lines.joined(separator: "\n")
    }

    /// The first `maxLines` non-blank lines of the displayed plan, with an
    /// ellipsis paragraph when more follows.
    static func collapsedPreview(_ markdown: String, maxLines: Int = 8) -> String {
        let source = lines(of: trimmingTrailingWhitespace(displayed(markdown)))
            .map(trimmingTrailingWhitespace)
        var preview: [String] = []
        var visibleLineCount = 0
        var hasMoreContent = false
        for line in source {
            let isVisible = !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if isVisible, visibleLineCount >= maxLines {
                hasMoreContent = true
                break
            }
            preview.append(line)
            if isVisible { visibleLineCount += 1 }
        }
        while let last = preview.last, last.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            preview.removeLast()
        }
        if preview.isEmpty { return title(markdown) ?? "Plan preview unavailable." }
        if hasMoreContent { preview.append(contentsOf: ["", "..."]) }
        return preview.joined(separator: "\n")
    }

    /// Web collapses a plan longer than 900 characters or 20 lines. UTF-16,
    /// as JavaScript counts them.
    static func isLong(_ markdown: String) -> Bool {
        markdown.utf16.count > 900 || lines(of: markdown).count > 20
    }

    /// The turn Implement sends: exactly web's prompt, plan included verbatim.
    static func implementationPrompt(_ markdown: String) -> String {
        implementationPromptPrefix + markdown.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The title of the thread "Implement in New Thread" starts, truncated the
    /// way `@t3tools/shared/String.truncate` truncates it.
    static func implementationThreadTitle(_ markdown: String) -> String {
        let full = title(markdown).map { "Implement \($0)" } ?? "Implement plan"
        let trimmed = full.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count <= 50 ? trimmed : "\(trimmed.prefix(50))..."
    }

    /// A stable `.md` name derived from the title, as web downloads it.
    static func filename(_ markdown: String) -> String {
        let removed: Set<Character> = ["`", "'", "\"", ".", ",", "!", "?", "(", ")", "[", "]", "{", "}"]
        var slug = ""
        var pendingDash = false
        for character in (title(markdown) ?? "plan").lowercased() where !removed.contains(character) {
            if character.isASCII, character.isLetter || character.isNumber {
                if pendingDash, !slug.isEmpty { slug.append("-") }
                pendingDash = false
                slug.append(character)
            } else {
                pendingDash = true
            }
        }
        return "\(slug.isEmpty ? "plan" : slug).md"
    }

    /// The file contents Copy, Share and Save write: one trailing newline.
    static func exported(_ markdown: String) -> String {
        trimmingTrailingWhitespace(markdown) + "\n"
    }

    // MARK: - Lines

    /// `^\s{0,3}#{1,6}\s+`: an ATX heading marker.
    private static func isHeading(_ line: some StringProtocol) -> Bool {
        headingBody(line) != nil
    }

    /// `^\s{0,3}#{1,6}\s+(.+)$`, trimmed; nil when the heading has no text.
    private static func headingText(_ line: some StringProtocol) -> String? {
        guard let body = headingBody(line) else { return nil }
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    private static func headingBody(_ line: some StringProtocol) -> Substring? {
        let line = Substring(line)
        var index = line.startIndex
        var indent = 0
        while index < line.endIndex, line[index] == " " || line[index] == "\t", indent < 3 {
            indent += 1
            index = line.index(after: index)
        }
        var hashes = 0
        while index < line.endIndex, line[index] == "#" {
            hashes += 1
            index = line.index(after: index)
        }
        guard (1...6).contains(hashes), index < line.endIndex, line[index].isWhitespace else { return nil }
        return line[index...]
    }

    private static func lines(of text: String) -> [String] {
        // "\r\n" is one Character in Swift, so it has to be named to split on.
        text.split(omittingEmptySubsequences: false) { $0 == "\n" || $0 == "\r\n" }.map(String.init)
    }

    private static func dropLeadingBlankLines(_ lines: inout [String]) {
        while let first = lines.first, first.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            lines.removeFirst()
        }
    }

    private static func trimmingTrailingWhitespace(_ text: String) -> String {
        var text = Substring(text)
        while let last = text.last, last.isWhitespace { text.removeLast() }
        return String(text)
    }
}

/// One proposed plan as the transcript, banner and sheet present it. The
/// derived text is computed once here rather than in a view body: plans are
/// long and the feed rebuilds while other rows stream.
struct ThreadProposedPlan: Equatable, Sendable, Identifiable {
    /// The projected item's id, unique across inherited rows.
    let id: String
    let planID: String
    let runID: String?
    let markdown: String
    let isStreaming: Bool
    let date: Date?
    let title: String?
    let displayedMarkdown: String
    /// Nil for a plan short enough to show whole.
    let collapsedPreview: String?
    let filename: String

    init?(_ projected: OrchestrationV2ProjectedTurnItem) {
        guard case let .proposedPlan(planID, markdown, streaming) = projected.item.payload else { return nil }
        let isStreaming = streaming || projected.item.status == .running
        // A finished plan with nothing in it says nothing a work row does not.
        guard isStreaming || !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        id = projected.id
        self.planID = planID
        runID = projected.item.base.runId
        self.markdown = markdown
        self.isStreaming = isStreaming
        date = ThreadTimelineDay.date(fromISO8601: projected.item.base.startedAt ?? projected.item.base.updatedAt)
        title = ProposedPlanMarkdown.title(markdown)
        displayedMarkdown = ProposedPlanMarkdown.displayed(markdown)
        collapsedPreview = ProposedPlanMarkdown.isLong(markdown)
            ? ProposedPlanMarkdown.collapsedPreview(markdown, maxLines: 10)
            : nil
        filename = ProposedPlanMarkdown.filename(markdown)
    }

    var exportedMarkdown: String { ProposedPlanMarkdown.exported(markdown) }
}

/// A plan card in the transcript. Its own entry rather than a work-log row, so
/// neither work grouping nor a turn fold can hide it.
struct ThreadProposedPlanEntry: Equatable, Sendable {
    let plan: ThreadProposedPlan
    /// A later turn proposed a different plan.
    let isSuperseded: Bool

    var id: String { "proposed-plan:\(plan.id)" }
}

/// The latest todo list: the run's steps with their statuses.
struct ThreadPlanSteps: Equatable, Sendable {
    let runID: String?
    let explanation: String?
    let steps: [OrchestrationV2PlanStep]
}

enum ThreadProposedPlans {
    /// Builds the feed's plan cards in one pass over the window, so each card
    /// knows whether a newer plan replaced it.
    struct Feed {
        private let latestPlanID: String?

        init(_ items: [OrchestrationV2ProjectedTurnItem]) {
            latestPlanID = items.lazy.reversed().compactMap { projected -> String? in
                guard case let .proposedPlan(planID, _, _) = projected.item.payload else { return nil }
                return planID
            }.first
        }

        func entry(for projected: OrchestrationV2ProjectedTurnItem) -> ThreadProposedPlanEntry? {
            ThreadProposedPlan(projected).map { plan in
                ThreadProposedPlanEntry(plan: plan, isSuperseded: latestPlanID.map { $0 != plan.planID } ?? false)
            }
        }
    }

    /// Web's `findLatestProposedPlan`: the newest plan of the latest run, else
    /// the newest plan in the thread. A fork's inherited plans belong to the
    /// thread they were proposed in.
    static func latest(in detail: FeatureThreadDetail) -> ThreadProposedPlan? {
        let plans = detail.timelineItems.filter {
            guard $0.visibility != .inherited, case .proposedPlan = $0.item.payload else { return false }
            return true
        }
        let latestRunID = latestRunID(detail)
        let ofLatestRun = plans.filter { latestRunID != nil && $0.item.base.runId == latestRunID }
        for projected in (ofLatestRun.isEmpty ? plans : ofLatestRun).reversed() {
            if let plan = ThreadProposedPlan(projected) { return plan }
        }
        return nil
    }

    /// Web's `showPlanFollowUpPrompt`: the plan waiting on a decision, while
    /// the thread is in Plan mode with its latest run settled and nothing else
    /// asked of the user. Nil hides the banner.
    static func followUp(in detail: FeatureThreadDetail, thread: FeatureThread) -> ThreadProposedPlan? {
        guard thread.interactionMode == .plan,
              // The shell's verdict from the server's plan table; unknown (an
              // older cached row) defers to the plan item itself.
              thread.hasActionableProposedPlan != false,
              detail.userInputs.isEmpty, detail.approvals.isEmpty,
              [.idle, .completed, .failed].contains(detail.thread.state),
              let latestRun = detail.workflow.runs.max(by: { $0.ordinal < $1.ordinal }),
              !unsettledRunStatuses.contains(latestRun.status),
              let plan = latest(in: detail), !plan.isStreaming else { return nil }
        return plan
    }

    /// Web's `isLatestRunSettled`, inverted.
    private static let unsettledRunStatuses: Set<String> = ["preparing", "queued", "starting", "running", "waiting"]

    /// Web's `deriveActivePlanState`: the latest run's todo list, else the
    /// newest one in the thread.
    static func steps(in detail: FeatureThreadDetail) -> ThreadPlanSteps? {
        let latestRunID = latestRunID(detail)
        var fallback: ThreadPlanSteps?
        for projected in detail.timelineItems.reversed() {
            guard case let .todoList(_, steps, explanation) = projected.item.payload, !steps.isEmpty else { continue }
            let candidate = ThreadPlanSteps(
                runID: projected.item.base.runId,
                explanation: explanation.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 },
                steps: steps
            )
            if latestRunID != nil, candidate.runID == latestRunID { return candidate }
            if fallback == nil { fallback = candidate }
        }
        return fallback
    }

    /// Whether the plan sheet has anything to show.
    static func hasPlan(in detail: FeatureThreadDetail) -> Bool {
        detail.timelineItems.contains {
            switch $0.item.payload {
            case let .todoList(_, steps, _): !steps.isEmpty
            case .proposedPlan: $0.visibility != .inherited
            default: false
            }
        }
    }

    private static func latestRunID(_ detail: FeatureThreadDetail) -> String? {
        detail.workflow.runs.max { $0.ordinal < $1.ordinal }?.id
    }
}

/// What Implement and Implement in New Thread send.
public struct FeatureProposedPlanImplementation: Sendable, Equatable {
    /// The feature-scoped thread the plan was proposed in.
    public let threadID: String
    public let planID: String
    public let prompt: String
    /// Titles the thread Implement in New Thread starts.
    public let newThreadTitle: String
    public let selection: FeatureSelection?

    init(threadID: String, plan: ThreadProposedPlan, selection: FeatureSelection?) {
        self.threadID = threadID
        planID = plan.planID
        prompt = ProposedPlanMarkdown.implementationPrompt(plan.markdown)
        newThreadTitle = ProposedPlanMarkdown.implementationThreadTitle(plan.markdown)
        self.selection = selection
    }
}
