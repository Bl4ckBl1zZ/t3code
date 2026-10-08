import SwiftUI
import UIKit

/// The web client's table copy formats (`markdown-clipboard.ts`).
enum MarkdownTableExport {
    /// The table as GFM: cells as written, pipes escaped, a separator row that
    /// keeps centre and right alignment.
    static func markdown(_ table: MarkdownTable) -> String {
        let separator = table.header.indices.map { column -> String in
            switch table.alignments.indices.contains(column) ? table.alignments[column] : .natural {
            case .center: ":---:"
            case .trailing: "---:"
            case .natural, .leading: "---"
            }
        }
        return ([markdownRow(table.header), "| \(separator.joined(separator: " | ")) |"]
            + table.rows.map(markdownRow))
            .joined(separator: "\n")
    }

    /// The table as CSV of the cells' visible text: whitespace collapsed, and
    /// a cell holding a quote or comma quoted with its quotes doubled.
    static func csv(header: [String], rows: [[String]]) -> String {
        ([header] + rows)
            .map { $0.map(csvCell).joined(separator: ",") }
            .joined(separator: "\n")
    }

    private static func markdownRow(_ cells: [String]) -> String {
        "| \(cells.map(markdownCell).joined(separator: " | ")) |"
    }

    /// A cell's source already escapes the pipes that split the row; a pipe
    /// inside a code span does not, and needs one to survive a re-parse.
    private static func markdownCell(_ source: String) -> String {
        var output = ""
        var escaped = false
        for character in source.replacingOccurrences(of: #"\n+"#, with: " ", options: .regularExpression) {
            if character == "|", !escaped { output.append("\\") }
            escaped = character == "\\" && !escaped
            output.append(character)
        }
        return output.trimmingCharacters(in: .whitespaces)
    }

    private static func csvCell(_ value: String) -> String {
        let normalized = value
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        guard normalized.contains(where: { $0 == "\"" || $0 == "," || $0 == "\n" }) else { return normalized }
        return "\"\(normalized.replacingOccurrences(of: "\"", with: "\"\""))\""
    }
}

extension MarkdownRenderedTable {
    var markdownExport: String? { source.map(MarkdownTableExport.markdown) }

    var csvExport: String {
        func text(_ cells: [MarkdownRenderedInline]) -> [String] { cells.map { String($0.attributedText.characters) } }
        return MarkdownTableExport.csv(header: text(header), rows: rows.map(text))
    }
}

/// Under a table, like the web: open it full screen, and a menu of copy
/// formats whose icon confirms the copy in place.
struct MarkdownTableActionBar: View {
    let table: MarkdownRenderedTable
    @State private var isExpanded = false
    @State private var copyCount = 0
    @State private var showsCopied = false

    var body: some View {
        HStack(spacing: 0) {
            Button {
                isExpanded = true
            } label: {
                Label("View Full Screen", systemImage: "arrow.up.left.and.arrow.down.right")
                    .labelStyle(.iconOnly)
                    .font(T3Typography.control)
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("View table full screen")
            Spacer(minLength: 8)
            MarkdownTableCopyMenu(table: table, onCopied: confirmCopy) {
                Label(showsCopied ? "Copied" : "Copy Table", systemImage: showsCopied ? "checkmark" : "doc.on.doc")
                    .labelStyle(.iconOnly)
                    .font(T3Typography.control)
                    .foregroundStyle(showsCopied ? T3Colors.success : T3Colors.textSecondary)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(showsCopied ? "Copied" : "Copy table")
            .t3SensoryFeedback(.success, trigger: copyCount)
        }
        // The buttons' tap targets overhang the row; the table above keeps its rhythm.
        .padding(.vertical, -8)
        .sheet(isPresented: $isExpanded) {
            MarkdownTableFullScreen(table: table)
        }
    }

    private func confirmCopy() {
        copyCount += 1
        showsCopied = true
        let count = copyCount
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            if copyCount == count { showsCopied = false }
        }
    }
}

private struct MarkdownTableCopyMenu<MenuLabel: View>: View {
    let table: MarkdownRenderedTable
    let onCopied: () -> Void
    @ViewBuilder let label: () -> MenuLabel

    var body: some View {
        Menu {
            if let markdown = table.markdownExport {
                Button("Copy as Markdown", systemImage: "text.alignleft") { copy(markdown) }
            }
            Button("Copy as CSV", systemImage: "tablecells") { copy(table.csvExport) }
        } label: {
            label()
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    private func copy(_ text: String) {
        UIPasteboard.general.string = text
        onCopied()
    }
}

/// A wide table on its own: both axes scroll, and columns may grow wider
/// than in the transcript so prose cells wrap less.
private struct MarkdownTableFullScreen: View {
    let table: MarkdownRenderedTable
    @State private var copyCount = 0

    var body: some View {
        NavigationStack {
            ScrollView([.horizontal, .vertical]) {
                MarkdownTableGrid(
                    table: table,
                    columnWidths: MarkdownRenderedTable.estimatedColumnWidths(
                        header: table.header,
                        rows: table.rows,
                        maximum: 480
                    )
                )
                .padding(16)
            }
            .background(T3Colors.background)
            .navigationTitle("Table")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(.close)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    MarkdownTableCopyMenu(table: table, onCopied: {
                        copyCount += 1
                        T3HUD.show("Copied", systemImage: "doc.on.doc")
                    }) {
                        Label("Copy Table", systemImage: "doc.on.doc")
                    }
                    .t3SensoryFeedback(.success, trigger: copyCount)
                }
            }
        }
    }
}
