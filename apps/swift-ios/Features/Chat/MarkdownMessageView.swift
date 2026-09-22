import SwiftUI
import UIKit

/// Native chat Markdown with block-aware layout and Foundation inline parsing.
struct MarkdownMessageView: View {
    private struct RenderRequest: Hashable {
        let revision: MarkdownContentRevision
        let isStreaming: Bool
    }

    private let source: String
    private let citationMessageID: String?
    /// Titles the long-press menu, like Messages; nil where the text has no
    /// single moment (a pull request body, a file).
    private let timestamp: Date?
    @State private var isCiting = false
    @SwiftUI.Environment(\.assistantCitationContext) private var citationContext
    @SwiftUI.Environment(\.assistantCitationHighlight) private var citationHighlight
    private let revision: MarkdownContentRevision
    private let isStreaming: Bool
    @State private var renderedDocument: MarkdownRenderedDocument?
    @State private var streamingRenderer = StreamingMarkdownRenderer()
    @State private var isSelectingText = false
    @State private var previewTarget: PullRequestLinkTarget?
    @SwiftUI.Environment(\.markdownPullRequestContext) private var pullRequestContext
    @SwiftUI.Environment(\.openURL) private var openURL

    init(_ source: String, isStreaming: Bool = false, citationMessageID: String? = nil, timestamp: Date? = nil) {
        self.source = source
        self.citationMessageID = citationMessageID
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        let revision = MarkdownContentRevision(source)
        self.revision = revision
        let initialDocument = if isStreaming {
            MarkdownRenderCache.shared.cachedDocument(for: revision)
        } else {
            MarkdownRenderCache.shared.documentImmediately(for: revision)
        }
        _renderedDocument = State(
            initialValue: initialDocument
        )
    }

