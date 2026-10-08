import Foundation
import SwiftUI

/// The skills a transcript can name, by the `$name` an agent writes. A class
/// so a rendered run can remember which catalog it was styled for by identity;
/// a new catalog is built only when the provider's skill list changes.
final class MarkdownSkillCatalog: Sendable {
    private let displayNames: [String: String]

    init(_ skills: [FeatureProviderSkill]) {
        var names: [String: String] = [:]
        // The first skill with a name wins, like the web's `find`.
        for skill in skills where names[skill.name] == nil {
            names[skill.name] = MarkdownSkillChips.displayName(name: skill.name, displayName: skill.displayName)
        }
        displayNames = names
    }

    var isEmpty: Bool { displayNames.isEmpty }

    func displayName(for name: String) -> String? { displayNames[name] }
}

/// Inline skill chips, ported from the web's `SkillInlineText`: a `$name`
/// token naming a known skill reads as that skill's display name in a tinted
/// chip. Copy and Select Text keep working from the message source, so the
/// token survives there as written.
enum MarkdownSkillChips {
    /// `$name` at the start of a text run or after whitespace, ending at
    /// whitespace or the end of the run. Amounts such as `$5`, `$10k` or `$1e6`
    /// are not tokens, and a name needs at least one letter.
    private static let token = try! NSRegularExpression(
        pattern: #"(^|\s)\$(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)"#
    )

    /// `formatProviderSkillDisplayName`: the display name, else the name in
    /// title case split on whitespace, colons, underscores and hyphens.
    static func displayName(name: String, displayName: String?) -> String {
        if let trimmed = displayName?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
            return trimmed
        }
        return name
            .split(whereSeparator: { $0.isWhitespace || $0 == ":" || $0 == "_" || $0 == "-" })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    /// Every `$name` token in `text`: the range of `$name` itself and the name.
    static func tokens(in text: String) -> [(range: Range<String.Index>, name: String)] {
        token.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
            // Group 1 is the leading whitespace (or nothing), so the token
            // starts where it ends.
            guard let prefix = Range(match.range(at: 1), in: text),
                  let name = Range(match.range(at: 2), in: text) else { return nil }
            return (prefix.upperBound..<name.upperBound, String(text[name]))
        }
    }

    /// `text` with known skill tokens replaced by chips, or nil when it names
    /// none. Code spans and links keep their text, like the web.
    @MainActor
    static func apply(to text: AttributedString, catalog: MarkdownSkillCatalog) -> AttributedString? {
        var output = AttributedString()
        var changed = false
        for run in text.runs {
            let slice = text[run.range]
            if run.inlinePresentationIntent?.contains(.code) == true || run.link != nil {
                output.append(slice)
                continue
            }
            let plain = String(slice.characters)
            var cursor = plain.startIndex
            var characterCursor = slice.startIndex
            for found in tokens(in: plain) {
                guard let name = catalog.displayName(for: found.name) else { continue }
                let start = slice.characters.index(characterCursor, offsetBy: plain.distance(from: cursor, to: found.range.lowerBound))
                let end = slice.characters.index(start, offsetBy: plain.distance(from: found.range.lowerBound, to: found.range.upperBound))
                output.append(slice[characterCursor..<start])
                var chip = AttributedString(name, attributes: run.attributes)
                chip.foregroundColor = T3Colors.skillChip
                chip.backgroundColor = T3Colors.skillChip.opacity(0.14)
                output.append(chip)
                cursor = found.range.upperBound
                characterCursor = end
                changed = true
            }
            output.append(slice[characterCursor..<slice.endIndex])
        }
        return changed ? output : nil
    }

    /// Paragraphs anywhere in `blocks` with their skill tokens as chips.
    /// Untouched blocks keep their identity, and a styled run is remembered
    /// on the cached run it came from, so re-rendering a row re-uses it.
    @MainActor
    static func blocks(_ blocks: [MarkdownRenderedBlock], catalog: MarkdownSkillCatalog) -> [MarkdownRenderedBlock] {
        func inline(_ value: MarkdownRenderedInline) -> MarkdownRenderedInline {
            value.skillChips(for: catalog) { apply(to: $0, catalog: catalog) }
        }
        func items(_ values: [MarkdownRenderedListItem]) -> [MarkdownRenderedListItem] {
            values.map { MarkdownRenderedListItem(task: $0.task, blocks: walk($0.blocks)) }
        }
        func walk(_ values: [MarkdownRenderedBlock]) -> [MarkdownRenderedBlock] {
            values.map { block in
                switch block {
                case let .paragraph(value): .paragraph(inline(value))
                case let .unorderedList(values): .unorderedList(items(values))
                case let .orderedList(start, values): .orderedList(start: start, items: items(values))
                case let .blockquote(values): .blockquote(walk(values))
                case let .githubAlert(kind, values): .githubAlert(kind: kind, blocks: walk(values))
                case let .details(details): .details(details.replacingBlocks(walk(details.blocks)))
                case .heading, .table, .image, .codeBlock, .htmlEmbed, .mermaid, .artifactTemplate, .thematicBreak: block
                }
            }
        }
        return walk(blocks)
    }
}
