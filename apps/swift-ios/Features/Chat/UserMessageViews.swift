import SwiftUI
import UIKit

// MARK: - Long-press menu extras

/// What a message adds to the long-press menu of the Markdown inside it: a
/// title, the text Copy / Share / Select hand over, and its own actions.
/// Read by `MarkdownMessageView` from the environment, so a user bubble with
/// several text segments still copies the whole message.
struct MessageMenuExtras: Equatable {
    struct Action: Identifiable, Equatable {
        let id: String
        let title: String
        var subtitle: String? = nil
        let systemImage: String
        var isDestructive = false
        var isDisabled = false
        let perform: () -> Void

        static func == (lhs: Action, rhs: Action) -> Bool {
            lhs.id == rhs.id && lhs.title == rhs.title && lhs.subtitle == rhs.subtitle
                && lhs.isDisabled == rhs.isDisabled && lhs.isDestructive == rhs.isDestructive
        }
    }

    var title: String?
    var copyText: String?
    var actions: [Action] = []
}

private struct MessageMenuExtrasKey: EnvironmentKey {
    static let defaultValue: MessageMenuExtras? = nil
}

extension EnvironmentValues {
    var messageMenuExtras: MessageMenuExtras? {
        get { self[MessageMenuExtrasKey.self] }
        set { self[MessageMenuExtrasKey.self] = newValue }
    }
}

/// The extras' own section of a long-press menu.
struct MessageMenuActionsSection: View {
    let actions: [MessageMenuExtras.Action]

    var body: some View {
        if !actions.isEmpty {
            Section {
                ForEach(actions) { action in
                    Button(role: action.isDestructive ? .destructive : nil, action: action.perform) {
                        Label {
                            Text(action.title)
                            if let subtitle = action.subtitle { Text(subtitle) }
                        } icon: {
                            Image(systemName: action.systemImage)
                        }
                    }
                    .disabled(action.isDisabled)
                }
            }
        }
    }
}

// MARK: - User bubble

/// The reader's own message: context chips, the typed text collapsed when
/// long, and the quiet line under it with its delivery, status and time.
/// `attachments` renders the ordinary attachments; annotation crops are
/// already taken out and shown on their cards.
struct UserMessageBubble<Attachments: View>: View {
    let message: FeatureMessage
    let caption: ThreadMessageCaption?
    let onRetrySend: () -> Void
    @ViewBuilder let attachments: ([FeatureMessageAttachment]) -> Attachments

    @SwiftUI.Environment(\.threadMessageActions) private var store
    @SwiftUI.Environment(\.threadLinkResolver) private var threadLinks
    @SwiftUI.Environment(\.threadFindHighlight) private var findHighlight
    @SwiftUI.Environment(\.threadFindEntryID) private var findEntryID
    @State private var localExpanded = false
    @State private var shownContext: UserMessageContextSheet.Item?
    @State private var isSelectingText = false