    var body: some View {
        Group {
            if let displayDocument {
                MarkdownBlocksView(blocks: highlightedBlocks(displayDocument))
                    .environment(\.markdownGallery, MarkdownGallery.images(in: displayDocument.blocks))
                    // An unterminated embed means something different mid-turn
                    // than it does once the turn is over: still coming, or never
                    // coming. Only the message knows which.
                    .environment(\.markdownIsStreaming, isStreaming)
            } else {
                // Parsing waits briefly so token-by-token streaming cancels stale revisions
                // instead of scheduling work for content the user will never see.
                highlightedSourceText
                    .font(T3Typography.threadBody)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        // A pull request link previews in place; every other link goes where
        // the surrounding transcript sends it.
        .environment(\.openURL, OpenURLAction { url in
            if pullRequestContext != nil, let target = PullRequestLinkTarget(url) {
                previewTarget = target
                return .handled
            }
            openURL(url)
            return .handled
        })
        .contextMenu {
            Section {
                Button("Copy", systemImage: "doc.on.doc", action: copySource)
                Button("Select Text…", systemImage: "text.cursor") { isSelectingText = true }
                ShareLink(item: source) {
                    Label("Share…", systemImage: "square.and.arrow.up")
                }
                if citationMessageID != nil, citationContext != nil, !isStreaming {
                    Button("Cite Text", systemImage: "quote.bubble") { isCiting = true }
                }
            } header: {
                if let timestamp { Text(verbatim: Self.menuTitle(timestamp)) }
            }
            if pullRequestContext != nil {
                Section {
                    ForEach(PullRequestLinkTarget.links(in: source)) { target in
                        Button {
                            previewTarget = target
                        } label: {
                            Label("Preview Pull Request \(target.displayNumber)", symbol: T3Symbol.pullRequest)
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $isSelectingText) {
            MarkdownSelectTextSheet(text: source)
        }
        .sheet(isPresented: $isCiting) {
            if let citationContext, let citationMessageID {
                AssistantCitationSelectionSheet(text: displayDocument?.citationText ?? source, messageId: citationMessageID, context: citationContext)
            }
        }
        .sheet(item: $previewTarget) { target in
            if let pullRequestContext { PullRequestLinkPreview(target: target, context: pullRequestContext) }
        }
        .accessibilityAction(named: "Copy message", copySource)
        .task(id: RenderRequest(revision: revision, isStreaming: isStreaming)) {
            if !isStreaming {
                streamingRenderer.cancel()
                // Streaming -> complete usually keeps the final text; promote
                // the last streamed render instead of reparsing synchronously.
                if let renderedDocument, renderedDocument.revision == revision {
                    MarkdownRenderCache.shared.promote(renderedDocument)
                    return
                }
                renderedDocument = MarkdownRenderCache.shared.documentImmediately(for: revision)
                return
            }

            if let cached = MarkdownRenderCache.shared.cachedDocument(for: revision) {
                renderedDocument = cached
                return
            }

            // Hand the revision to a renderer that outlives this task. The
            // task modifier cancels on every revision, so rendering inside it
            // starves as soon as parsing is slower than the publish cadence;
            // the renderer instead keeps one render running and always picks
            // up the newest revision when it finishes (latest wins).
            streamingRenderer.submit(revision) { renderedDocument = $0 }
        }
        .onDisappear {
            streamingRenderer.cancel()
        }
    }

    private func copySource() {
        UIPasteboard.general.string = source
        T3HUD.show("Copied", systemImage: "doc.on.doc")
    }

    /// "Today at 9:41 AM", "Yesterday at 9:41 AM", or the date.
    private static func menuTitle(_ date: Date) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today at \(time)" }
        if calendar.isDateInYesterday(date) { return "Yesterday at \(time)" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private var highlightedSourceText: Text {
        guard let citation = citationHighlight?.citation, citation.messageId == citationMessageID,
              let range = AssistantCitationTextRange.resolve(in: source, quote: citation.text,
                  start: citation.start, end: citation.end, prefix: citation.prefix, suffix: citation.suffix) else { return Text(verbatim: source) }
        return Text(MarkdownCitationHighlight.mark(AttributedString(source), range: range))
    }

    private func highlightedBlocks(_ document: MarkdownRenderedDocument) -> [MarkdownRenderedBlock] {
        guard let citation = citationHighlight?.citation, citation.messageId == citationMessageID,
              let range = AssistantCitationTextRange.resolve(in: document.citationText, quote: citation.text,
                  start: citation.start, end: citation.end, prefix: citation.prefix, suffix: citation.suffix) else { return document.blocks }
        return MarkdownCitationHighlight.blocks(document.blocks, range: range)
    }

    private var displayDocument: MarkdownRenderedDocument? {
        if let renderedDocument, renderedDocument.revision == revision {
            return renderedDocument
        }
        // While streaming, a slightly stale document is better than flashing
        // back to plain text between renders. Streamed content only appends,
        // so require the stale document to be a prefix of the current source:
        // that accepts earlier snapshots of this message and rejects leftovers
        // from a recycled cell showing a different message.
        if isStreaming {
            if let renderedDocument,
               renderedDocument.revision.utf8Count <= revision.utf8Count,
               source.utf8.starts(with: renderedDocument.revision.source.utf8) {
                return renderedDocument
            }
            return nil
        }
        return MarkdownRenderCache.shared.documentImmediately(for: revision)
    }
}

/// Renders streaming revisions outside SwiftUI's task lifecycle so a render
/// in progress is never cancelled by the next revision arriving. One render
/// runs at a time; newer revisions replace the pending slot (latest wins) and
/// a 150ms throttle bounds the render cadence.
@MainActor
private final class StreamingMarkdownRenderer {
    private let throttle: Duration = .milliseconds(150)
    private var pending: MarkdownContentRevision?
    private var deliver: ((MarkdownRenderedDocument) -> Void)?
    private var renderTask: Task<Void, Never>?
    private var generation = 0
    private var lastRenderAt: Date?

    func submit(
        _ revision: MarkdownContentRevision,
        deliver: @escaping (MarkdownRenderedDocument) -> Void
    ) {
        pending = revision
        self.deliver = deliver
        guard renderTask == nil else { return }
        generation += 1
        let generation = generation
        renderTask = Task { [weak self] in
            await self?.drain(generation: generation)
        }
    }

    func cancel() {
        generation += 1
        renderTask?.cancel()
        renderTask = nil
        pending = nil
        deliver = nil
    }

    private func drain(generation: Int) async {
        // A cancelled drain can unwind after a replacement was already
        // started; only the current generation may clear the shared slot or
        // deliver, so two drains can never race or regress the document.
        defer {
            if self.generation == generation { renderTask = nil }
        }
        while self.generation == generation, let revision = pending {
            pending = nil
            if let lastRenderAt {
                let elapsed = Duration.seconds(-lastRenderAt.timeIntervalSinceNow)
                if elapsed < throttle {
                    try? await Task.sleep(for: throttle - elapsed)
                }
            }
            guard !Task.isCancelled else { return }
            // Render the newest revision available after the throttle wait.
            let target = pending ?? revision
            pending = nil
            guard let document = await MarkdownRenderCache.shared.document(
                for: target,
                isIntermediate: true
            ) else { continue }
            guard !Task.isCancelled, self.generation == generation else { return }
            lastRenderAt = .now
            deliver?(document)
        }
    }
}

/// "Select Text…" from the long-press menu: the message as plain, selectable
/// text. A sheet rather than a mode, because a selection mode on the row
/// competes with the long-press that opened it.
private struct MarkdownSelectTextSheet: View {
    let text: String

    var body: some View {
        NavigationStack {
            MarkdownSelectableTextView(text: text)
                .background(T3Colors.background)
                .navigationTitle("Select Text")
                .navigationBarTitleDisplayMode(.inline)
                .t3NavigationChrome()
                .t3SheetToolbar(.close)
        }
        .presentationDetents([.medium, .large])
    }
}

/// UIKit text view, because SwiftUI's `textSelection` only offers the whole
/// text on iOS; this allows a range.
private struct MarkdownSelectableTextView: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.adjustsFontForContentSizeCategory = true
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.textColor = T3Colors.uiTextPrimary
        view.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 24, right: 12)
        view.alwaysBounceVertical = true
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
    }
}

private struct MarkdownBlocksView: View {
    let blocks: [MarkdownRenderedBlock]
    var spacing: CGFloat = 12

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(blocks.indices, id: \.self) { index in
                // Unchanged blocks share inline runs by reference across
                // streaming revisions, so equatable comparison skips their
                // body and layout entirely; only the changed tail re-renders.
                MarkdownBlockView(block: blocks[index])
                    .equatable()
            }
        }
    }
}

private struct MarkdownBlockView: View, Equatable {
    let block: MarkdownRenderedBlock

    @ViewBuilder
    var body: some View {
        switch block {
        case let .paragraph(inline):
            MarkdownInlineText(inline)
                .lineSpacing(4)

        case let .heading(level, inline):
            MarkdownInlineText(inline)
                .padding(.top, level <= 2 ? 3 : 1)

        case let .unorderedList(items):
            MarkdownListView(items: items, start: nil)

        case let .orderedList(start, items):
            MarkdownListView(items: items, start: start)

        case let .blockquote(blocks):
            MarkdownBlocksView(blocks: blocks, spacing: 9)
                .foregroundStyle(T3Colors.textSecondary)
                .padding(.leading, 14)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(T3Colors.textTertiary)
                        .frame(width: 2)
                }

        case let .githubAlert(kind, blocks):
            MarkdownGithubAlertView(kind: kind, blocks: blocks)

        case let .table(table):
            MarkdownTableView(table: table)

        case let .image(image):
            MarkdownMediaView(image: image)

        case let .codeBlock(language, code, citationRange):
            MarkdownCodeBlockView(language: language, code: code, citationRange: citationRange)

        case let .htmlEmbed(html, terminated):
            HtmlEmbedView(html: html, terminated: terminated)

        case let .artifactTemplate(template):
            NativeArtifactTemplateCard(template: template)

        case .thematicBreak:
            Rectangle()
                .fill(T3Colors.separator)
                .frame(height: 1)
                .padding(.vertical, 2)
                .accessibilityHidden(true)
        }
    }
}

/// GitHub-style alert callout. The structure stays fixed across kinds — only
/// colours and text vary — so transcript cell gestures never see a branch swap.
private struct MarkdownGithubAlertView: View {
    let kind: MarkdownAlertKind
    let blocks: [MarkdownRenderedBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: symbolName)
                    .font(.footnote.weight(.semibold))
                Text(label)
                    .font(T3Typography.supportingStrong)
            }
            .foregroundStyle(tint)
            MarkdownBlocksView(blocks: blocks, spacing: 9)
                .foregroundStyle(T3Colors.textPrimary)
        }
        .padding(.leading, 14)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(tint)
                .frame(width: 2)
        }
    }

    private var tint: Color {
        switch kind {
        case .note: T3Colors.accent
        case .tip: T3Colors.success
        case .important: T3Colors.statusInput
        case .warning: T3Colors.warning
        case .caution: T3Colors.danger
        }
    }

    private var symbolName: String {
        switch kind {
        case .note: "info.circle"
        case .tip: "lightbulb"
        case .important: "exclamationmark.circle"
        case .warning: "exclamationmark.triangle"
        case .caution: "octagon.fill"
        }
    }

    private var label: String {
        switch kind {
        case .note: "Note"
        case .tip: "Tip"
        case .important: "Important"
        case .warning: "Warning"
        case .caution: "Caution"
        }
    }
}

