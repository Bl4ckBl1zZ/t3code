import Foundation

// The guided review's rules, ported from `packages/client-runtime/src/reviewGuideTour.ts`
// and upstream mobile's `reviewGuideState.ts` / `guideDiffFocus.ts`. Kept apart
// from the views so ordering, stepping and excerpt slicing are testable.

/// A range of one side's line numbers to focus in a file's diff.
struct PullRequestReviewGuideFocus: Hashable, Sendable {
    let side: String
    let start: Int
    let end: Int

    init(side: String, start: Int, end: Int) {
        self.side = side; self.start = start; self.end = end
    }

    init(_ excerpt: PullRequestReviewGuideExcerpt) {
        self.init(side: excerpt.side, start: excerpt.start, end: excerpt.end)
    }

    /// The line number a diff line has on this focus's side.
    func lineNumber(_ line: FeatureDiffLine) -> Int? {
        side == "old" ? line.oldLine : line.newLine
    }

    func contains(_ line: FeatureDiffLine) -> Bool {
        guard line.kind != .hunk, let number = lineNumber(line) else { return false }
        return number >= start && number <= end
    }
}

enum PullRequestReviewGuideTour {
    /// One step forward or back, held to the tour's first and last stops.
    static func step(_ current: Int, by delta: Int, stopCount: Int) -> Int {
        max(min(current + delta, stopCount - 1), 0)
    }

    /// The stop's files in reading order: the excerpted ones first, then the rest it owns.
    static func filePaths(_ stop: PullRequestReviewGuideStop) -> [String] {
        var seen = Set<String>()
        return (stop.excerpts.map(\.path) + stop.files.map(\.path)).filter { seen.insert($0).inserted }
    }

    /// Every file the tour passes through, counted once.
    static func fileCount(_ guide: PullRequestReviewGuide) -> Int {
        Set(guide.stops.flatMap(filePaths)).count
    }

    /// The outline's second line for a stop: its first file's name and how many more.
    static func subline(_ stop: PullRequestReviewGuideStop) -> String {
        let paths = filePaths(stop)
        guard let first = paths.first else { return "Context, no code" }
        let name = first.split(separator: "/").last.map(String.init) ?? first
        return paths.count > 1 ? "\(name) +\(paths.count - 1)" : name
    }

    /// A note's marker: A, B, C… in the order the guide lists them, numbers past Z.
    static func noteMarker(_ index: Int) -> String {
        index < 26 ? String(UnicodeScalar(UInt8(65 + index))) : String(index + 1)
    }

    struct LetteredNote: Equatable {
        let marker: String
        let note: PullRequestReviewGuideNote
    }

    static func letteredNotes(_ stop: PullRequestReviewGuideStop) -> [LetteredNote] {
        stop.notes.enumerated().map { LetteredNote(marker: noteMarker($0.offset), note: $0.element) }
    }

    /// The markers an excerpt shows, by the line (on the excerpt's side) each
    /// note sits on. A note outside every excerpt keeps its letter in the list;
    /// it just has no line to mark.
    static func markers(
        _ stop: PullRequestReviewGuideStop,
        excerpt: PullRequestReviewGuideExcerpt
    ) -> [Int: [String]] {
        var result: [Int: [String]] = [:]
        for entry in letteredNotes(stop)
        where entry.note.path == excerpt.path && entry.note.line >= excerpt.start && entry.note.line <= excerpt.end {
            result[entry.note.line, default: []].append(entry.marker)
        }
        return result
    }

