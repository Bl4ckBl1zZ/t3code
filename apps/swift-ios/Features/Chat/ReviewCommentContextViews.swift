import SwiftUI

struct ReviewCommentContextChips: View {
    @Binding var text: String
    @State private var selected: ReviewCommentContext.Match?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(ReviewCommentContext.matches(in: text)) { match in
                    HStack(spacing: 0) {
                        Button { selected = match } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Label(URL(fileURLWithPath: match.context.filePath).lastPathComponent, systemImage: "text.bubble")
                                    .font(T3Typography.supportingStrong)
                                Text(match.context.rangeLabel).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                            }.lineLimit(1).frame(maxWidth: 220, alignment: .leading)
                                .padding(.leading, 12).frame(minHeight: 44)
                        }.accessibilityLabel("Review context: \(match.context.filePath), \(match.context.rangeLabel)")
                        Button { text = ReviewCommentContext.replacing(match, in: text, with: nil) } label: {
                            Image(systemName: "xmark").frame(width: 44, height: 44)
                        }.accessibilityLabel("Remove review context")
                    }.buttonStyle(.plain).foregroundStyle(T3Colors.accent)
                        .background(T3Colors.subtleStrong, in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
        .sheet(item: $selected) { match in
            ReviewCommentContextSheet(context: match.context) { updated in
                text = ReviewCommentContext.replacing(match, in: text, with: updated)
            }
        }
    }
}

private struct ReviewCommentContextSheet: View {
    let context: ReviewCommentContext
    var onSave: ((ReviewCommentContext) -> Void)?
    @State private var comment: String
    @SwiftUI.Environment(\.dismiss) private var dismiss

    init(context: ReviewCommentContext, onSave: ((ReviewCommentContext) -> Void)? = nil) {
        self.context = context
        self.onSave = onSave
        _comment = State(initialValue: context.text)
    }
    private var highlightedDiff: AttributedString {
        guard context.language == "diff" else { return AttributedString(context.diff) }
        var result = AttributedString()
        let lines = context.diff.components(separatedBy: "\n")
        for (index, line) in lines.enumerated() {
            var text = AttributedString(line + (index + 1 < lines.count ? "\n" : ""))
            if line.hasPrefix("+") { text.foregroundColor = T3Colors.diffAddition }
            else if line.hasPrefix("-") { text.foregroundColor = T3Colors.diffDeletion }
            else { text.foregroundColor = T3Colors.textSecondary }
            result.append(text)
        }
        return result
    }

    private var edited: ReviewCommentContext { var value = context; value.text = comment; return value }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(context.sectionTitle).font(T3Typography.supportingStrong)
                    Label(context.filePath, systemImage: "doc.text").font(T3Typography.supporting).textSelection(.enabled)
                    Text(context.rangeLabel).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                    if onSave != nil {
                        TextField("Comment", text: $comment, axis: .vertical).lineLimit(3...10).textFieldStyle(.roundedBorder)
                        if edited.formatted == nil {
                            Text("Use up to 32,000 characters and avoid review-comment markup in this context.")
                                .font(T3Typography.supporting).foregroundStyle(T3Colors.danger)
                        }
                    } else if !context.text.isEmpty {
                        Text(context.text).font(T3Typography.threadBody).textSelection(.enabled)
                    }
                    if !context.diff.isEmpty {
                        ScrollView(.horizontal) {
                            Text(highlightedDiff).font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled).fixedSize(horizontal: true, vertical: false).padding(12)
                        }.background(T3Colors.subtle, in: RoundedRectangle(cornerRadius: 12))
                    }
                }.padding(18)
            }.background(T3Colors.background).navigationTitle("Review context").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(onSave == nil ? "Done" : "Cancel") { dismiss() } }
                    if let onSave {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Save") { onSave(edited); dismiss() }.disabled(edited.formatted == nil)
                        }
                    }
                }
        }
    }
}

struct ReviewContextMessageText: View {
    let source: String
    let isStreaming: Bool
    @State private var selected: ReviewCommentContext.Match?

    private struct Segment: Identifiable {
        let id: Int
        let text: String
        var match: ReviewCommentContext.Match?
    }
    private var segments: [Segment] {
        let matches = ReviewCommentContext.matches(in: source)
        let raw = source as NSString
        var cursor = 0
        var result: [Segment] = []
        for match in matches {
            if match.range.location > cursor {
                result.append(Segment(id: cursor, text: raw.substring(with: NSRange(location: cursor, length: match.range.location - cursor))))
            }
            result.append(Segment(id: match.range.location, text: "", match: match))
            cursor = NSMaxRange(match.range)
        }
        if cursor < raw.length { result.append(Segment(id: cursor, text: raw.substring(from: cursor))) }
        return result
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(segments) { segment in
                if let match = segment.match {
                    Button { selected = match } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Label(match.context.filePath, systemImage: "text.bubble").font(T3Typography.supportingStrong)
                            Text(match.context.rangeLabel).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                            if !match.context.text.isEmpty { Text(match.context.text).font(T3Typography.supporting).lineLimit(3) }
                        }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(12)
                            .background(T3Colors.subtle, in: RoundedRectangle(cornerRadius: 12))
                    }.buttonStyle(.plain).accessibilityHint("Opens the attached review context")
                } else if !segment.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    CitationAwareMessageText(source: segment.text, isStreaming: isStreaming)
                }
            }
        }.sheet(item: $selected) { ReviewCommentContextSheet(context: $0.context) }
    }
}