private struct MarkdownTableView: View {
    let table: MarkdownRenderedTable

    /// The estimates are in points at the default text size; this keeps a
    /// column fitting its text as Dynamic Type grows.
    @ScaledMetric(relativeTo: .body) private var widthScale: CGFloat = 1

    private var columnWidths: [CGFloat] { table.columnWidths.map { $0 * widthScale } }

    var body: some View {
        ScrollView(.horizontal) {
            Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                tableRow(table.header, isHeader: true)
                ForEach(table.rows.indices, id: \.self) { rowIndex in
                    tableRow(table.rows[rowIndex], isHeader: false)
                }
            }
            // A horizontal ScrollView still proposes the viewport width to its child.
            // Preserve the grid's measured column widths so it overflows and scrolls
            // instead of compressing prose columns into unreadable slivers.
            .fixedSize(horizontal: true, vertical: true)
            .background(T3Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(T3Colors.border, lineWidth: 1)
            }
        }
        .scrollIndicators(.visible)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Table with \(table.header.count) columns and \(table.rows.count) rows")
    }

    private func tableRow(
        _ cells: [MarkdownRenderedInline],
        isHeader: Bool
    ) -> some View {
        GridRow(alignment: .top) {
            ForEach(cells.indices, id: \.self) { columnIndex in
                MarkdownInlineText(cells[columnIndex])
                    .lineSpacing(3)
                    .frame(
                        width: columnWidths[columnIndex],
                        alignment: alignment(for: columnIndex)
                    )
                    .frame(
                        minHeight: 44,
                        maxHeight: .infinity,
                        alignment: alignment(for: columnIndex)
                    )
                    .padding(.horizontal, 11)
                    .padding(.vertical, 8)
                    .overlay(alignment: .trailing) {
                        if columnIndex < cells.count - 1 {
                            Rectangle()
                                .fill(T3Colors.separator)
                                .frame(width: 1)
                        }
                    }
                    .accessibilityElement(children: .combine)
            }
        }
        .background(isHeader ? T3Colors.surfaceRaised : T3Colors.surface)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(T3Colors.separator)
                .frame(height: 1)
        }
    }

    private func alignment(for columnIndex: Int) -> Alignment {
        guard table.alignments.indices.contains(columnIndex) else { return .leading }
        return switch table.alignments[columnIndex] {
        case .natural, .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

}

private struct MarkdownListView: View {
    let items: [MarkdownRenderedListItem]
    let start: Int?

    @ScaledMetric(relativeTo: .body) private var markerSize: CGFloat = 24

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(items.indices, id: \.self) { offset in
                let item = items[offset]
                HStack(alignment: .top, spacing: 8) {
                    marker(for: item, offset: offset)
                        .frame(minWidth: markerSize, minHeight: markerSize, alignment: .trailing)
                    MarkdownBlocksView(blocks: item.blocks, spacing: 7)
                }
                .accessibilityElement(children: .contain)
            }
        }
    }

    @ViewBuilder
    private func marker(for item: MarkdownRenderedListItem, offset: Int) -> some View {
        if let task = item.task {
            Image(systemName: task == .complete ? "checkmark.square.fill" : "square")
                .font(T3Typography.control)
                .foregroundStyle(
                    task == .complete ? T3Colors.success : T3Colors.textSecondary
                )
                .accessibilityLabel(task == .complete ? "Completed" : "Not completed")
        } else if let start {
            Text("\(start + offset).")
                .font(T3Typography.supporting.monospaced())
                .foregroundStyle(T3Colors.textSecondary)
                .accessibilityLabel("Item \(start + offset)")
        } else {
            Text("•")
                .font(T3Typography.threadBody.weight(.semibold))
                .foregroundStyle(T3Colors.textSecondary)
                .accessibilityHidden(true)
        }
    }
}

