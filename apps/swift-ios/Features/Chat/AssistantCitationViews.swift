import SwiftUI
import UIKit

struct AssistantCitationContext {
    let environmentId: String
    let threadId: String
    let onCite: (AssistantCitation) -> Void
}
private struct AssistantCitationContextKey: EnvironmentKey {
    static let defaultValue: AssistantCitationContext? = nil
}
extension EnvironmentValues {
    var assistantCitationContext: AssistantCitationContext? {
        get { self[AssistantCitationContextKey.self] }
        set { self[AssistantCitationContextKey.self] = newValue }
    }
}

struct AssistantCitationChips: View {
    @Binding var text: String
    @State private var editing: AssistantCitation.Match?
    @SwiftUI.Environment(\.openURL) private var openURL
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(AssistantCitation.matches(in: text)) { match in
                    HStack(spacing: 0) {
                        Button { if let url = URL(string: match.citation.href) { openURL(url) } } label: {
                            Label(match.citation.comment?.isEmpty == false ? match.citation.comment! : match.citation.text, systemImage: "quote.bubble")
                                .lineLimit(1).frame(maxWidth: 180).padding(.leading, 12).padding(.trailing, 4)
                        }.accessibilityLabel("View quoted response: \(match.citation.text)")
                        Button { editing = match } label: { Image(systemName: "pencil").frame(width: 44, height: 44) }
                            .accessibilityLabel("Edit quote comment")
                        Button { text = AssistantCitation.replacing(match, in: text, with: nil) } label: {
                            Image(systemName: "xmark").frame(width: 44, height: 44)
                        }.accessibilityLabel("Remove quote")
                    }.font(T3Typography.supporting).buttonStyle(.plain)
                        .foregroundStyle(T3Colors.accent).background(T3Colors.subtleStrong, in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
        .sheet(item: $editing) { match in
            NavigationStack { AssistantCitationCommentSheet(citation: match.citation) { citation in
                text = AssistantCitation.replacing(match, in: text, with: citation)
            } }
        }
    }
}

struct AssistantCitationCommentSheet: View {
    let citation: AssistantCitation
    let onSave: (AssistantCitation) -> Void
    @State private var comment: String
    @SwiftUI.Environment(\.dismiss) private var dismiss
    init(citation: AssistantCitation, onSave: @escaping (AssistantCitation) -> Void) {
        self.citation = citation
        self.onSave = onSave
        _comment = State(initialValue: citation.comment ?? "")
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Label("Assistant quote", systemImage: "quote.bubble").font(T3Typography.supportingStrong)
                Text(citation.text).textSelection(.enabled).font(T3Typography.threadBody)
                TextField("Add an optional comment", text: $comment, axis: .vertical)
                    .lineLimit(3...8).textFieldStyle(.roundedBorder)
                if comment.utf16.count > 8_000 { Text("Comments can contain up to 8,000 characters.").foregroundStyle(T3Colors.danger) }
            }.padding(18)
        }.background(T3Colors.background).navigationTitle("Quote comment").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var updated = citation
                        let trimmed = comment.trimmingCharacters(in: .whitespacesAndNewlines)
                        updated.comment = trimmed.isEmpty ? nil : trimmed
                        onSave(updated)
                        dismiss()
                    }.disabled(comment.utf16.count > 8_000)
                }
            }
    }
}

struct AssistantCitationSelectionSheet: View {
    let text: String
    let messageId: String
    let context: AssistantCitationContext
    @State private var range = NSRange(location: 0, length: 0)
    @State private var quote: AssistantCitation?
    @SwiftUI.Environment(\.dismiss) private var dismiss
    private var selection: AssistantCitation? {
        AssistantCitation.capture(text: text, range: range, environmentId: context.environmentId, threadId: context.threadId, messageId: messageId)
    }
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text("Select the text you want to quote, then tap Cite.")
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(.horizontal, 18)
                CitationSelectableText(text: text, range: $range)
            }.padding(.top, 12).background(T3Colors.background).navigationTitle("Cite response").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("Cite") { quote = selection }.disabled(selection == nil) }
                }
                .sheet(item: $quote) { citation in
                    NavigationStack { AssistantCitationCommentSheet(citation: citation) { updated in
                        context.onCite(updated)
                        dismiss()
                    } }
                }
        }
    }
}