    private static var bubbleShape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: 16,
            bottomLeadingRadius: 16,
            bottomTrailingRadius: 4,
            topTrailingRadius: 16,
            style: .continuous
        )
    }

    var body: some View {
        let content = UserMessageContent.cached(message.text)
        let layout = UserMessageAttachmentLayout(attachments: message.attachments, annotationCount: content.previewAnnotations.count)
        let meta = store?.row(message.id).meta ?? ThreadMessageMeta()
        let bodyText = threadLinks?.relabel(content.body) ?? content.body
        let extras = menuExtras(content: content, bodyText: bodyText, meta: meta)

        HStack {
            Spacer(minLength: 44)
            VStack(alignment: .trailing, spacing: 4) {
                VStack(alignment: .leading, spacing: 10) {
                    attachments(layout.regular)
                    ForEach(Array(content.previewAnnotations.enumerated()), id: \.element.id) { index, annotation in
                        let image = layout.annotationImages.indices.contains(index) ? layout.annotationImages[index] : nil
                        UserMessageAnnotationCard(annotation: annotation, image: image) {
                            shownContext = .annotation(annotation, image: image)
                        }
                    }
                    if !content.elementContexts.isEmpty {
                        PullRequestChipFlow(spacing: 6) {
                            ForEach(content.elementContexts) { entry in
                                UserMessageContextChip(systemImage: "cursorarrow.rays", title: entry.header, detail: nil) {
                                    shownContext = .element(entry)
                                }
                            }
                        }
                    }
                    if let reply = content.reply {
                        UserMessageReplyPreview(text: reply.referencedText) { shownContext = .reply(reply.referencedText) }
                    }
                    if !content.terminalContexts.isEmpty {
                        PullRequestChipFlow(spacing: 6) {
                            ForEach(content.terminalContexts) { entry in
                                let parts = UserMessageContent.terminalHeaderParts(entry.header)
                                UserMessageContextChip(systemImage: "terminal", title: parts?.name ?? entry.header, detail: parts?.range) {
                                    shownContext = .terminal(entry)
                                }
                            }
                        }
                    }
                    if !bodyText.isEmpty {
                        collapsibleBody(bodyText, isLong: content.isLong)
                    }
                }
                .environment(\.messageMenuExtras, extras)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .frame(maxWidth: T3Metrics.readingWidth * 0.88, alignment: .leading)
                .background(T3Colors.subtleStrong, in: Self.bubbleShape)
                .contentShape(.contextMenuPreview, Self.bubbleShape)
                .contextMenu { menu(extras) }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("You")
                .accessibilityValue(accessibilityValue(content: content, bodyText: bodyText, attachmentCount: layout.regular.count))
                .accessibilityActions { accessibilityActions(content: content, layout: layout, extras: extras) }

                UserMessageFooter(caption: caption, meta: meta, onRetry: onRetrySend)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("message-\(message.id)")
        .sheet(item: $shownContext) { UserMessageContextSheet(item: $0) }
        .sheet(isPresented: $isSelectingText) { MarkdownSelectTextSheet(text: extras.copyText ?? "") }
    }

    // MARK: Body

    private var isExpanded: Bool {
        store?.row(message.id).isExpanded ?? localExpanded
    }

    /// Thread find's selected match is in this message: show all of it, since
    /// the match may sit below the fold.
    private var isFindTarget: Bool {
        findHighlight?.isActive(findEntryID) == true
    }

    @ViewBuilder
    private func collapsibleBody(_ text: String, isLong: Bool) -> some View {
        let collapsed = isLong && !isExpanded && !isFindTarget
        VStack(alignment: .leading, spacing: 4) {
            ReviewContextMessageText(source: text, isStreaming: message.state == .streaming)
                .modifier(UserMessageCollapse(isCollapsed: collapsed))
            if isLong {
                Button(collapsed ? "Show full message" : "Show less") {
                    if let store { store.toggleExpansion(message.id) } else { localExpanded.toggle() }
                }
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textSecondary)
                .buttonStyle(.plain)
                .padding(.vertical, 4)
                .contentShape(Rectangle().inset(by: -8))
                .accessibilityHidden(true)
            }
        }
    }

    // MARK: Menu

    private func menuExtras(content: UserMessageContent, bodyText: String, meta: ThreadMessageMeta) -> MessageMenuExtras {
        var actions: [MessageMenuExtras.Action] = []
        if content.hasContext {
            // Web's copy carries the context blocks, so a paste re-sends them.
            actions.append(.init(id: "copy-context", title: "Copy with Context", systemImage: "doc.on.clipboard") { [text = message.text] in
                UIPasteboard.general.string = text
                T3HUD.show("Copied", systemImage: "doc.on.doc")
            })
        }
        if let point = meta.restore, let store {
            let blocked: String? = store.isWorking
                ? "Stop the current turn first"
                : store.isReachable ? nil : "Reconnect to restore"
            actions.append(.init(
                id: "restore",
                title: "Restore to Here…",
                subtitle: blocked,
                systemImage: "arrow.counterclockwise",
                isDestructive: true,
                isDisabled: blocked != nil
            ) { store.restore(point) })
        }
        return MessageMenuExtras(title: meta.timestamp?.fullLabel, copyText: bodyText, actions: actions)
    }

    /// The bubble's own menu, for long-presses outside its text; the text's
    /// Markdown menu carries the same items.
    @ViewBuilder
    private func menu(_ extras: MessageMenuExtras) -> some View {
        Section {
            if let text = extras.copyText, !text.isEmpty {
                Button("Copy", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = text
                    T3HUD.show("Copied", systemImage: "doc.on.doc")
                }
                Button("Select Text…", systemImage: "text.cursor") { isSelectingText = true }
                ShareLink(item: text) { Label("Share…", systemImage: "square.and.arrow.up") }
            }
        } header: {
            if let title = extras.title { Text(verbatim: title) }
        }
        MessageMenuActionsSection(actions: extras.actions)
    }

    // MARK: Accessibility

    private func accessibilityValue(content: UserMessageContent, bodyText: String, attachmentCount: Int) -> String {
        var parts: [String] = []
        if let reply = content.reply { parts.append("Replying to: \(reply.referencedText)") }
        if !bodyText.isEmpty { parts.append(AssistantCitation.plainText(bodyText)) }
        for entry in content.terminalContexts { parts.append("Terminal context: \(entry.header)") }
        for entry in content.elementContexts { parts.append("Element context: \(entry.header)") }
        for annotation in content.previewAnnotations {
            parts.append("Preview annotation: \(annotation.comment.isEmpty ? annotation.title : annotation.comment)")
        }
        if attachmentCount > 0 { parts.append("\(attachmentCount) attachment\(attachmentCount == 1 ? "" : "s")") }
        return parts.joined(separator: ", ")
    }

    @ViewBuilder
    private func accessibilityActions(content: UserMessageContent, layout: UserMessageAttachmentLayout, extras: MessageMenuExtras) -> some View {
        ForEach(content.terminalContexts) { entry in
            Button("Show terminal context, \(entry.header)") { shownContext = .terminal(entry) }
        }
        ForEach(content.elementContexts) { entry in
            Button("Show element context, \(entry.header)") { shownContext = .element(entry) }
        }
        ForEach(Array(content.previewAnnotations.enumerated()), id: \.element.id) { index, annotation in
            Button("Show preview annotation") {
                shownContext = .annotation(annotation, image: layout.annotationImages.indices.contains(index) ? layout.annotationImages[index] : nil)
            }
        }
        if let reply = content.reply {
            Button("Show quoted message") { shownContext = .reply(reply.referencedText) }
        }
        if let text = extras.copyText, !text.isEmpty {
            Button("Copy message") {
                UIPasteboard.general.string = text
                T3HUD.show("Copied", systemImage: "doc.on.doc")
            }
        }
        ForEach(extras.actions.filter { !$0.isDisabled }) { action in
            Button(action.title.replacingOccurrences(of: "…", with: ""), action: action.perform)
        }
    }
}

