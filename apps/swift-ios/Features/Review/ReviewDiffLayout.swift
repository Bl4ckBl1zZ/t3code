import Foundation

/// One row of the diff screen.
enum ReviewDiffRow: Identifiable, Equatable {
    /// A line of the diff.
    case line(FeatureDiffLine)
    /// Unchanged lines folded away. The lines are in hand, so the row expands.
    case fold(ReviewDiffFold)
    /// Unchanged lines the patch left out between two hunks. Only a hydrated
    /// file has them, so a patch-only diff (a checkpoint) says how many there
    /// are and nothing more. `heading` is the enclosing scope git names after
    /// the hunk header, such as a function signature.
    case gap(id: String, hiddenCount: Int, heading: String?)

    var id: String {
        switch self {
        case let .line(line): line.id
        case let .fold(fold): fold.id
        case let .gap(id, _, _): id
        }
    }
}

/// A run of unchanged lines collapsed into one row.
struct ReviewDiffFold: Equatable {
    /// Derived from the first hidden line, so it survives re-layout: expanding
    /// one fold leaves every other fold's identity alone.
    let id: String
    /// Indices into the lines the layout was built from.
    let hiddenRange: Range<Int>

    var hiddenCount: Int { hiddenRange.count }
}

/// Turns a file's diff lines into the rows the diff screen renders.
///
/// Runs once per hydration or fold toggle, never while scrolling. Unchanged
/// runs keep `contextLines` next to each change and fold the rest, so a one-line
/// change in a long file opens on the change rather than on line 1: the leading
/// run becomes a single fold row above three lines of context.
///
/// A fold replaces a hunk header one-for-one at the top of the file, which is
/// what keeps the view from jumping when the hydrated file swaps in for the
/// patch.
enum ReviewDiffLayout {
    /// Unchanged lines kept on each side of a change.
    static let contextLines = 3
    /// Fewer hidden lines than this are shown instead: a fold row would take as
    /// much room as the lines it hides.
    static let minimumFoldedLines = 2

    static func rows(
        for lines: [FeatureDiffLine],
        expanded: Set<String> = []
    ) -> [ReviewDiffRow] {
        // A file without a single change (a pure rename) has nothing to fold
        // context around.
        let foldsContext = lines.contains(where: \.isChange)
        var rows: [ReviewDiffRow] = []
        rows.reserveCapacity(lines.count)
        var previousHunkEnd = 0

        func appendLines(_ range: Range<Int>) {
            rows.append(contentsOf: lines[range].map(ReviewDiffRow.line))
        }

        var index = 0
        while index < lines.count {
            let line = lines[index]
            switch line.kind {
            case .hunk:
                if let header = HunkHeader(line.text) {
                    let gap = header.linesBefore - previousHunkEnd
                    if gap > 0 {
                        rows.append(.gap(id: line.id, hiddenCount: gap, heading: header.heading))
                    }
                    previousHunkEnd = header.end
                } else {
                    // A header this can't read is still shown as itself.
                    rows.append(.line(line))
                }
                index += 1
            case .addition, .deletion:
                rows.append(.line(line))
                index += 1
            case .context:
                let start = index
                while index < lines.count, lines[index].kind == .context {
                    index += 1
                }
                let run = start ..< index
                guard foldsContext else {
                    appendLines(run)
                    continue
                }
                let keepsStart = start > 0 && lines[start - 1].isChange ? contextLines : 0
                let keepsEnd = index < lines.count && lines[index].isChange ? contextLines : 0
                guard run.count - keepsStart - keepsEnd >= minimumFoldedLines else {
                    appendLines(run)
                    continue
                }
                let hidden = (start + keepsStart) ..< (index - keepsEnd)
                let fold = ReviewDiffFold(id: "fold-\(lines[hidden.lowerBound].id)", hiddenRange: hidden)
                if expanded.contains(fold.id) {
                    appendLines(run)
                } else {
                    appendLines(start ..< hidden.lowerBound)
                    rows.append(.fold(fold))
                    appendLines(hidden.upperBound ..< index)
                }
            }
        }
        return rows
    }

