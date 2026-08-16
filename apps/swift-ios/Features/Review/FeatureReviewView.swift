import SwiftUI
import UIKit

public struct FeatureReviewView: View {
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    let client: any FeatureClient
    let threadID: String
    /// A file the review should open pointed at, handed over by a changed-files
    /// row in the thread feed. Armed on the store rather than used directly: the
    /// review has the request before it has a diff to spend it against.
    let initialFilePath: String?
    private let selection: ReviewSelectionStore

    @State private var review: FeatureReview?
    @State private var isLoading = true
    @State private var errorMessage: String?
    /// The scope `review` was actually loaded for, which is not always the one
    /// selected right now: a load in flight, or one that failed, leaves the two
    /// apart, and the header labels what is on screen rather than what was asked
    /// for.
    @State private var loadedScope: ReviewSectionID?
    /// The row the preselection resolved to, highlighted and scrolled to once.
    @State private var focusedFileID: String?
    /// Whether the handover from the feed has been passed to the store yet. The
    /// load is keyed on the scope and so re-runs on every switch; the handover
    /// is a first-appearance thing.
    @State private var didArmInitialFile = false

    /// What the review is pointed at, from the selection the feed armed.
    ///
    /// An id this build cannot read falls back to the working tree, and the
    /// header then says "working tree" — the fallback is allowed to change what
    /// is shown, never to mislabel it.
    private var scope: ReviewSectionID {
        guard let sectionID = selection.selection(for: threadID).sectionID else {
            return .workingTree
        }
        return ReviewSectionID(rawValue: sectionID) ?? .workingTree
    }

    public init(
        client: any FeatureClient,
        threadID: String,
        selection: ReviewSelectionStore,
        initialFilePath: String? = nil
    ) {
        self.client = client
        self.threadID = threadID
        self.selection = selection
        self.initialFilePath = initialFilePath
    }