/// Splits a user message's attachments into the ordinary ones and the crops
/// that belong to its preview annotations, paired by order. A crop with no
/// annotation to sit on stays an ordinary attachment rather than vanishing.
struct UserMessageAttachmentLayout: Equatable {
    let regular: [FeatureMessageAttachment]
    let annotationImages: [FeatureMessageAttachment]

    init(attachments: [FeatureMessageAttachment], annotationCount: Int) {
        var regular: [FeatureMessageAttachment] = []
        var images: [FeatureMessageAttachment] = []
        for attachment in attachments {
            if UserMessageContent.isPreviewAnnotationImage(attachment), images.count < annotationCount {
                images.append(attachment)
            } else {
                regular.append(attachment)
            }
        }
        self.regular = regular
        annotationImages = images
    }
}

/// Clips a long body to a few lines with a fade, like web's collapsed bubble.
/// The height scales with Dynamic Type so it keeps showing about the same text.
private struct UserMessageCollapse: ViewModifier {
    let isCollapsed: Bool
    @ScaledMetric(relativeTo: .body) private var collapsedHeight: CGFloat = 176
    @ScaledMetric(relativeTo: .body) private var fadeHeight: CGFloat = 28

    func body(content: Content) -> some View {
        if isCollapsed {
            content
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxHeight: collapsedHeight, alignment: .top)
                .clipped()
                .mask {
                    VStack(spacing: 0) {
                        Rectangle()
                        LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                            .frame(height: fadeHeight)
                    }
                }
        } else {
            content
        }
    }
}