private struct MarkdownCodeBlockView: View {
    let language: String?
    let code: String
    let citationRange: NSRange?
    private var codeText: Text {
        if let citationRange { return Text(MarkdownCitationHighlight.mark(AttributedString(code), range: citationRange)) }
        // Coloured on the render task; plain until then, never on this thread.
        if let highlighted = MarkdownRenderCache.shared.codeHighlight(language: language, code: code) {
            return Text(highlighted)
        }
        return Text(verbatim: code)
    }
    @State private var wrapOverride: Bool?
    @State private var copyCount = 0
    @State private var showsCopied = false

    private var wrapsLines: Bool {
        wrapOverride ?? MarkdownCodeBlockWrapping.wrapsByDefault(language: language)
    }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Text(verbatim: (language?.isEmpty == false ? language! : "code").lowercased())
                    .font(T3Typography.supporting.monospaced())
                    .foregroundStyle(T3Colors.textTertiary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Button {
                    wrapOverride = !wrapsLines
                } label: {
                    Label("Wrap Lines", systemImage: "arrow.turn.down.left")
                        .labelStyle(.iconOnly)
                        .font(T3Typography.control)
                        .foregroundStyle(wrapsLines ? T3Colors.accent : T3Colors.textSecondary)
                        .frame(width: 30, height: 30)
                        .background {
                            if wrapsLines { Circle().fill(T3Colors.accent.opacity(0.14)) }
                        }
                        .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Wrap lines")
                .accessibilityValue(wrapsLines ? "On" : "Off")
                Button(action: copy) {
                    Label(showsCopied ? "Copied" : "Copy", systemImage: showsCopied ? "checkmark" : "doc.on.doc")
                        .labelStyle(.iconOnly)
                        .font(T3Typography.control)
                        .foregroundStyle(showsCopied ? T3Colors.success : T3Colors.textSecondary)
                        .contentTransition(.symbolEffect(.replace))
                        .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(showsCopied ? "Copied" : "Copy code")
                .t3SensoryFeedback(.success, trigger: copyCount)
            }
            .padding(.leading, 13)
            .padding(.trailing, 2)
            .frame(minHeight: 36)

            if wrapsLines {
                codeText
                    .font(T3Typography.code)
                    .foregroundStyle(T3Colors.textPrimary.opacity(0.94))
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 13)
                    .padding(.top, 2)
                    .padding(.bottom, 12)
            } else {
                ScrollView(.horizontal) {
                    codeText
                        .font(T3Typography.code)
                        .foregroundStyle(T3Colors.textPrimary.opacity(0.94))
                        .lineSpacing(3)
                        .fixedSize(horizontal: true, vertical: true)
                        .padding(.horizontal, 13)
                        .padding(.top, 2)
                        .padding(.bottom, 12)
                }
                .scrollIndicators(.hidden)
            }
        }
        .background(T3Colors.surfaceRaised, in: shape)
        .clipShape(shape)
    }

    /// The icon turns into a checkmark for a moment; no alert and no HUD,
    /// because the button itself is where the reader is looking.
    private func copy() {
        UIPasteboard.general.string = code
        copyCount += 1
        showsCopied = true
        let count = copyCount
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            if copyCount == count { showsCopied = false }
        }
    }
}