    public var body: some View {
        Group {
            if isLoading, review == nil {
                ProgressView("Loading changes…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let review {
                ScrollViewReader { scroll in
                    reviewList(review)
                        // `task(id:)` rather than `onChange`: the list only
                        // exists once the diff has parsed, and by then the
                        // preselection has already been spent — a change
                        // handler mounting with the value would never fire.
                        .task(id: focusedFileID) {
                            guard let focusedFileID else { return }
                            await Task.yield()
                            guard !Task.isCancelled else { return }
                            scroll.scrollTo(focusedFileID, anchor: .center)
                        }
                }
            } else {
                unavailable
            }
        }
        .background(T3Colors.background)
        .navigationTitle("Review")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await load() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Reload changes")
            }
        }
        // Keyed on the scope so switching between a checkpoint and the working
        // tree re-reads rather than relabelling the diff already on screen.
        .task(id: scope) {
            if !didArmInitialFile {
                didArmInitialFile = true
                // Armed before the first read, so a diff that parses while this
                // screen is still loading already has the request waiting for
                // it. Unconditional, `nil` included: opening the review from
                // anywhere but a file chip has to disarm a request that was
                // never spent — a sheet dismissed before its diff parsed would
                // otherwise scroll the next reader to a file they did not ask
                // for. Once only, because a later scope switch is the reader
                // navigating, not the feed handing a file over.
                selection.selectFile(initialFilePath, for: threadID)
            }
            await load()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, review != nil, !isLoading else { return }
            Task { await load() }
        }
    }

    /// What a scope that could not be loaded says.
    ///
    /// A checkpoint whose diff cannot be resolved says so and offers the working
    /// tree as an explicit, labelled choice. Quietly loading the working tree
    /// instead is the bug this screen is fixing: it renders as a success and
    /// attributes today's uncommitted edits to a turn that ended hours ago.
    @ViewBuilder
    private var unavailable: some View {
        switch scope {
        case .workingTree:
            ContentUnavailableView(
                "Review unavailable",
                systemImage: "doc.text.magnifyingglass",
                description: Text(errorMessage ?? "Changes could not be loaded.")
            )
        case .checkpoint:
            ContentUnavailableView {
                Label("Checkpoint diff unavailable", systemImage: "clock.badge.xmark")
            } description: {
                Text(errorMessage ?? "This checkpoint's diff could not be loaded.")
            } actions: {
                Button("Show the working tree instead") { showWorkingTree() }
            }
        }
    }

    private func showWorkingTree() {
        selection.selectSection(ReviewSectionID.workingTree.rawValue, for: threadID)
    }

    private func reviewList(_ review: FeatureReview) -> some View {
        List {
            Section {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        // Two diffs that look alike in a file list can mean very
                        // different things, so what is being shown is stated
                        // rather than left to be inferred from the title.
                        Text(scopeEyebrow)
                            .font(T3Typography.eyebrow)
                            .foregroundStyle(T3Colors.textTertiary)
                            .accessibilityLabel("Showing \(scopeEyebrow.lowercased())")
                        Text(review.title)
                            .font(T3Typography.navigationTitle)
                        if let base = review.baseReference {
                            Text(base)
                                .font(T3Typography.tool)
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                    }
                    Spacer()
                    FeatureDiffStatsLabel(additions: review.additions, deletions: review.deletions)
                }
                .padding(.vertical, 3)

                if review.isTruncated {
                    Label("Large diff, showing a partial result", systemImage: "exclamationmark.triangle")
                        .font(T3Typography.supporting)
                        .foregroundStyle(.orange)
                }

                if isShowingCheckpoint {
                    // The way back. Without it a review opened from a checkpoint
                    // row is stuck on history for the rest of the sheet.
                    Button {
                        showWorkingTree()
                    } label: {
                        Label("Show the working tree", systemImage: "arrow.uturn.forward")
                            .font(T3Typography.control)
                    }
                }
            }

            Section("\(review.files.count) changed \(review.files.count == 1 ? "file" : "files")") {
                if review.files.isEmpty {
                    ContentUnavailableView(
                        "No changes",
                        systemImage: "checkmark.circle",
                        description: Text(
                            isShowingCheckpoint
                                ? "This turn captured no file changes."
                                : "The working tree is clean."
                        )
                    )
                    .listRowBackground(Color.clear)
                }
                ForEach(review.files) { file in
                    NavigationLink {
                        FeatureDiffView(client: client, threadID: threadID, file: file)
                    } label: {
                        FeatureReviewFileRow(file: file)
                    }
                    .id(file.id)
                    .listRowBackground(rowBackground(for: file))
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable { await load() }
    }

    /// A tint on the row a deep link landed on, so the scroll has something to
    /// point at. `nil` — the list's own background — for every other row.
    private func rowBackground(for file: FeatureReviewFile) -> Color? {
        file.id == focusedFileID ? T3Colors.accent.opacity(0.12) : nil
    }

    /// True only once the checkpoint's own diff is the thing on screen. Read
    /// from `loadedScope`, not from `scope`: mid-switch the two disagree, and
    /// labelling the outgoing diff with the incoming scope is the same lie in
    /// miniature.
    private var isShowingCheckpoint: Bool {
        loadedScope?.checkpointID != nil
    }

    private var scopeEyebrow: String {
        isShowingCheckpoint ? "CHECKPOINT DIFF" : "WORKING TREE"
    }

    private func load() async {
        let scope = scope
        isLoading = true
        defer { isLoading = false }
        do {
            let loaded: FeatureReview
            switch scope {
            case .workingTree:
                loaded = try await client.loadReview(threadID: threadID)
            case let .checkpoint(id):
                loaded = try await client.loadReview(threadID: threadID, checkpointID: id)
            }
            review = loaded
            loadedScope = scope
            errorMessage = nil
            // Every load re-runs this, and the store is what makes that safe:
            // an unparsed diff leaves the request armed, and a parsed one spends
            // it whether or not the file was in this diff.
            if let target = selection.consumePreselectedFile(
                for: threadID,
                files: loaded.files
            ) {
                focusedFileID = target.id
            }
        } catch {
            errorMessage = error.localizedDescription
            // A failed refresh of the scope already on screen keeps showing it:
            // it was right when it loaded and it is still that scope. A failed
            // *switch* must not, because what is on screen is then the other
            // scope's diff under the new scope's heading.
            if loadedScope != scope {
                review = nil
                loadedScope = nil
                focusedFileID = nil
            }
        }
    }
}

private struct FeatureReviewFileRow: View {
    let file: FeatureReviewFile

    var body: some View {
        HStack(spacing: 10) {
            Text(changeLabel)
                .font(.caption2.monospaced().weight(.bold))
                .foregroundStyle(changeColor)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(fileName)
                    .font(T3Typography.homeTitle)
                    .lineLimit(1)
                if !directory.isEmpty {
                    Text(directory)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            FeatureDiffStatsLabel(additions: file.additions, deletions: file.deletions)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private var fileName: String {
        file.path.split(separator: "/").last.map(String.init) ?? file.path
    }

    private var directory: String {
        let components = file.path.split(separator: "/")
        return components.dropLast().joined(separator: "/")
    }

    private var changeLabel: String {
        switch file.change {
        case .added: "A"
        case .modified: "M"
        case .deleted: "D"
        case .renamed: "R"
        case .binary: "B"
        }
    }

    private var changeColor: Color {
        switch file.change {
        case .added: .green
        case .deleted: .red
        case .renamed: .blue
        case .modified, .binary: .orange
        }
    }
}

struct FeatureDiffStatsLabel: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 5) {
            if additions > 0 {
                Text("+\(additions)").foregroundStyle(.green)
            }
            if deletions > 0 {
                Text("−\(deletions)").foregroundStyle(.red)
            }
        }
        .font(T3Typography.tool.monospacedDigit().weight(.medium))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(additions) additions, \(deletions) deletions")
    }
}

private struct FeatureDiffView: View {
    let client: any FeatureClient
    let threadID: String
    let file: FeatureReviewFile

    @State private var renderedLines: [FeatureDiffLine]
    @State private var isHydrating = false
    @State private var selectedLine: FeatureReviewLineSelection?
    @State private var isCommenting = false
    @State private var comment = ""
    @State private var isSending = false
    @State private var commentError: String?
    @FocusState private var isCommentFocused: Bool

    init(client: any FeatureClient, threadID: String, file: FeatureReviewFile) {
        self.client = client
        self.threadID = threadID
        self.file = file
        _renderedLines = State(initialValue: file.lines)
    }

    var body: some View {
        Group {
            if renderedLines.isEmpty, isHydrating {
                ProgressView("Loading full diff…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if renderedLines.isEmpty {
                ContentUnavailableView(
                    file.change == .binary ? "Binary file" : "Diff unavailable",
                    systemImage: file.change == .binary ? "doc.richtext" : "doc.text.magnifyingglass",
                    description: Text("No line-level preview is available.")
                )
            } else {
                GeometryReader { proxy in
                    ScrollView([.horizontal, .vertical]) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(renderedLines) { line in
                                FeatureDiffLineRow(
                                    line: line,
                                    isSelected: selection(for: line) == selectedLine,
                                    minimumWidth: proxy.size.width
                                ) {
                                    guard let selection = selection(for: line) else { return }
                                    selectedLine = selection
                                    openCommentComposer()
                                }
                            }
                        }
                        .frame(minWidth: proxy.size.width, alignment: .leading)
                        .padding(.vertical, 8)
                    }
                }
            }
        }
        .background(T3Colors.background)
        .navigationTitle(file.path.split(separator: "/").last.map(String.init) ?? file.path)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    selectedLine = nil
                    openCommentComposer()
                } label: {
                    Image(systemName: "text.bubble")
                }
                .accessibilityLabel("Add file review comment")
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if isCommenting {
                commentComposer
            }
        }
        .task(id: file.id) { await hydrate() }
    }

    private var commentComposer: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("REVIEW COMMENT")
                        .font(T3Typography.eyebrow)
                        .foregroundStyle(T3Colors.textTertiary)
                    Text(commentLocation)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Button {
                    isCommenting = false
                    isCommentFocused = false
                    commentError = nil
                } label: {
                    Image(systemName: "xmark")
                        .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                }
                .buttonStyle(.plain)
                .foregroundStyle(T3Colors.textSecondary)
                .accessibilityLabel("Close review comment")
            }

            TextField(
                "What should change?",
                text: $comment,
                axis: .vertical
            )
            .font(T3Typography.composer)
            .lineLimit(2 ... 6)
            .focused($isCommentFocused)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(T3Colors.input)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .stroke(T3Colors.border, lineWidth: 1)
            }

            if let commentError {
                Text(commentError)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.danger)
            }

            HStack(spacing: 10) {
                Button {
                    UIPasteboard.general.string = reviewDraft.prompt
                } label: {
                    Label("Copy prompt", systemImage: "doc.on.doc")
                        .frame(maxWidth: .infinity, minHeight: 42)
                }
                .buttonStyle(.plain)
                .foregroundStyle(T3Colors.textSecondary)
                .background(T3Colors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: 9))
                .disabled(trimmedComment.isEmpty)

                Button {
                    sendComment()
                } label: {
                    HStack(spacing: 7) {
                        if isSending {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "arrow.up")
                        }
                        Text("Send to agent")
                    }
                    .frame(maxWidth: .infinity, minHeight: 42)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .background(T3Colors.accent)
                .clipShape(RoundedRectangle(cornerRadius: 9))
                .disabled(trimmedComment.isEmpty || isSending)
            }
            .font(T3Typography.control)
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(T3Colors.surface)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(T3Colors.separator)
                .frame(height: 1)
        }
    }

    private var trimmedComment: String {
        comment.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var reviewDraft: FeatureReviewCommentDraft {
        FeatureReviewCommentDraft(filePath: file.path, line: selectedLine, body: comment)
    }

    private var commentLocation: String {
        guard let selectedLine else { return file.path }
        return "\(file.path) · \(selectedLine.side.rawValue) line \(selectedLine.line)"
    }

    private func selection(for line: FeatureDiffLine) -> FeatureReviewLineSelection? {
        if let newLine = line.newLine {
            return FeatureReviewLineSelection(side: .new, line: newLine)
        }
        if let oldLine = line.oldLine {
            return FeatureReviewLineSelection(side: .old, line: oldLine)
        }
        return nil
    }

    private func openCommentComposer() {
        isCommenting = true
        commentError = nil
        Task { @MainActor in
            await Task.yield()
            isCommentFocused = true
        }
    }

    private func hydrate() async {
        isHydrating = true
        defer { isHydrating = false }
        guard let contents = try? await client.loadReviewFileContents(
            threadID: threadID,
            file: file
        ) else {
            return
        }
        renderedLines = FeatureFullDiffHydrator.lines(for: file, contents: contents)
    }

    private func sendComment() {
        guard !trimmedComment.isEmpty, !isSending else { return }
        let prompt = reviewDraft.prompt
        isSending = true
        commentError = nil
        Task {
            do {
                try await client.sendMessage(threadID: threadID, text: prompt, selection: nil)
                comment = ""
                selectedLine = nil
                isCommenting = false
                isCommentFocused = false
            } catch {
                commentError = error.localizedDescription
            }
            isSending = false
        }
    }
}

