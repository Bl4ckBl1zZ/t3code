import Foundation

// Ported from apps/web/src/lib/terminalContext.ts, elementContext.ts,
// previewAnnotation.ts and messageReply.ts, plus the user-row assembly in
// apps/web/src/components/chat/MessagesTimeline.tsx (`UserTimelineRow`).
//
// Desktop appends machine context to the prompt it sends — terminal output,
// picked page elements, annotated preview crops — and Hermes wraps replies in a
// `[Replying to: "…"]` envelope. The transcript shows the human text and turns
// each block into a chip; the agent still received the full prompt. The regexes
// match web's verbatim so both clients split the same message the same way.

/// A user message split into what the person typed and the context riding on it.
struct UserMessageContent: Equatable, Sendable {
    /// One `- header:` entry of a `<terminal_context>` or `<element_context>`
    /// block, its body lines de-indented.
    struct ContextEntry: Equatable, Sendable, Identifiable {
        let header: String
        let body: String
        var id: String { "\(header)\n\(body)" }
    }

    struct PreviewAnnotation: Equatable, Sendable, Identifiable {
        let id: String
        let title: String
        let comment: String
        let targetSummary: String
        let styleChanges: [String]
        let hasScreenshot: Bool
    }

    struct Reply: Equatable, Sendable {
        let referencedText: String
    }

    /// The text the person typed: what the bubble renders, copies and shares.
    let body: String
    let terminalContexts: [ContextEntry]
    let elementContexts: [ContextEntry]
    /// In the order they were appended, matching the `preview-annotation-*`
    /// image attachments one to one.
    let previewAnnotations: [PreviewAnnotation]
    let reply: Reply?
    /// Long enough to collapse behind "Show full message".
    let isLong: Bool

    var hasContext: Bool {
        !terminalContexts.isEmpty || !elementContexts.isEmpty || !previewAnnotations.isEmpty || reply != nil
    }

    // MARK: - Parsing

    /// `deriveDisplayedUserMessageState`, then the trailing annotations, the
    /// annotations' own element blocks, and the reply envelope, in web's order.
    static func parse(_ text: String) -> UserMessageContent {
        // Send time appends `<terminal_context>` first and `<element_context>`
        // last, so the element block is stripped before the terminal one.
        let element = extractTrailing(text, pattern: trailingElementPattern)
        let terminal = extractTrailing(element.prompt, pattern: trailingTerminalPattern)

        var annotations: [PreviewAnnotation] = []
        var visible = terminal.prompt
        while let extracted = extractTrailingPreviewAnnotation(visible) {
            annotations.insert(extracted.annotation, at: 0)
            visible = extracted.prompt
        }

        let trailingElements = extractTrailing(visible, pattern: trailingElementPattern)
        let reply = extractLeadingReply(trailingElements.prompt)
        let body = reply?.messageText ?? trailingElements.prompt
        return UserMessageContent(
            body: body,
            terminalContexts: parseEntries(terminal.block),
            elementContexts: parseEntries(element.block) + parseEntries(trailingElements.block),
            previewAnnotations: annotations,
            reply: reply.map { Reply(referencedText: $0.referencedText) },
            isLong: shouldCollapse(body)
        )
    }

    /// Parsed once per text: rows re-render on scroll, and the regexes run over
    /// prompts that can carry kilobytes of terminal output.
    static func cached(_ text: String) -> UserMessageContent {
        let key = text as NSString
        if let hit = cache.object(forKey: key) { return hit.value }
        let parsed = parse(text)
        cache.setObject(Box(parsed), forKey: key)
        return parsed
    }

    // MARK: - Thread list preview