// MARK: - Footer

/// The line under a user bubble. A delivery caption says it alone — until a
/// message is sent it has no time — otherwise the origin caption, a status
/// pill and the time share the line.
struct UserMessageFooter: View {
    let caption: ThreadMessageCaption?
    let meta: ThreadMessageMeta
    let onRetry: () -> Void

    var body: some View {
        if let caption, caption.isDelivery {
            ThreadMessageCaptionView(caption: caption, onRetry: onRetry)
        } else if caption != nil || meta.status != nil || meta.timestamp != nil {
            HStack(spacing: 6) {
                if let caption { ThreadMessageCaptionView(caption: caption, onRetry: onRetry) }
                if let status = meta.status { ThreadMessageStatusPillView(pill: status) }
                if let timestamp = meta.timestamp { ThreadMessageTimeText(timestamp: timestamp, prefix: "Sent") }
            }
        }
    }
}

/// The meta line under the last reply of a settled turn: its status and when
/// it finished. Renders nothing for any other reply.
struct ThreadAssistantMessageFooter: View {
    let messageID: String
    @SwiftUI.Environment(\.threadMessageActions) private var store

    var body: some View {
        if let store {
            let meta = store.row(messageID).meta
            let isForking = meta.fork != nil && store.forkingMessageID == messageID
            if meta.status != nil || meta.timestamp != nil || isForking {
                HStack(spacing: 6) {
                    if let status = meta.status { ThreadMessageStatusPillView(pill: status) }
                    if let timestamp = meta.timestamp { ThreadMessageTimeText(timestamp: timestamp, prefix: "Finished") }
                    if isForking {
                        ProgressView().controlSize(.mini)
                        Text("Forking…").font(T3Typography.supporting).foregroundStyle(T3Colors.textTertiary)
                    }
                }
            }
        }
    }
}

struct ThreadMessageTimeText: View {
    let timestamp: ThreadMessageTimestamp
    /// Read before the full date by VoiceOver: "Sent", "Finished".
    let prefix: String

    var body: some View {
        Text(verbatim: timestamp.label)
            .font(T3Typography.supporting.monospacedDigit())
            .foregroundStyle(T3Colors.textTertiary)
            .lineLimit(1)
            .accessibilityLabel("\(prefix) \(timestamp.fullLabel)")
    }
}

struct ThreadMessageStatusPillView: View {
    let pill: ThreadMessageStatusPill

    var body: some View {
        let tint = pill.tone == .danger ? T3Colors.danger : T3Colors.textSecondary
        Text(pill.label)
            .font(ChatTimelineStyle.smallStrong)
            .foregroundStyle(tint)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(tint.opacity(0.1), in: Capsule())
            .overlay { Capsule().strokeBorder(tint.opacity(0.3), lineWidth: 1) }
            .accessibilityLabel("Status: \(pill.label)")
    }
}

extension View {
    /// Puts a reply's fork action into the long-press menu of its Markdown and
    /// into VoiceOver's actions. A reply that cannot be forked is left alone.
    func threadAssistantMessageActions(messageID: String) -> some View {
        modifier(ThreadAssistantMessageActions(messageID: messageID))
    }
}

private struct ThreadAssistantMessageActions: ViewModifier {
    let messageID: String
    @SwiftUI.Environment(\.threadMessageActions) private var store

