import Foundation

/// Shared patch parsing for working-tree, checkpoint and host PR diffs.
enum NativeUnifiedDiffMapper {
    static func parseDiff(_ source: ReviewDiffSource) -> [FeatureReviewFile] {
        let rawLines = source.diff.split(
            separator: "\n",
            omittingEmptySubsequences: false
        ).map(String.init)
        var files: [FeatureReviewFile] = []
        var currentPath: String?
        var previousPath: String?
        var change = FeatureReviewChangeKind.modified
        var lines: [FeatureDiffLine] = []
        var oldLine: Int?
        var newLine: Int?
        var additions = 0
        var deletions = 0

        func finishFile() {
            guard let currentPath else { return }
            files.append(
                FeatureReviewFile(
                    path: currentPath,
                    previousPath: previousPath,
                    change: change,
                    additions: additions,
                    deletions: deletions,
                    lines: annotateChangedSpans(lines),
                    sourceKind: source.kind,
                    sourceBaseReference: source.baseRef,
                    sourceHeadReference: source.headRef
                )
            )
        }

        for (index, line) in rawLines.enumerated() {
            if line.hasPrefix("diff --git ") {
                finishFile()
                let paths = headerPaths(String(line.dropFirst("diff --git ".count)))
                currentPath = paths?.new ?? source.title
                previousPath = paths?.old
                change = .modified
                lines = []
                oldLine = nil
                newLine = nil
                additions = 0
                deletions = 0
                continue
            }
            if line.hasPrefix("new file mode ") {
                change = .added
                continue
            }
            if line.hasPrefix("deleted file mode ") {
                change = .deleted
                continue
            }
            if line.hasPrefix("rename from ") {
                previousPath = decodePath(String(line.dropFirst("rename from ".count)))
                change = .renamed
                continue
            }
            if line.hasPrefix("rename to ") {
                currentPath = decodePath(String(line.dropFirst("rename to ".count)))
                change = .renamed
                continue
            }
            if line.hasPrefix("Binary files ") || line == "GIT binary patch" {
                change = .binary
                continue
            }
            if oldLine == nil && newLine == nil && line.hasPrefix("+++ ") {
                let path = String(line.dropFirst(4))
                if path != "/dev/null" { currentPath = stripDiffPrefix(path) }
                continue
            }
            if oldLine == nil && newLine == nil && line.hasPrefix("--- ") {
                let path = String(line.dropFirst(4))
                if path != "/dev/null" { previousPath = stripDiffPrefix(path) }
                continue
            }
            if line.hasPrefix("@@") {
                let ranges = line.split(separator: " ")
                oldLine = ranges.count > 1 ? rangeStart(String(ranges[1])) : nil
                newLine = ranges.count > 2 ? rangeStart(String(ranges[2])) : nil
                lines.append(
                    FeatureDiffLine(
                        id: "\(source.id)-\(index)",
                        kind: .hunk,
                        text: line
                    )
                )
                continue
            }

            let kind: FeatureDiffLineKind
            let rendered: String
            let renderedOld: Int?
            let renderedNew: Int?
            if line.hasPrefix("+") {
                kind = .addition
                rendered = String(line.dropFirst())
                renderedOld = nil
                renderedNew = newLine
                newLine = newLine.map { $0 + 1 }
                additions += 1
            } else if line.hasPrefix("-") {
                kind = .deletion
                rendered = String(line.dropFirst())
                renderedOld = oldLine
                renderedNew = nil
                oldLine = oldLine.map { $0 + 1 }
                deletions += 1
            } else if line.hasPrefix(" ") {
                kind = .context
                rendered = String(line.dropFirst())
                renderedOld = oldLine
                renderedNew = newLine
                oldLine = oldLine.map { $0 + 1 }
                newLine = newLine.map { $0 + 1 }
            } else {
                continue
            }
            lines.append(
                FeatureDiffLine(
                    id: "\(source.id)-\(index)",
                    kind: kind,
                    oldLine: renderedOld,
                    newLine: renderedNew,
                    text: rendered
                )
            )
        }
        finishFile()

        if files.isEmpty, !source.diff.isEmpty {
            return [
                FeatureReviewFile(
                    path: source.title,
                    change: .modified,
                    additions: additions,
                    deletions: deletions,
                    lines: annotateChangedSpans(lines),
                    sourceKind: source.kind,
                    sourceBaseReference: source.baseRef,
                    sourceHeadReference: source.headRef
                ),
            ]
        }
        return files
    }

