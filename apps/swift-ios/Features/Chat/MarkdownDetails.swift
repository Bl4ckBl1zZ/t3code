import Foundation
import Observation
import SwiftUI

/// A `<details>` section: a summary line over Markdown that starts collapsed
/// unless the tag carries `open`, like the web client's collapsible.
struct MarkdownDetails: Equatable, Sendable {
    /// Nil when the section had no `<summary>`; it reads as "Details".
    let summary: String?
    let isOpen: Bool
    let content: MarkdownDocument
    /// False while `</details>` has not arrived. A finished message that never
    /// closed its section shows everything instead of hiding it.
    let terminated: Bool
}

/// Recognises the HTML around a `<details>` section. Only the tags matter;
/// everything between them is parsed as Markdown, the way agents write it.
enum MarkdownDetailsSyntax {
    struct Opening: Equatable {
        let isOpen: Bool
        /// What follows the opening tag on its line.
        let remainder: String
    }

    struct Summary: Equatable {
        let text: String
        /// What follows `</summary>` on its line.
        let remainder: String
    }

    private static let openingTag = try! NSRegularExpression(
        pattern: #"^<details(\s[^>]*)?>"#,
        options: [.caseInsensitive]
    )
    private static let summaryTag = try! NSRegularExpression(
        pattern: #"^<summary(?:\s[^>]*)?>(.*?)</summary\s*>"#,
        options: [.caseInsensitive]
    )
    private static let openAttribute = try! NSRegularExpression(
        pattern: #"(?:^|\s)open(?:\s|=|$)"#,
        options: [.caseInsensitive]
    )
    /// Openings and closings in document order, for nesting depth.
    private static let tagToken = try! NSRegularExpression(
        pattern: #"<details(?:\s[^>]*)?>|</details\s*>"#,
        options: [.caseInsensitive]
    )

    /// The opening tag at the start of `line` (up to three spaces of indent).
    static func opening(in line: String) -> Opening? {
        guard line.prefix(while: { $0 == " " }).count <= 3 else { return nil }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let range = NSRange(trimmed.startIndex..., in: trimmed)
        guard let match = openingTag.firstMatch(in: trimmed, range: range),
              let tagRange = Range(match.range, in: trimmed) else { return nil }
        var isOpen = false
        if let attributes = Range(match.range(at: 1), in: trimmed) {
            let text = String(trimmed[attributes])
            isOpen = openAttribute.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
        }
        return Opening(isOpen: isOpen, remainder: String(trimmed[tagRange.upperBound...]))
    }

    /// A `<summary>` that opens and closes on `line`. Inline HTML inside it is
    /// translated to Markdown emphasis where it has an equivalent and dropped
    /// otherwise; an empty summary falls back to "Details", like the web.
    static func summary(in line: String) -> Summary? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let range = NSRange(trimmed.startIndex..., in: trimmed)
        guard let match = summaryTag.firstMatch(in: trimmed, range: range),
              let whole = Range(match.range, in: trimmed),
              let inner = Range(match.range(at: 1), in: trimmed) else { return nil }
        return Summary(
            text: inlineMarkdown(fromHTML: String(trimmed[inner])),
            remainder: String(trimmed[whole.upperBound...])
        )
    }

    /// Each `<details>` (+1) and `</details>` (-1) in `line`, in order.
    static func tags(in line: String) -> [(delta: Int, range: Range<String.Index>)] {
        tagToken.matches(in: line, range: NSRange(line.startIndex..., in: line)).compactMap { match in
            guard let range = Range(match.range, in: line) else { return nil }
            return (line[range].hasPrefix("</") ? -1 : 1, range)
        }
    }

    static func inlineMarkdown(fromHTML html: String) -> String {
        var text = html
        let replacements: [(String, String)] = [
            (#"</?(?:b|strong)(?:\s[^>]*)?>"#, "**"),
            (#"</?(?:i|em)(?:\s[^>]*)?>"#, "*"),
            (#"</?code(?:\s[^>]*)?>"#, "`"),
            (#"<[^>]+>"#, ""),
        ]
        for (pattern, replacement) in replacements {
            text = text.replacingOccurrences(
                of: pattern,
                with: replacement,
                options: [.regularExpression, .caseInsensitive]
            )
        }
        let entities = [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&nbsp;", " "), ("&amp;", "&")]
        for (entity, character) in entities {
            text = text.replacingOccurrences(of: entity, with: character)
        }
        return text.trimmingCharacters(in: .whitespaces)
    }
}

/// A `<details>` section in a message: the summary as a disclosure row between
/// hairlines, the body indented beneath it while open.
struct MarkdownDetailsView: View {
    let details: MarkdownRenderedDetails
    @SwiftUI.Environment(\.markdownIsStreaming) private var isStreaming
    @SwiftUI.Environment(\.markdownTranscriptContext) private var transcript
    @SwiftUI.Environment(\.markdownDetailsScope) private var scope
    @State private var localExpansion: Bool?

    private var expansionKey: String? { scope.map { "\($0)#\(details.ordinal)" } }

    private var isExpanded: Bool {
        if let expansionKey, let stored = transcript?.detailsExpansion.isExpanded(expansionKey) { return stored }
        return localExpansion ?? details.isOpen
    }

    var body: some View {
        if !details.terminated, !isStreaming {
            // Never closed and never will be: show it all rather than fold
            // away content whose end is unknown.
            VStack(alignment: .leading, spacing: 12) {
                MarkdownInlineText(details.summary)
                MarkdownBlocksView(blocks: details.blocks)
            }
        } else {
            VStack(alignment: .leading, spacing: 0) {
                Button(action: toggle) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        MarkdownInlineText(details.summary)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        TimelineDisclosureChevron(isExpanded: isExpanded)
                    }
                    .padding(.vertical, 8)
                    .frame(minHeight: T3Metrics.minimumTapTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
                .accessibilityHint(isExpanded ? "Hides the section" : "Shows the section")

                if isExpanded {
                    MarkdownBlocksView(blocks: details.blocks)
                        .padding(.leading, 14)
                        .padding(.bottom, 12)
                }
            }
            .overlay(alignment: .top) { hairline }
            .overlay(alignment: .bottom) { hairline }
        }
    }

    private var hairline: some View {
        Rectangle()
            .fill(T3Colors.separator)
            .frame(height: 1)
            .accessibilityHidden(true)
    }

    private func toggle() {
        let expanded = !isExpanded
        withAnimation(.snappy) {
            if let expansionKey, let transcript {
                transcript.detailsExpansion.set(expansionKey, expanded: expanded)
            } else {
                localExpansion = expanded
            }
        }
    }
}

/// Where a section's open/closed choice outlives the cell showing it, so
/// scrolling a message away and back, or the message streaming on, does not
/// fold it shut. Nil outside a transcript; the section then remembers on its own.
@MainActor @Observable
final class MarkdownDetailsExpansion {
    private var expanded: [String: Bool] = [:]

    func isExpanded(_ key: String) -> Bool? { expanded[key] }

    func set(_ key: String, expanded value: Bool) {
        if expanded.count > 2_000 { expanded.removeAll() }
        expanded[key] = value
    }
}

/// The message a section belongs to, which with the section's ordinal keys its
/// remembered expansion.
private struct MarkdownDetailsScopeKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    var markdownDetailsScope: String? {
        get { self[MarkdownDetailsScopeKey.self] }
        set { self[MarkdownDetailsScopeKey.self] = newValue }
    }
}