    func body(content: Content) -> some View {
        if let store, let fork = store.row(messageID).meta.fork {
            let blocked: String? = store.forkingMessageID != nil
                ? "Forking…"
                : store.isReachable ? nil : "Reconnect to fork"
            content
                .environment(\.messageMenuExtras, MessageMenuExtras(actions: [
                    .init(id: "fork", title: fork.title, subtitle: blocked, systemImage: "arrow.triangle.branch", isDisabled: blocked != nil) {
                        store.fork(fork)
                    },
                ]))
                .accessibilityAction(named: fork.title) { if blocked == nil { store.fork(fork) } }
        } else {
            content
        }
    }
}

// MARK: - Context chips

struct UserMessageContextChip: View {
    let systemImage: String
    let title: String
    let detail: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(ChatTimelineStyle.small)
                    .foregroundStyle(T3Colors.textSecondary)
                Text(verbatim: title)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let detail {
                    Text(verbatim: detail)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
            }
            .font(T3Typography.supporting)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .frame(maxWidth: 240, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(T3Colors.border, lineWidth: 1)
            }
            .contentShape(Rectangle().inset(by: -6))
        }
        .buttonStyle(.plain)
        .accessibilityLabel([title, detail].compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint("Shows the captured context")
    }
}

struct UserMessageReplyPreview: View {
    let text: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 8) {
                Capsule()
                    .fill(T3Colors.textTertiary)
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 3) {
                    Label("Replying to", systemImage: "arrowshape.turn.up.left")
                        .font(ChatTimelineStyle.smallStrong)
                        .foregroundStyle(T3Colors.textSecondary)
                    Text(verbatim: text)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
            }
            .fixedSize(horizontal: false, vertical: true)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Replying to: \(text)")
    }
}

struct UserMessageAnnotationCard: View {
    let annotation: UserMessageContent.PreviewAnnotation
    let image: FeatureMessageAttachment?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if let image {
                    UserMessageAttachmentImage(attachment: image, maximumPixelSize: 168)
                        .frame(width: 52, height: 52)
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                } else {
                    Image(systemName: "rectangle.dashed.and.paperclip")
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(width: 28)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: annotation.comment.isEmpty ? annotation.title : annotation.comment)
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 8) {
                        if !annotation.targetSummary.isEmpty {
                            Text(verbatim: annotation.targetSummary).lineLimit(1)
                        }
                        if !annotation.styleChanges.isEmpty {
                            Label("\(annotation.styleChanges.count)", systemImage: "paintbrush")
                                .labelStyle(.titleAndIcon)
                                .accessibilityLabel("\(annotation.styleChanges.count) style change\(annotation.styleChanges.count == 1 ? "" : "s")")
                        }
                    }
                    .font(ChatTimelineStyle.small)
                    .foregroundStyle(T3Colors.textSecondary)
                }
                Spacer(minLength: 0)
            }
            .padding(6)
            .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(T3Colors.border, lineWidth: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Preview annotation: \(annotation.comment.isEmpty ? annotation.title : annotation.comment)")
        .accessibilityHint("Shows the annotation")
    }
}

/// A message image from the server or, while it is still sending, from the
/// bytes on this device. Downsampled and cached like the attachment grid.
struct UserMessageAttachmentImage: View {
    let attachment: FeatureMessageAttachment
    let maximumPixelSize: Int
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: failed ? "exclamationmark.triangle" : "photo")
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(T3Colors.surfaceRaised)
            }
        }
        .accessibilityHidden(true)
        .task(id: "\(attachment.id)#\(maximumPixelSize)") {
            if let url = attachment.url {
                image = try? await FeatureAttachmentThumbnailLoader.image(for: url, maximumPixelSize: maximumPixelSize)
            } else if let data = attachment.previewData {
                image = await Task.detached(priority: .utility) { UIImage(data: data) }.value
            }
            failed = image == nil && !Task.isCancelled
        }
    }
}

// MARK: - Context sheet