    /// Git presents replacements as adjacent deletion/addition blocks. Pairing those
    /// lines here keeps the view dumb and makes word-level highlighting stable on scroll.
    private static func annotateChangedSpans(
        _ source: [FeatureDiffLine]
    ) -> [FeatureDiffLine] {
        var lines = source
        var index = 0
        while index < lines.count {
            guard lines[index].kind == .deletion || lines[index].kind == .addition else {
                index += 1
                continue
            }
            let start = index
            while index < lines.count,
                  lines[index].kind == .deletion || lines[index].kind == .addition {
                index += 1
            }
            let changedIndices = start ..< index
            let deletions = changedIndices.filter { lines[$0].kind == .deletion }
            let additions = changedIndices.filter { lines[$0].kind == .addition }
            for (deletionIndex, additionIndex) in zip(deletions, additions) {
                let spans = FeatureDiffWordHighlighter.spans(
                    old: lines[deletionIndex].text,
                    new: lines[additionIndex].text
                )
                lines[deletionIndex].spans = spans.old
                lines[additionIndex].spans = spans.new
            }
        }
        return lines
    }

    private static func stripDiffPrefix(_ raw: String) -> String {
        let path = decodePath(raw)
        if path.hasPrefix("a/") || path.hasPrefix("b/") {
            return String(path.dropFirst(2))
        }
        return path
    }


    /// Git quotes tabs, newlines and non-ASCII UTF-8 bytes using C escapes.
    /// Quotes belong to the transport, never the visible filename or host path.
    static func decodePath(_ raw: String) -> String {
        guard raw.first == "\"", raw.last == "\"" else { return raw }
        let bytes = Array(raw.utf8.dropFirst().dropLast())
        var decoded: [UInt8] = []
        var index = 0
        while index < bytes.count {
            let byte = bytes[index]; index += 1
            guard byte == 92, index < bytes.count else { decoded.append(byte); continue }
            let escaped = bytes[index]; index += 1
            if (48...55).contains(escaped) {
                var value = Int(escaped - 48), count = 1
                while count < 3, index < bytes.count, (48...55).contains(bytes[index]) {
                    value = value * 8 + Int(bytes[index] - 48); index += 1; count += 1
                }
                decoded.append(UInt8(truncatingIfNeeded: value))
            } else {
                let escapes: [UInt8: UInt8] = [97: 7, 98: 8, 116: 9, 110: 10, 118: 11, 102: 12, 114: 13]
                decoded.append(escapes[escaped] ?? escaped)
            }
        }
        return String(decoding: decoded, as: UTF8.self)
    }

    private static func headerPaths(_ raw: String) -> (old: String, new: String)? {
        if raw.first == "\"" {
            var escaped = false
            for index in raw.indices.dropFirst() {
                let character = raw[index]
                if escaped { escaped = false; continue }
                if character == "\\" { escaped = true; continue }
                if character == "\"" {
                    let after = raw.index(after: index)
                    let next = raw[after...].drop(while: { $0 == " " })
                    return (stripDiffPrefix(String(raw[...index])), stripDiffPrefix(String(next)))
                }
            }
            return nil
        }
        // Unquoted spaces are legal. For an unchanged path the two sides give
        // an unambiguous split even when the filename itself contains " b/".
        var fallback: (old: String, new: String)?
        for index in raw.indices where raw[index] == " " {
            let next = raw.index(after: index)
            let suffix = raw[next...]
            guard suffix.hasPrefix("b/") || suffix.hasPrefix("\"b/") else { continue }
            let pair = (old: stripDiffPrefix(String(raw[..<index])), new: stripDiffPrefix(String(suffix)))
            if pair.old == pair.new { return pair }
            fallback = pair
        }
        return fallback
    }

    private static func rangeStart(_ range: String) -> Int? {
        Int(
            range
                .drop(while: { $0 == "-" || $0 == "+" })
                .split(separator: ",", maxSplits: 1)
                .first
                ?? ""
        )
    }
}
