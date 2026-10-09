import Foundation
import Observation
import SwiftUI

// Find in the open thread (web's `useThreadFind` / `ThreadFindBar`). The server
// counts matches in the text the timeline renders for user and assistant
// messages and proposed plans, so counts cover history this client has not
// loaded; the transcript then scrolls to the selected entry and paints the
// query in what it renders.

/// The environment call find needs. Optional on purpose: a client that cannot
/// reach a server's find hides the affordance.
@MainActor
protocol FeatureThreadFinding: AnyObject {
    /// One result, or with `progressive` an early `complete: false` frame and
    /// then the final result. Cancelling the consumer cancels the request.
    func findInThread(
        threadID: String,
        query: ThreadFindQuery,
        progressive: Bool
    ) -> AsyncThrowingStream<ThreadFindResult, Error>
}

/// The selected match and its absolute ordinal among all matches.
struct ThreadFindSelection: Equatable, Sendable {
    let activeIndex: Int
    let match: ThreadFindMatch

    var start: ThreadFindStart { ThreadFindStart(entryId: match.entryId, occurrence: match.occurrence) }
}

/// A match for the transcript to scroll to; a new `id` asks again even when
/// the match is the same one.
struct ThreadFindReveal: Equatable, Sendable {
    let id: Int
    let match: ThreadFindMatch
}

enum ThreadFindNavigation {
    enum Step: Equatable {
        /// The window around the selection names the next match already.
        case local(ThreadFindSelection)
        /// Ask the server, relative to the selected identity.
        case remote(start: ThreadFindStart, offset: Int)
    }

    /// Moves `delta` through `total` matches, wrapping at both ends.
    static func wrap(_ index: Int, total: Int, delta: Int) -> Int {
        guard total > 0 else { return 0 }
        let clamped = min(max(index, 0), total - 1)
        return ((clamped + delta) % total + total) % total
    }

    /// Nil while there is nothing to step through, including while a
    /// progressive search is still counting.
    static func step(result: ThreadFindResult, selection: ThreadFindSelection?, delta: Int) -> Step? {
        guard result.totalMatches > 0, !result.isCounting, let selection else { return nil }
        let next = wrap(selection.activeIndex, total: result.totalMatches, delta: delta)
        if let entry = result.navigation?.first(where: { next >= $0.startIndex && next < $0.startIndex + $0.count }) {
            return .local(ThreadFindSelection(
                activeIndex: next,
                match: ThreadFindMatch(entryId: entry.entryId, runId: entry.runId, occurrence: next - entry.startIndex)
            ))
        }
        return .remote(start: selection.start, offset: delta)
    }

    /// "3 of 12", "1 of …" while counting, "No results", or nothing yet.
    static func countLabel(result: ThreadFindResult?, selection: ThreadFindSelection?) -> String? {
        guard let result else { return nil }
        if result.isCounting { return "1 of …" }
        guard result.totalMatches > 0 else { return "No results" }
        let index = min(max(selection?.activeIndex ?? result.activeIndex, 0), result.totalMatches - 1)
        return "\(index + 1) of \(result.totalMatches)"
    }
}

enum ThreadFindText {
    /// Non-overlapping, case-insensitive occurrences of `query` in `text`, as
    /// UTF-16 ranges. Mirrors the server's matcher closely enough to paint
    /// what it counted.
    static func occurrences(of query: String, in text: String) -> [NSRange] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, !text.isEmpty else { return [] }
        let source = text as NSString
        var ranges: [NSRange] = []
        var cursor = 0
        while cursor < source.length {
            let found = source.range(
                of: query,
                options: [.caseInsensitive, .literal],
                range: NSRange(location: cursor, length: source.length - cursor)
            )
            guard found.location != NSNotFound, found.length > 0 else { break }
            ranges.append(found)
            cursor = NSMaxRange(found)
        }
        return ranges
    }

    /// Text marks for one rendered text: every occurrence, with the active one
    /// in the stronger color.
    @MainActor
    static func marks(query: String, in text: String, activeOccurrence: Int?) -> [MarkdownTextMark] {
        occurrences(of: query, in: text).enumerated().map { index, range in
            index == activeOccurrence
                ? MarkdownTextMark(range: range, background: T3Colors.searchMatchActiveBackground, foreground: T3Colors.searchMatchActiveForeground)
                : MarkdownTextMark(range: range, background: T3Colors.searchMatchBackground, foreground: T3Colors.searchMatchForeground)
        }
    }
}

/// What the transcript paints: the query once a search has a match, and the
/// selected entry and occurrence. Rows read it from their environment, so a
/// change re-renders only rows that render text.
@MainActor @Observable
final class ThreadFindHighlight {
    private(set) var query = ""
    private(set) var activeEntryID: String?
    private(set) var activeOccurrence = 0