    /// The first row of every change: a run of additions and deletions with
    /// nothing unchanged between them. Previous/Next Change steps through these.
    static func changeRowIDs(in rows: [ReviewDiffRow]) -> [String] {
        var ids: [String] = []
        var isInsideChange = false
        for row in rows {
            if case let .line(line) = row, line.isChange {
                if !isInsideChange { ids.append(line.id) }
                isInsideChange = true
            } else {
                isInsideChange = false
            }
        }
        return ids
    }

    /// The largest line number any row shows, which sizes the number column.
    static func largestLineNumber(in lines: [FeatureDiffLine]) -> Int {
        lines.reduce(0) { max($0, $1.oldLine ?? 0, $1.newLine ?? 0) }
    }

    /// `@@ -a,b +c,d @@ heading`, read on the old side: unchanged lines are the
    /// same count on both sides, and one side is enough to count them.
    private struct HunkHeader {
        /// Old-side lines that come before the hunk.
        let linesBefore: Int
        /// The last old-side line the hunk covers.
        let end: Int
        let heading: String?

        init?(_ text: String) {
            let parts = text.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
            guard parts.count >= 3, parts[0] == "@@", parts[1].hasPrefix("-") else { return nil }
            let range = parts[1].dropFirst().split(separator: ",", maxSplits: 1)
            guard let start = range.first.flatMap({ Int($0) }) else { return nil }
            let count = range.count > 1 ? Int(range[1]) ?? 1 : 1
            // An empty side (`-3,0`) names the line the hunk follows rather
            // than the first line it covers.
            linesBefore = count > 0 ? start - 1 : start
            end = count > 0 ? start + count - 1 : start
            let trailing = parts.count > 3 ? parts[3].drop(while: { $0 == "@" }) : ""
            let trimmed = trailing.trimmingCharacters(in: .whitespaces)
            heading = trimmed.isEmpty ? nil : trimmed
        }
    }
}

/// Where Previous/Next Change points: the change the reader last stepped to.
///
/// Held as a cursor rather than read off the scroll position, like Xcode's
/// change navigation, so stepping needs no per-frame scroll observation.
struct ReviewChangeCursor: Equatable {
    private(set) var index: Int?
    private(set) var count: Int

    /// Opens on the first change, which is where the layout puts the reader.
    init(count: Int) {
        self.count = count
        index = count > 0 ? 0 : nil
    }

    var canGoPrevious: Bool { (index ?? 0) > 0 }
    var canGoNext: Bool { index.map { $0 < count - 1 } ?? false }

    var label: String {
        guard let index else { return "No Changes" }
        return "Change \(index + 1) of \(count)"
    }

    mutating func goPrevious() {
        guard canGoPrevious, let index else { return }
        self.index = index - 1
    }

    mutating func goNext() {
        guard canGoNext, let index else { return }
        self.index = index + 1
    }

    /// Keeps the position when the diff is re-laid out, clamped to the new
    /// number of changes.
    mutating func update(count: Int) {
        self.count = count
        guard count > 0 else {
            index = nil
            return
        }
        index = min(index ?? 0, count - 1)
    }
}

/// Syntax spans for diff lines, keyed by line id.
///
/// Each side is highlighted as one text, so a block comment that opens on one
/// line still colors the next: context and additions read as the new file,
/// context and deletions as the old one. Runs once per file, off the main
/// thread; rows only look their spans up.
enum ReviewDiffSyntax {
    static func spans(
        for lines: [FeatureDiffLine],
        language: String
    ) -> [String: [FeatureSourceSpan]] {
        var output: [String: [FeatureSourceSpan]] = [:]

        func highlight(_ side: [FeatureDiffLine], keeping kinds: Set<FeatureDiffLineKind>) {
            guard !side.isEmpty else { return }
            let highlighted = FeatureSourceHighlighter.lines(
                text: side.map(\.text).joined(separator: "\n"),
                language: language
            )
            for (line, source) in zip(side, highlighted) where kinds.contains(line.kind) {
                output[line.id] = source.spans
            }
        }

        highlight(lines.filter { $0.kind == .context || $0.kind == .addition }, keeping: [.context, .addition])
        highlight(lines.filter { $0.kind == .context || $0.kind == .deletion }, keeping: [.deletion])
        return output
    }
}

extension FeatureDiffLine {
    var isChange: Bool { kind == .addition || kind == .deletion }
}