private struct CitationSelectableText: UIViewRepresentable {
    let text: String
    @Binding var range: NSRange
    func makeCoordinator() -> Coordinator { Coordinator(range: $range) }
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.textColor = .label
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 6, left: 18, bottom: 18, right: 18)
        view.delegate = context.coordinator
        view.text = text
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.range = $range
        if view.text != text { view.text = text }
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        var range: Binding<NSRange>
        init(range: Binding<NSRange>) { self.range = range }
        func textViewDidChangeSelection(_ textView: UITextView) { range.wrappedValue = textView.selectedRange }
    }
}

extension MarkdownRenderedDocument {
    var citationText: String { Self.citationText(blocks) }
    private static func citationText(_ blocks: [MarkdownRenderedBlock]) -> String {
        blocks.map { block in
            switch block {
            case .paragraph(let inline), .heading(_, let inline): String(inline.attributedText.characters)
            case .unorderedList(let items), .orderedList(_, let items): items.map { citationText($0.blocks) }.joined(separator: "\n")
            case .blockquote(let nested), .githubAlert(_, let nested): citationText(nested)
            case .table(let table): ([table.header] + table.rows).map { $0.map { String($0.attributedText.characters) }.joined(separator: "\t") }.joined(separator: "\n")
            case .codeBlock(_, let code, _): code
            case .image, .htmlEmbed, .artifactTemplate, .thematicBreak: ""
            }
        }.joined(separator: "\n")
    }
}

struct AssistantCitationPreview: View {
    let citation: AssistantCitation
    let onOpenSource: () -> Void
    @SwiftUI.Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Label("Assistant quote", systemImage: "quote.bubble").font(T3Typography.supportingStrong)
                    Text(citation.text).font(T3Typography.threadBody).textSelection(.enabled)
                    if let comment = citation.comment, !comment.isEmpty {
                        Divider()
                        Text("Your comment").font(T3Typography.supportingStrong)
                        Text(comment).font(T3Typography.threadBody).textSelection(.enabled)
                    }
                    Button("View source response", systemImage: "arrow.up.forward") { dismiss(); onOpenSource() }
                        .frame(minHeight: 44)
                }.padding(18)
            }.background(T3Colors.background).navigationTitle("Quoted response").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

struct AssistantCitationNavigationRequest: Equatable {
    let id = UUID()
    let citation: AssistantCitation
}

struct CitationAwareMessageText: View {
    let source: String
    let isStreaming: Bool
    @SwiftUI.Environment(\.openURL) private var openURL
    private struct Segment: Identifiable {
        let id: Int
        let text: String
        let citation: AssistantCitation?
    }
    private var segments: [Segment] {
        let matches = AssistantCitation.matches(in: source)
        guard !matches.isEmpty else { return [Segment(id: 0, text: source, citation: nil)] }
        let raw = source as NSString
        var cursor = 0
        var result: [Segment] = []
        for match in matches {
            if match.range.location > cursor {
                result.append(Segment(id: cursor, text: raw.substring(with: NSRange(location: cursor, length: match.range.location - cursor)), citation: nil))
            }
            result.append(Segment(id: match.range.location, text: "", citation: match.citation))
            cursor = NSMaxRange(match.range)
        }
        if cursor < raw.length { result.append(Segment(id: cursor, text: raw.substring(from: cursor), citation: nil)) }
        return result
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(segments) { segment in
                if let citation = segment.citation {
                    Button { if let url = URL(string: citation.href) { openURL(url) } } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("Assistant quote", systemImage: "quote.bubble").font(T3Typography.supportingStrong).foregroundStyle(T3Colors.accent)
                            Text(citation.text).font(T3Typography.threadBody).lineLimit(4).foregroundStyle(T3Colors.textPrimary)
                            if let comment = citation.comment, !comment.isEmpty {
                                Text(comment).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                            }
                            Label("View source", systemImage: "arrow.up.forward").font(T3Typography.supporting).foregroundStyle(T3Colors.accent)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                            .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 12))
                    }.buttonStyle(.plain)
                } else if !segment.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    MarkdownMessageView(segment.text, isStreaming: isStreaming)
                }
            }
        }
    }
}