    func update(query: String, match: ThreadFindMatch?) {
        let query = match == nil ? "" : query
        if self.query != query { self.query = query }
        if activeEntryID != match?.entryId { activeEntryID = match?.entryId }
        let occurrence = match?.occurrence ?? 0
        if activeOccurrence != occurrence { activeOccurrence = occurrence }
    }

    func isActive(_ entryID: String?) -> Bool {
        entryID != nil && entryID == activeEntryID
    }
}

private struct ThreadFindHighlightKey: EnvironmentKey {
    static let defaultValue: ThreadFindHighlight? = nil
}

private struct ThreadFindEntryIDKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    var threadFindHighlight: ThreadFindHighlight? {
        get { self[ThreadFindHighlightKey.self] }
        set { self[ThreadFindHighlightKey.self] = newValue }
    }

    /// The find identity of the timeline entry a view renders inside.
    var threadFindEntryID: String? {
        get { self[ThreadFindEntryIDKey.self] }
        set { self[ThreadFindEntryIDKey.self] = newValue }
    }
}

extension ThreadTimelineEntry {
    /// How the server's find names this entry: the message id for user and
    /// assistant messages, the turn item id for a proposed plan.
    var findEntryID: String? {
        switch self {
        case let .message(message, _):
            message.role == .user || message.role == .assistant ? message.wireMessageID : nil
        case let .proposedPlan(entry):
            entry.plan.itemID
        default:
            nil
        }
    }
}

/// The selected entry's mark: a quiet amber wash behind the whole row, so the
/// match is findable even where its text is not painted (code, chips).
struct ThreadFindEntryEmphasis: ViewModifier {
    let entryID: String?
    @SwiftUI.Environment(\.threadFindHighlight) private var highlight

    func body(content: Content) -> some View {
        content.background {
            if highlight?.isActive(entryID) == true {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(T3Colors.searchMatchBackground.opacity(0.22))
                    .overlay {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(T3Colors.searchMatchActiveBackground.opacity(0.7), lineWidth: 1.5)
                    }
                    .padding(.horizontal, -8)
                    .padding(.top, -6)
                    .padding(.bottom, ChatTimelineStyle.entrySpacing - 6)
                    .accessibilityHidden(true)
            }
        }
    }
}

/// Owns find for the open thread: the query, the server's result, local steps
/// through its navigation window, and what the transcript reveals.
@MainActor @Observable
final class ThreadFindModel {
    enum Status: Equatable {
        case idle
        case searching
        case failed
    }

    typealias Search = (ThreadFindQuery, _ progressive: Bool) -> AsyncThrowingStream<ThreadFindResult, Error>

    private(set) var isOpen = false
    private(set) var query = ""
    private(set) var result: ThreadFindResult?
    private(set) var selection: ThreadFindSelection?
    private(set) var status: Status = .idle
    /// Bumped to put focus back in the search field.
    private(set) var focusRequest = 0
    private(set) var reveal: ThreadFindReveal?
    let highlight = ThreadFindHighlight()

    /// Skill labels the transcript displays, so `$skill` tokens match as shown.
    @ObservationIgnored var skills: [ThreadFindSkillLabel] = []
    /// The first searchable entry being read, which a new query starts from.
    @ObservationIgnored var readingPosition: (() -> ThreadFindStart?)?
    @ObservationIgnored private var threadID: String?
    @ObservationIgnored private var search: Search?
    @ObservationIgnored private var progressive = false
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var inFlight = false
    /// The relative step a request in flight answers; later steps add to it.
    @ObservationIgnored private var pendingStep: (start: ThreadFindStart, offset: Int)?
    @ObservationIgnored private var lastRequest: (query: ThreadFindQuery, progressive: Bool)?
    @ObservationIgnored private var revealCount = 0

    var countLabel: String? {
        switch status {
        case .failed: return "Search failed"
        case .searching where result == nil: return "Searching…"
        default: return ThreadFindNavigation.countLabel(result: result, selection: selection)
        }
    }

    var canStep: Bool {
        guard let result, result.totalMatches > 0, !result.isCounting else { return false }
        return status != .searching || pendingStep != nil
    }

    var hasNoResults: Bool {
        status == .idle && result?.totalMatches == 0
    }

    /// Opens find on `threadID`, or puts focus back when it is already open.
    func open(threadID: String, progressive: Bool, search: @escaping Search) {
        if isOpen, self.threadID == threadID {
            focusRequest += 1
            return
        }
        close()
        self.threadID = threadID
        self.progressive = progressive
        self.search = search
        isOpen = true
        focusRequest += 1
    }