    /// The lines an excerpt covers in a parsed file diff. Its range is in one
    /// side's numbers, so the other side's half of a replacement at either edge
    /// comes along: an excerpt starting on an added line also shows the lines
    /// it replaced, which is what makes it read as a change rather than new
    /// code. Hunk headers between two hunks it spans stay in, as the gap.
    static func excerptLines(
        _ lines: [FeatureDiffLine],
        excerpt: PullRequestReviewGuideExcerpt
    ) -> [FeatureDiffLine] {
        let focus = PullRequestReviewGuideFocus(excerpt)
        guard var first = lines.firstIndex(where: focus.contains),
              var last = lines.lastIndex(where: focus.contains) else { return [] }
        // A hunk header is neither a deletion nor an addition, so walking out
        // over the replacement's other half stops at its own hunk's edge.
        if excerpt.side == "new", lines[first].kind == .addition {
            while first > 0, lines[first - 1].kind == .deletion { first -= 1 }
        }
        if excerpt.side == "old", lines[last].kind == .deletion {
            while last < lines.count - 1, lines[last + 1].kind == .addition { last += 1 }
        }
        return Array(lines[first...last])
    }

    /// The lines of a file's diff a focus marks, matched on its own side so a
    /// deletion-only range still finds its rows.
    static func focusedLineIDs(_ lines: [FeatureDiffLine], focus: PullRequestReviewGuideFocus?) -> Set<String> {
        guard let focus else { return [] }
        return Set(lines.filter(focus.contains).map(\.id))
    }

    static func attentionLabel(_ kind: String) -> String {
        switch kind {
        case "tradeoff": "A tradeoff to weigh"
        case "contract": "A contract to check"
        case "product": "A product call"
        case "risk": "A risk to judge"
        case "accessibility": "An accessibility call"
        default: "Look closely"
        }
    }
}

/// What a guide result means for the reader. Old failures must not follow a
/// PR onto a different head.
struct PullRequestReviewGuideState: Equatable {
    let guide: PullRequestReviewGuide?
    let running: Bool
    /// The guide was written before the latest push. An unknown head is not stale.
    let stale: Bool
    let failure: String?

    init(_ data: PullRequestReviewGuideResult?) {
        guide = data?.guide
        if case .running = data?.run { running = true } else { running = false }
        if let guide = data?.guide, let head = data?.currentHeadSha {
            stale = guide.headSha != head
        } else {
            stale = false
        }
        if case let .failed(headSha, _, detail) = data?.run, headSha == data?.currentHeadSha {
            failure = detail
        } else {
            failure = nil
        }
    }
}

/// The one notice above a guide, so its action stays in one place as loading,
/// writing and retry states change. A pending refresh never hides a cached
/// guide, and a new run never reveals an old failure.
struct PullRequestReviewGuideNotice: Equatable {
    enum Kind: Equatable {
        case loading, empty, ready, stale, writing, failed, unavailable
    }

    let kind: Kind
    let title: String
    let description: String
    let action: String

    init(data: PullRequestReviewGuideResult?, running: Bool, startError: String?, error: String?) {
        let state = PullRequestReviewGuideState(data)
        if running {
            self.init(.writing, state.guide == nil ? "Writing guide" : "Rewriting guide",
                state.guide == nil
                    ? "An agent is reading the change and writing the tour. You can leave and come back when it’s ready."
                    : "You can keep reading this guide while the agent writes the update.",
                state.guide == nil ? "Writing Guide…" : "Rewriting…")
        } else if let failure = startError ?? state.failure {
            self.init(.failed, "Couldn’t write guide", failure, "Try Again")
        } else if let error {
            self.init(.unavailable, "Couldn’t refresh guide", error, "Try Again")
        } else if data == nil {
            self.init(.loading, "Review guide", "Checking for a saved guide…", "Loading Guide…")
        } else if state.stale {
            self.init(.stale, "New changes since this guide",
                "You can read the previous guide, or rewrite it for the latest changes.", "Rewrite Guide")
        } else {
            self.init(state.guide == nil ? .empty : .ready, "Review guide",
                "Get a tour of the change, with code excerpts and notes on what needs a closer look.", "Write Guide")
        }
    }

    private init(_ kind: Kind, _ title: String, _ description: String, _ action: String) {
        self.kind = kind; self.title = title; self.description = description; self.action = action
    }

    var isBusy: Bool { kind == .loading || kind == .writing }
    var isFailure: Bool { kind == .failed || kind == .unavailable }
}