enum MarkdownCodeBlockWrapping {
    private static let proseLanguages: Set<String> = [
        "markdown",
        "md",
        "plain",
        "plaintext",
        "text",
        "text/plain",
        "txt",
    ]

    static func wrapsByDefault(language: String?) -> Bool {
        guard let language else { return false }
        return proseLanguages.contains(language.lowercased())
    }
}

private struct MarkdownInlineText: View {
    private let attributedText: AttributedString
    private let font: Font

    init(_ rendered: MarkdownRenderedInline) {
        attributedText = rendered.attributedText
        font = rendered.style.font
    }

    var body: some View {
        Text(attributedText)
            .font(font)
            .fixedSize(horizontal: false, vertical: true)
    }
}

enum MarkdownInlineFormatter {
    static func format(_ source: String, baseFont: Font = .body) -> AttributedString {
        var attributed = (
            try? AttributedString(
                markdown: source,
                options: AttributedString.MarkdownParsingOptions(
                    interpretedSyntax: .inlineOnlyPreservingWhitespace,
                    failurePolicy: .returnPartiallyParsedIfPossible
                )
            )
        ) ?? AttributedString(source)

        let styles = attributed.runs.map { run in
            (run.range, run.inlinePresentationIntent, run.link)
        }
        for (range, intent, link) in styles {
            if intent?.contains(.code) == true {
                attributed[range].font = baseFont.monospaced()
                attributed[range].foregroundColor = T3Colors.textPrimary.opacity(0.9)
                attributed[range].backgroundColor = T3Colors.surfaceRaised
            }
            if link != nil {
                attributed[range].foregroundColor = T3Colors.accent
            }
        }
        return attributed
    }
}