/// The full capture behind a chip: terminal output, the picked element, an
/// annotation with its crop, or the message a reply quotes.
struct UserMessageContextSheet: View {
    enum Item: Identifiable {
        case terminal(UserMessageContent.ContextEntry)
        case element(UserMessageContent.ContextEntry)
        case annotation(UserMessageContent.PreviewAnnotation, image: FeatureMessageAttachment?)
        case reply(String)

        var id: String {
            switch self {
            case let .terminal(entry): "terminal:\(entry.id)"
            case let .element(entry): "element:\(entry.id)"
            case let .annotation(annotation, _): "annotation:\(annotation.id)"
            case let .reply(text): "reply:\(text)"
            }
        }
    }

    private struct GalleryImage: Identifiable {
        let url: URL
        var id: String { url.absoluteString }
    }

    let item: Item
    @SwiftUI.Environment(\.markdownMediaContext) private var mediaContext
    @State private var galleryImage: GalleryImage?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) { content }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(18)
            }
            .background(T3Colors.background)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(.close)
            .toolbar {
                if let copyText {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Copy", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = copyText
                            T3HUD.show("Copied", systemImage: "doc.on.doc")
                        }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .fullScreenCover(item: $galleryImage) { image in
            let preview = MarkdownInlineImage(alt: "Annotated preview", src: image.url.absoluteString)
            MarkdownGallerySheet(images: [preview], initial: preview, context: mediaContext)
        }
    }

    private var title: String {
        switch item {
        case let .terminal(entry): UserMessageContent.terminalHeaderParts(entry.header)?.name ?? "Terminal context"
        case .element: "Element"
        case let .annotation(annotation, _): annotation.title
        case .reply: "Replying to"
        }
    }

    private var copyText: String? {
        switch item {
        case let .terminal(entry), let .element(entry): entry.body.isEmpty ? entry.header : entry.body
        case let .annotation(annotation, _): annotation.comment.isEmpty ? nil : annotation.comment
        case let .reply(text): text
        }
    }

    @ViewBuilder
    private var content: some View {
        switch item {
        case let .terminal(entry):
            if let range = UserMessageContent.terminalHeaderParts(entry.header)?.range {
                Label(range.prefix(1).uppercased() + range.dropFirst(), systemImage: "terminal")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            monospacedBlock(entry.body.isEmpty ? "No output was captured." : entry.body)
        case let .element(entry):
            Label(entry.header, systemImage: "cursorarrow.rays")
                .font(T3Typography.supportingStrong)
                .textSelection(.enabled)
            if !entry.body.isEmpty { monospacedBlock(entry.body) }
        case let .annotation(annotation, image):
            if let image {
                Button {
                    galleryImage = image.url.map(GalleryImage.init(url:))
                } label: {
                    UserMessageAttachmentImage(attachment: image, maximumPixelSize: 1200)
                        .aspectRatio(contentMode: .fit)
                        .frame(maxWidth: .infinity, maxHeight: 280)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(image.url == nil)
                .accessibilityLabel("Annotated preview")
                .accessibilityHint(image.url == nil ? "" : "Opens full-screen preview")
            }
            if !annotation.comment.isEmpty {
                Text(verbatim: annotation.comment)
                    .font(T3Typography.threadBody)
                    .textSelection(.enabled)
            }
            if !annotation.targetSummary.isEmpty {
                Label(annotation.targetSummary, systemImage: "scope")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            if !annotation.styleChanges.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Requested Visual Changes")
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textSecondary)
                    ForEach(Array(annotation.styleChanges.enumerated()), id: \.offset) { _, change in
                        Text(verbatim: change)
                            .font(T3Typography.tool)
                            .textSelection(.enabled)
                    }
                }
            }
        case let .reply(text):
            Text(verbatim: text)
                .font(T3Typography.threadBody)
                .textSelection(.enabled)
        }
    }

    private func monospacedBlock(_ text: String) -> some View {
        ScrollView(.horizontal) {
            Text(verbatim: text)
                .font(T3Typography.tool)
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: true)
                .padding(12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T3Colors.subtle, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