    /// Clears everything, including what the transcript paints.
    func close() {
        cancelRequest()
        refreshTask?.cancel()
        refreshTask = nil
        isOpen = false
        threadID = nil
        search = nil
        query = ""
        result = nil
        selection = nil
        status = .idle
        reveal = nil
        lastRequest = nil
        highlight.update(query: "", match: nil)
    }

    func setQuery(_ text: String) {
        guard isOpen, text != query else { return }
        query = text
        cancelRequest()
        refreshTask?.cancel()
        refreshTask = nil
        result = nil
        selection = nil
        highlight.update(query: "", match: nil)
        guard let base = ThreadFindQuery(query: text, skills: skills) else {
            status = .idle
            return
        }
        status = .searching
        var request = base
        request.start = readingPosition?()
        run(request, progressive: progressive, explicit: false, debounce: .milliseconds(150))
    }

    func next() { step(1) }
    func previous() { step(-1) }

    func step(_ delta: Int) {
        guard isOpen, canStep, let result, let base = ThreadFindQuery(query: query, skills: skills) else { return }
        if var pending = pendingStep {
            // Steps taken while the server answers an earlier one add up.
            pending.offset += delta
            pendingStep = pending
            var request = base
            request.start = pending.start
            request.offset = pending.offset
            run(request, progressive: false, explicit: true)
            return
        }
        guard let step = ThreadFindNavigation.step(result: result, selection: selection, delta: delta) else { return }
        switch step {
        case let .local(next):
            // A quiet refresh in flight would answer for the old selection.
            if inFlight { cancelRequest() }
            selection = next
            highlight.update(query: base.query, match: next.match)
            requestReveal(next.match)
        case let .remote(start, offset):
            pendingStep = (start, offset)
            var request = base
            request.start = start
            request.offset = offset
            run(request, progressive: false, explicit: true)
        }
    }

    /// Waits for the request in flight to settle; tests step through with it.
    func settle() async {
        await task?.value
    }

    func retry() {
        guard let lastRequest else { return }
        status = .searching
        run(lastRequest.query, progressive: lastRequest.progressive, explicit: true)
    }

    /// The thread changed under an open search. Counts are refreshed at most
    /// every 300 ms, anchored to the selected identity so new matches above it
    /// do not move the selection.
    func contentChanged() {
        guard isOpen, refreshTask == nil, status != .failed,
              ThreadFindQuery(query: query, skills: skills) != nil else { return }
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, let self else { return }
            self.refreshTask = nil
            guard !self.inFlight, let base = ThreadFindQuery(query: self.query, skills: self.skills) else { return }
            var request = base
            request.start = self.selection?.start ?? self.readingPosition?()
            self.run(request, progressive: false, explicit: false)
        }
    }

    private func run(
        _ request: ThreadFindQuery,
        progressive: Bool,
        explicit: Bool,
        debounce: Duration? = nil
    ) {
        cancelTask()
        guard let search else { return }
        generation += 1
        let generation = generation
        inFlight = true
        lastRequest = (request, progressive)
        task = Task { [weak self] in
            if let debounce {
                try? await Task.sleep(for: debounce)
                guard !Task.isCancelled else { return }
            }
            do {
                for try await result in search(request, progressive) {
                    guard let self, self.generation == generation else { return }
                    self.apply(result, query: request.query, explicit: explicit)
                }
                guard let self, self.generation == generation else { return }
                self.inFlight = false
            } catch {
                guard !(error is CancellationError), let self, self.generation == generation else { return }
                self.inFlight = false
                self.pendingStep = nil
                self.status = .failed
                AccessibilityNotification.Announcement("Could not search this thread. Please retry.").post()
            }
        }
    }

    private func apply(_ result: ThreadFindResult, query: String, explicit: Bool) {
        let previous = selection?.match
        self.result = result
        selection = result.match.map { ThreadFindSelection(activeIndex: result.activeIndex, match: $0) }
        if !result.isCounting { pendingStep = nil }
        status = .idle
        highlight.update(query: query, match: result.match)
        // Finishing a count or a quiet refresh leaves the reader where they are.
        if let match = result.match, explicit || match != previous {
            requestReveal(match)
        }
    }

    private func requestReveal(_ match: ThreadFindMatch) {
        revealCount += 1
        reveal = ThreadFindReveal(id: revealCount, match: match)
    }

    private func cancelRequest() {
        cancelTask()
        pendingStep = nil
    }

    private func cancelTask() {
        generation += 1
        task?.cancel()
        task = nil
        inFlight = false
    }
}
