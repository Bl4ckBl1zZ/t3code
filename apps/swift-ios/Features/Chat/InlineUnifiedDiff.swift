import SwiftUI

// Ported from apps/mobile/src/features/threads/InlineUnifiedDiff.tsx. The RN
// client hands the raw patch to a native review-diff surface; here the patch is
// parsed directly and drawn with the same +/− tones.

public struct UnifiedDiffRow: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case hunk
        case addition
        case deletion
        case context
    }

    public let id: Int
    public let kind: Kind
    public let oldLine: Int?
    public let newLine: Int?
    /// The line without its `+`/`-`/space marker. Hunk headers keep their text.
    public let text: String
}

public enum UnifiedDiffParser {
    /// File headers are dropped: an inline patch is shown under a row that
    /// already names the file, so `diff --git`/`index`/`---`/`+++` lines are
    /// noise. Hunk headers stay — they are the only thing separating regions.
    private static let droppedPrefixes = [
        "diff --git ",
        "index ",
        "--- ",
        "+++ ",
        "new file mode ",
        "deleted file mode ",
        "old mode ",
        "new mode ",
        "similarity index ",
        "dissimilarity index ",
        "rename from ",
        "rename to ",
        "copy from ",
        "copy to ",
        "Binary files ",
        "GIT binary patch",
        "\\ No newline at end of file",
    ]

    public static func rows(_ diff: String) -> [UnifiedDiffRow] {
        var rows: [UnifiedDiffRow] = []
        var oldLine: Int?
        var newLine: Int?

        let lines = diff.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        for (index, line) in lines.enumerated() {
            // A trailing newline yields one empty final element that is not a
            // context line; everything else empty is context.
            if line.isEmpty, index == lines.count - 1 { continue }
            if droppedPrefixes.contains(where: { line.hasPrefix($0) }) { continue }

            if line.hasPrefix("@@") {
                let fields = line.split(separator: " ")
                oldLine = fields.count > 1 ? rangeStart(String(fields[1])) : nil
                newLine = fields.count > 2 ? rangeStart(String(fields[2])) : nil
                rows.append(
                    UnifiedDiffRow(
                        id: index, kind: .hunk, oldLine: nil, newLine: nil, text: line
                    )
                )
                continue
            }

            if line.hasPrefix("+") {
                rows.append(
                    UnifiedDiffRow(
                        id: index,
                        kind: .addition,
                        oldLine: nil,
                        newLine: newLine,
                        text: String(line.dropFirst())
                    )
                )
                newLine = newLine.map { $0 + 1 }
            } else if line.hasPrefix("-") {
                rows.append(
                    UnifiedDiffRow(
                        id: index,
                        kind: .deletion,
                        oldLine: oldLine,
                        newLine: nil,
                        text: String(line.dropFirst())
                    )
                )
                oldLine = oldLine.map { $0 + 1 }
            } else {
                rows.append(
                    UnifiedDiffRow(
                        id: index,
                        kind: .context,
                        oldLine: oldLine,
                        newLine: newLine,
                        text: line.hasPrefix(" ") ? String(line.dropFirst()) : line
                    )
                )
                oldLine = oldLine.map { $0 + 1 }
                newLine = newLine.map { $0 + 1 }
            }
        }
        return rows
    }

    /// `@@ -12,7 +12,9 @@` — the leading number of one side's range.
    static func rangeStart(_ range: String) -> Int? {
        let digits = range.drop { !$0.isNumber }.prefix { $0.isNumber }
        return Int(digits)
    }
}

/// Renders a raw unified diff with the timeline's own +/− tones, falling back to
/// the patch text when nothing parses (a truncated or provider-specific patch
/// should still be readable).
struct InlineUnifiedDiff: View {
    let diff: String
    var maxHeight: CGFloat = 360

    private var rows: [UnifiedDiffRow] { UnifiedDiffParser.rows(diff) }

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            if rows.isEmpty {
                Text(verbatim: diff)
                    .font(ChatTimelineStyle.smallMono)
                    .foregroundStyle(T3Colors.textSecondary)
                    .textSelection(.enabled)
                    .padding(10)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(rows) { row in
                        rowView(row)
                    }
                }
                .padding(.vertical, 4)
            }
        }
        .frame(maxHeight: maxHeight)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(T3Colors.subtle)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(T3Colors.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func rowView(_ row: UnifiedDiffRow) -> some View {
        HStack(alignment: .top, spacing: 0) {
            if row.kind == .hunk {
                Text(verbatim: row.text)
                    .foregroundStyle(T3Colors.accent)
                    .padding(.horizontal, 8)
            } else {
                lineNumber(row.oldLine)
                lineNumber(row.newLine)
                Text(verbatim: marker(row.kind))
                    .foregroundStyle(markerColor(row.kind))
                    .frame(width: 14)
                Text(verbatim: row.text.isEmpty ? " " : row.text)
                    .foregroundStyle(T3Colors.textPrimary)
                    .textSelection(.enabled)
                    .padding(.trailing, 10)
            }
        }
        .font(ChatTimelineStyle.smallMono)
        .fixedSize(horizontal: true, vertical: false)
        .frame(minHeight: 17, alignment: .leading)
        .background(background(row.kind))
    }

    private func lineNumber(_ value: Int?) -> some View {
        Text(verbatim: value.map(String.init) ?? "")
            .foregroundStyle(T3Colors.textTertiary)
            .monospacedDigit()
            .frame(width: 34, alignment: .trailing)
            .padding(.trailing, 5)
            .accessibilityHidden(true)
    }

    private func marker(_ kind: UnifiedDiffRow.Kind) -> String {
        switch kind {
        case .addition: "+"
        case .deletion: "−"
        case .context, .hunk: " "
        }
    }

    private func markerColor(_ kind: UnifiedDiffRow.Kind) -> Color {
        switch kind {
        case .addition: T3Colors.success
        case .deletion: T3Colors.danger
        case .context, .hunk: T3Colors.textTertiary
        }
    }

    private func background(_ kind: UnifiedDiffRow.Kind) -> Color {
        switch kind {
        case .addition: T3Colors.success.opacity(0.12)
        case .deletion: T3Colors.danger.opacity(0.12)
        case .context, .hunk: .clear
        }
    }
}