enum MarkdownGallery {
    static func images(in blocks: [MarkdownRenderedBlock]) -> [MarkdownInlineImage] {
        blocks.flatMap { block -> [MarkdownInlineImage] in
            switch block {
            case let .image(image): MarkdownMediaSource.isVideo(image.src) ? [] : [image]
            case let .blockquote(children), let .githubAlert(_, children): images(in: children)
            case let .unorderedList(items), let .orderedList(_, items): items.flatMap { images(in: $0.blocks) }
            default: []
            }
        }
    }
}

private struct MarkdownTemplateActionKey: EnvironmentKey {
    static let defaultValue: ((CodexArtifactTemplate) -> Void)? = nil
}
extension EnvironmentValues {
    var markdownTemplateAction: ((CodexArtifactTemplate) -> Void)? {
        get { self[MarkdownTemplateActionKey.self] }
        set { self[MarkdownTemplateActionKey.self] = newValue }
    }
}

private struct NativeArtifactTemplateCard: View {
    let template: CodexArtifactTemplate
    @SwiftUI.Environment(\.markdownTemplateAction) private var useTemplate
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "doc.badge.gearshape").font(.title2).foregroundStyle(T3Colors.accent)
            VStack(alignment: .leading, spacing: 3) {
                Text(template.displayName).font(T3Typography.supportingStrong)
                Text(template.label).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let useTemplate {
                Button("Use Template") { useTemplate(template) }
                    .font(T3Typography.supportingStrong)
                    .t3SecondaryButtonStyle()
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
            }
        }
        .padding(12)
        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}