    /// The one line a thread row shows for a user message: the typed text
    /// without its context blocks. The shell truncates the message server side
    /// (512 characters), which can cut a block before its closing tag, so an
    /// opening tag on its own line ends the preview as well. A message that is
    /// all context names its first chip instead of going blank.
    static func previewText(_ text: String) -> String {
        let content = parse(text)
        var body = content.body
        if let range = body.range(of: #"\n?<(terminal_context|element_context|preview_annotation)>(\n|$)"#, options: .regularExpression) {
            body = trimmingTrailingNewlines(String(body[..<range.lowerBound]))
        }
        if !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return body }
        if let terminal = content.terminalContexts.first { return terminal.header }
        if let element = content.elementContexts.first { return element.header }
        if let annotation = content.previewAnnotations.first {
            return annotation.comment.isEmpty ? annotation.title : annotation.comment
        }
        return body
    }

    // MARK: - Attachments

    /// The crop desktop attaches with a preview annotation. It renders inside
    /// the annotation card, never a second time as an ordinary attachment.
    static func isPreviewAnnotationImage(_ attachment: FeatureMessageAttachment) -> Bool {
        attachment.mimeType.hasPrefix("image/") && attachment.name.hasPrefix("preview-annotation-")
    }

    // MARK: - Terminal headers

    /// `Terminal 1 lines 3-5` as a terminal name and a range label, or nil for a
    /// header that does not carry a line range.
    static func terminalHeaderParts(_ header: String) -> (name: String, range: String)? {
        let trimmed = header.trimmingCharacters(in: .whitespaces)
        let source = trimmed as NSString
        guard let match = terminalHeaderPattern.firstMatch(in: trimmed, range: NSRange(location: 0, length: source.length)),
              match.range(at: 2).location != NSNotFound else { return nil }
        let name = source.substring(with: match.range(at: 1)).trimmingCharacters(in: .whitespaces)
        let start = source.substring(with: match.range(at: 2))
        let end = match.range(at: 3).location == NSNotFound ? nil : source.substring(with: match.range(at: 3))
        let range = end.map { "lines \(start)–\($0)" } ?? "line \(start)"
        return (name.isEmpty ? "Terminal" : name, range)
    }

    // MARK: - Collapsing

    static let collapsedLineLimit = 8
    static let collapsedLengthLimit = 600

    /// `shouldCollapseUserMessage`: long by rendered length or by line count.
    /// Quote chips and links count by their label, as they render.
    static func shouldCollapse(_ text: String) -> Bool {
        let visible = visibleText(text)
        guard !visible.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return visible.utf16.count > collapsedLengthLimit
            || visible.components(separatedBy: "\n").count > collapsedLineLimit
    }

    private static func visibleText(_ text: String) -> String {
        let source = text as NSString
        var visible = ""
        var cursor = 0
        for match in AssistantCitation.matches(in: text) {
            visible += linkLabels(source.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))
            let preview = (match.citation.comment?.trimmingCharacters(in: .whitespacesAndNewlines))
                .flatMap { $0.isEmpty ? nil : $0 } ?? match.citation.text
            let label = preview.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            visible += label.utf16.count > 64 ? String(label.prefix(64)) + "…" : label
            cursor = NSMaxRange(match.range)
        }
        return visible + linkLabels(source.substring(from: cursor))
    }

    private static func linkLabels(_ segment: String) -> String {
        let range = NSRange(location: 0, length: (segment as NSString).length)
        return markdownLink.stringByReplacingMatches(in: segment, range: range, withTemplate: "$1")
    }

    // MARK: - Block extraction

    private static let trailingTerminalPattern = regex(#"\n*<terminal_context>\n([\s\S]*?)\n</terminal_context>\s*$"#)
    private static let trailingElementPattern = regex(#"\n*<element_context>\n([\s\S]*?)\n</element_context>\s*$"#)
    private static let trailingAnnotationPattern = regex(
        #"\n*<preview_annotation>\n((?:(?!<preview_annotation>)[\s\S])*)\n</preview_annotation>\s*$"#
    )
    private static let replyPattern = regex(
        #"^\s*\[Replying to(?: your previous message)?:\s*"([\s\S]*?)"\][ \t]*(?:\r?\n)+([\s\S]+)$"#
    )
    private static let entryHeaderPattern = regex(#"^- (.+):$"#)
    private static let terminalHeaderPattern = regex(#"^(.*?)\s+lines?\s+(\d+)(?:-(\d+))?$"#, options: [.caseInsensitive])
    private static let markdownLink = regex(#"!?\[([^\]\n]*)\]\((?:<[^>\n]*>|[^\s)]*)\)"#)

    private static func regex(_ pattern: String, options: NSRegularExpression.Options = []) -> NSRegularExpression {
        // Patterns are literals; a typo is a programming error caught by tests.
        try! NSRegularExpression(pattern: pattern, options: options)
    }

    /// The prompt before a trailing block, with the newlines that separated
    /// them dropped, and the block's inner text. No match leaves the prompt
    /// untouched, so an unclosed or mid-text block renders as typed.
    private static func extractTrailing(_ prompt: String, pattern: NSRegularExpression) -> (prompt: String, block: String) {
        let source = prompt as NSString
        guard let match = pattern.firstMatch(in: prompt, range: NSRange(location: 0, length: source.length)) else {
            return (prompt, "")
        }
        let before = source.substring(to: match.range.location)
        return (trimmingTrailingNewlines(before), source.substring(with: match.range(at: 1)))
    }

    private static func extractTrailingPreviewAnnotation(_ prompt: String) -> (prompt: String, annotation: PreviewAnnotation)? {
        let source = prompt as NSString
        guard let match = trailingAnnotationPattern.firstMatch(in: prompt, range: NSRange(location: 0, length: source.length)) else {
            return nil
        }
        let body = source.substring(with: match.range(at: 1))
        let lines = body.components(separatedBy: "\n")
        func value(_ prefix: String) -> String? {
            lines.first { $0.hasPrefix(prefix) }.map { String($0.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines) }
        }
        var styleChanges: [String] = []
        if let headingIndex = lines.firstIndex(of: "Requested visual changes:") {
            let after = lines[(headingIndex + 1)...]
            let end = after.firstIndex(of: "<element_context>") ?? after.endIndex
            styleChanges = after[..<end].filter { $0.hasPrefix("- ") }.map { String($0.dropFirst(2)) }
        }
        let annotation = PreviewAnnotation(
            id: value("Id: ").flatMap { $0.isEmpty ? nil : $0 } ?? "\(match.range.location)",
            title: value("Page: ").flatMap { $0.isEmpty ? nil : $0 } ?? "Preview annotation",
            comment: value("Comment: ") ?? "",
            targetSummary: value("Targets: ") ?? "",
            styleChanges: styleChanges,
            hasScreenshot: body.contains("The attached screenshot is the annotated preview crop.")
        )
        return (trimmingTrailingNewlines(source.substring(to: match.range.location)), annotation)
    }

    /// Hermes reply envelopes. Strict on purpose, like web: a message that only
    /// mentions "Replying to" is not reformatted.
    private static func extractLeadingReply(_ text: String) -> (referencedText: String, messageText: String)? {
        let leading = text.drop { $0.isWhitespace || $0.isNewline }
        guard leading.hasPrefix("[Replying to:") || leading.hasPrefix("[Replying to your previous message:") else {
            return nil
        }
        let source = text as NSString
        guard let match = replyPattern.firstMatch(in: text, range: NSRange(location: 0, length: source.length)) else {
            return nil
        }
        let referenced = source.substring(with: match.range(at: 1)).trimmingCharacters(in: .whitespacesAndNewlines)
        let message = source.substring(with: match.range(at: 2)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !referenced.isEmpty, !message.isEmpty else { return nil }
        return (referenced, message)
    }

    /// `- header:` lines open an entry; two-space-indented lines are its body;
    /// blank lines are kept; anything else is ignored.
    private static func parseEntries(_ block: String) -> [ContextEntry] {
        guard !block.isEmpty else { return [] }
        var entries: [ContextEntry] = []
        var current: (header: String, lines: [String])?
        func commit() {
            guard let open = current else { return }
            let body = open.lines.joined(separator: "\n")
            entries.append(ContextEntry(header: open.header, body: String(body.reversed().drop { $0.isWhitespace || $0.isNewline }.reversed())))
            current = nil
        }
        for line in block.components(separatedBy: "\n") {
            let source = line as NSString
            if let match = entryHeaderPattern.firstMatch(in: line, range: NSRange(location: 0, length: source.length)) {
                commit()
                current = (source.substring(with: match.range(at: 1)), [])
                continue
            }
            guard current != nil else { continue }
            if line.hasPrefix("  ") {
                current?.lines.append(String(line.dropFirst(2)))
            } else if line.isEmpty {
                current?.lines.append("")
            }
        }
        commit()
        return entries
    }

    private static func trimmingTrailingNewlines(_ text: String) -> String {
        var result = Substring(text)
        while result.last == "\n" { result = result.dropLast() }
        return String(result)
    }

    private final class Box {
        let value: UserMessageContent
        init(_ value: UserMessageContent) { self.value = value }
    }

    private static let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.countLimit = 512
        return cache
    }()
}