private struct FeatureDiffLineRow: View {
    let line: FeatureDiffLine
    let isSelected: Bool
    let minimumWidth: CGFloat
    let select: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if line.kind == .hunk {
                Text(line.text)
                    .foregroundStyle(.blue)
                    .padding(.horizontal, 10)
                    .fixedSize(horizontal: true, vertical: false)
            } else {
                lineNumber(line.oldLine)
                lineNumber(line.newLine)
                Text(prefix)
                    .foregroundStyle(prefixColor)
                    .frame(width: 18)
                diffText
                    .fixedSize(horizontal: true, vertical: false)
                    .textSelection(.enabled)
                    .padding(.trailing, 12)
            }
        }
        .font(T3Typography.code)
        .fixedSize(horizontal: true, vertical: false)
        .frame(
            minWidth: minimumWidth,
            minHeight: line.kind == .hunk ? 30 : 22,
            alignment: .leading
        )
        .background(isSelected ? T3Colors.accent.opacity(0.14) : background)
        .overlay(alignment: .leading) {
            if isSelected {
                Rectangle()
                    .fill(T3Colors.accent)
                    .frame(width: 2)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: select)
        .accessibilityAction(named: "Add review comment", select)
    }

    private func lineNumber(_ value: Int?) -> some View {
        Text(value.map(String.init) ?? "")
            .foregroundStyle(.tertiary)
            .frame(width: 48, alignment: .trailing)
            .padding(.trailing, 7)
            .accessibilityHidden(true)
    }

    private var prefix: String {
        switch line.kind {
        case .addition: "+"
        case .deletion: "−"
        case .context, .hunk: " "
        }
    }

    private var prefixColor: Color {
        switch line.kind {
        case .addition: .green
        case .deletion: .red
        case .context, .hunk: .secondary
        }
    }

    @ViewBuilder
    private var diffText: some View {
        if let spans = line.spans, !spans.isEmpty {
            HStack(spacing: 0) {
                ForEach(spans.indices, id: \.self) { index in
                    let span = spans[index]
                    Text(verbatim: span.text.isEmpty ? " " : span.text)
                        .foregroundStyle(.primary)
                        .fontWeight(span.kind == .changed ? .semibold : .regular)
                        .background(span.kind == .changed ? changedSpanBackground : Color.clear)
                }
            }
        } else {
            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(.primary)
        }
    }

    private var changedSpanBackground: Color {
        switch line.kind {
        case .addition: Color.green.opacity(0.28)
        case .deletion: Color.red.opacity(0.28)
        case .context, .hunk: Color.clear
        }
    }

    private var background: Color {
        switch line.kind {
        case .addition: Color.green.opacity(0.11)
        case .deletion: Color.red.opacity(0.11)
        case .hunk: Color.blue.opacity(0.08)
        case .context: Color.clear
        }
    }
}
