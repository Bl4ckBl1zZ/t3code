import SwiftUI
import UIKit

/// The thread's changes: the working tree, or the diff one checkpoint captured.
/// Pushed inside Thread Details and also presented as a sheet root, so it
/// carries no close button of its own.
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
    /// Bumped by Try Again to re-run the load for the same scope.
    @State private var reloadAttempt = 0
    @State private var filterText = ""

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
                if review.files.isEmpty {
                    clean
                } else {
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
                }
            } else {
                unavailable
            }
        }
        .background(T3Colors.background)
        .t3ToolTitle("Review", subtitle: review == nil ? nil : scopeSubtitle)
        .t3Searchable(text: $filterText, prompt: Text("Filter files"))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if isShowingCheckpoint {
                        Button {
                            showWorkingTree()
                        } label: {
                            Label("Show Working Tree", systemImage: "arrow.uturn.forward")
                        }
                    }
                    Button {
                        reloadAttempt += 1
                    } label: {
                        Label("Reload", systemImage: "arrow.clockwise")
                    }
                    .disabled(isLoading)
                } label: {
                    Label("More", systemImage: "ellipsis")
                }
            }
        }
        .t3NavigationChrome()
        // Keyed on the scope so switching between a checkpoint and the working
        // tree re-reads rather than relabelling the diff already on screen.
        .task(id: ReviewLoadKey(scope: scope, attempt: reloadAttempt)) {
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
            ContentUnavailableView {
                Label("Couldn't Load Changes", systemImage: "doc.text.magnifyingglass")
            } description: {
                Text(errorMessage ?? "Changes could not be loaded.")
            } actions: {
                Button("Try Again") { reloadAttempt += 1 }
                    .t3SecondaryButtonStyle()
            }
        case .checkpoint:
            ContentUnavailableView {
                Label("Checkpoint Diff Unavailable", systemImage: "clock.badge.xmark")
            } description: {
                Text(errorMessage ?? "This checkpoint's diff could not be loaded.")
            } actions: {
                Button("Try Again") { reloadAttempt += 1 }
                    .t3SecondaryButtonStyle()
                Button("Show the Working Tree Instead") { showWorkingTree() }
            }
        }
    }

    /// No files: the empty state replaces the list rather than sitting in it.
    private var clean: some View {
        ContentUnavailableView {
            Label("No Changes", systemImage: "checkmark.circle")
        } description: {
            Text(isShowingCheckpoint ? "This turn captured no file changes." : "The working tree is clean.")
        } actions: {
            if isShowingCheckpoint {
                Button("Show Working Tree") { showWorkingTree() }
                    .t3SecondaryButtonStyle()
            }
        }
    }

    private func showWorkingTree() {
        selection.selectSection(ReviewSectionID.workingTree.rawValue, for: threadID)
    }

    @ViewBuilder
    private func reviewList(_ review: FeatureReview) -> some View {
        let files = filteredFiles(review)
        if files.isEmpty {
            ContentUnavailableView.search(text: filterText)
        } else {
            List {
                if let errorMessage {
                    bannerSection {
                        T3ToolBanner(
                            tone: .warning,
                            title: "Couldn't Refresh",
                            message: errorMessage,
                            actionTitle: "Retry",
                            action: { reloadAttempt += 1 }
                        )
                    }
                }
                if review.isTruncated {
                    bannerSection {
                        T3ToolBanner(
                            tone: .warning,
                            title: "Large diff",
                            message: "Showing the first \(review.files.count) files."
                        )
                    }
                }

                Section {
                    ForEach(files) { file in
                        NavigationLink {
                            FeatureDiffView(client: client, threadID: threadID, file: file)
                        } label: {
                            FeatureReviewFileRow(file: file)
                        }
                        .id(file.id)
                        .listRowBackground(
                            file.id == focusedFileID ? T3Colors.accent.opacity(0.12) : T3Colors.surface
                        )
                    }
                } header: {
                    HStack(spacing: 6) {
                        Text(review.files.count == 1 ? "1 changed file" : "\(review.files.count) changed files")
                        FeatureDiffStatsLabel(additions: review.additions, deletions: review.deletions)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .t3GroupedListBackground()
            .refreshable { await load() }
        }
    }

    private func bannerSection(@ViewBuilder content: () -> some View) -> some View {
        Section {
            content()
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
        }
    }

    private func filteredFiles(_ review: FeatureReview) -> [FeatureReviewFile] {
        let query = filterText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return review.files }
        return review.files.filter { $0.path.localizedCaseInsensitiveContains(query) }
    }

    /// True only once the checkpoint's own diff is the thing on screen. Read
    /// from `loadedScope`, not from `scope`: mid-switch the two disagree, and
    /// labelling the outgoing diff with the incoming scope is the same lie in
    /// miniature.
    private var isShowingCheckpoint: Bool {
        loadedScope?.checkpointID != nil
    }

    /// "Working tree", or "Turn 4 · since turn 3" for a checkpoint. Two diffs
    /// that look alike in a file list can mean very different things, so what
    /// is being shown is stated rather than left to be inferred.
    private var scopeSubtitle: String {
        guard isShowingCheckpoint, let review else { return "Working tree" }
        return [review.title, review.baseReference].compactMap { $0 }.joined(separator: " · ")
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
        } catch is CancellationError {
            return
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

private struct ReviewLoadKey: Equatable {
    let scope: ReviewSectionID
    let attempt: Int
}

struct FeatureReviewFileRow: View {
    let file: FeatureReviewFile

    @ScaledMetric(relativeTo: .footnote) private var letterWidth: CGFloat = 18

    var body: some View {
        HStack(spacing: 10) {
            Text(file.change.statusLetter)
                .font(.footnote.monospaced().weight(.bold))
                .foregroundStyle(changeColor)
                .frame(width: letterWidth)
                .accessibilityLabel(file.change.accessibilityName)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.fileName)
                    .font(T3Typography.homeTitle)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                let detail = file.reviewDetail
                if !detail.isEmpty {
                    Text(detail)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            Spacer()
            FeatureDiffStatsLabel(additions: file.additions, deletions: file.deletions)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    /// Theme tokens, so the color-blind diff palette reads the same here as in
    /// Source Control.
    private var changeColor: Color {
        switch file.change {
        case .added: T3Colors.diffAddition
        case .deleted: T3Colors.diffDeletion
        case .renamed: T3Colors.accent
        case .modified, .binary: T3Colors.warning
        }
    }
}

struct FeatureDiffStatsLabel: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 5) {
            if additions > 0 {
                Text("+\(additions)").foregroundStyle(T3Colors.diffAddition)
            }
            if deletions > 0 {
                Text("−\(deletions)").foregroundStyle(T3Colors.diffDeletion)
            }
        }
        .font(T3Typography.tool.monospacedDigit().weight(.medium))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(additions) additions, \(deletions) deletions")
    }
}

/// One file's diff: unchanged runs folded around each change, Previous/Next
/// Change in the bottom toolbar, and comments from a line's context menu or
/// the toolbar.
private struct FeatureDiffView: View {
    let client: any FeatureClient
    let threadID: String
    let file: FeatureReviewFile

    @SwiftUI.Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var renderedLines: [FeatureDiffLine]
    @State private var rows: [ReviewDiffRow] = []
    @State private var expandedFolds: Set<String> = []
    @State private var changeIDs: [String] = []
    @State private var cursor = ReviewChangeCursor(count: 0)
    /// Scroll requests, bumped so stepping to the same change scrolls again.
    @State private var scrollRequest = 0
    @State private var syntaxSpans: [String: [FeatureSourceSpan]] = [:]
    @State private var isHydrating = false
    @State private var selectedLine: FeatureReviewLineSelection?
    @State private var isCommenting = false
    @State private var comment = ""
    @State private var isSending = false
    @State private var commentError: String?
    @FocusState private var isCommentFocused: Bool
    @ScaledMetric(relativeTo: .callout) private var digitWidth: CGFloat = 9

    /// Cheap on purpose: the review list builds one of these per row for its
    /// navigation links, so the layout waits for the view to appear.
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
                    file.change == .binary ? "Binary File" : "Diff Unavailable",
                    systemImage: file.change == .binary ? "doc.richtext" : "doc.text.magnifyingglass",
                    description: Text("No line-level preview is available.")
                )
            } else {
                diffContent
            }
        }
        .background(T3Colors.background)
        .navigationTitle(file.fileName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .bottomBar) {
                Button {
                    step(forward: false)
                } label: {
                    Label("Previous Change", systemImage: "chevron.up")
                }
                .disabled(!cursor.canGoPrevious)
                .keyboardShortcut(.upArrow, modifiers: [.control, .command])

                Button {
                    step(forward: true)
                } label: {
                    Label("Next Change", systemImage: "chevron.down")
                }
                .disabled(!cursor.canGoNext)
                .keyboardShortcut(.downArrow, modifiers: [.control, .command])

                Spacer()

                Text(cursor.label)
                    .font(.footnote)
                    .foregroundStyle(T3Colors.textSecondary)
                    .monospacedDigit()

                Spacer()

                Button {
                    selectedLine = nil
                    openCommentComposer()
                } label: {
                    Label("Comment on File", systemImage: "text.bubble")
                }
            }
        }
        .toolbar(isCommenting ? .hidden : .visible, for: .bottomBar)
        .t3NavigationChrome()
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if isCommenting {
                commentComposer
            }
        }
        .task(id: file.id) { await hydrate() }
    }

    private var diffContent: some View {
        GeometryReader { proxy in
            ScrollViewReader { scroll in
                ScrollView([.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(rows) { row in
                            rowView(row, minimumWidth: proxy.size.width)
                                .id(row.id)
                        }
                    }
                    .frame(minWidth: proxy.size.width, alignment: .leading)
                    .padding(.vertical, 8)
                }
                .onChange(of: scrollRequest) {
                    guard let index = cursor.index, changeIDs.indices.contains(index) else { return }
                    withAnimation(.easeInOut(duration: 0.25)) {
                        scroll.scrollTo(changeIDs[index], anchor: .center)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func rowView(_ row: ReviewDiffRow, minimumWidth: CGFloat) -> some View {
        switch row {
        case let .line(line):
            FeatureDiffLineRow(
                line: line,
                syntax: syntaxSpans[line.id],
                isSelected: selection(for: line).map { $0 == selectedLine } ?? false,
                minimumWidth: minimumWidth,
                numberWidth: numberWidth,
                showsBothNumbers: horizontalSizeClass == .regular,
                allowsTextSelection: false
            )
            .contextMenu {
                Button {
                    UIPasteboard.general.string = line.text
                    T3HUD.show("Copied", systemImage: "doc.on.doc")
                } label: {
                    Label("Copy Line", systemImage: "doc.on.doc")
                }
                if let selection = selection(for: line) {
                    Button {
                        selectedLine = selection
                        openCommentComposer()
                    } label: {
                        Label("Comment on Line", systemImage: "text.bubble")
                    }
                }
            }
            .accessibilityAction(named: "Comment on Line") {
                guard let selection = selection(for: line) else { return }
                selectedLine = selection
                openCommentComposer()
            }
        case let .fold(fold):
            Button {
                expandedFolds.insert(fold.id)
                rebuildRows()
            } label: {
                ReviewCollapsedRow(
                    title: fold.hiddenCount == 1 ? "1 unchanged line" : "\(fold.hiddenCount) unchanged lines",
                    systemImage: "arrow.up.and.down",
                    minimumWidth: minimumWidth
                )
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows the hidden lines")
        case let .gap(_, hiddenCount, heading):
            ReviewCollapsedRow(
                title: hiddenCount == 1 ? "1 unchanged line" : "\(hiddenCount) unchanged lines",
                subtitle: heading,
                systemImage: "ellipsis",
                minimumWidth: minimumWidth
            )
        }
    }

    /// One number column wide enough for the file's largest line number.
    private var numberWidth: CGFloat {
        let digits = max(2, String(ReviewDiffLayout.largestLineNumber(in: renderedLines)).count)
        return digitWidth * CGFloat(digits) + 6
    }

    private func step(forward: Bool) {
        if forward { cursor.goNext() } else { cursor.goPrevious() }
        scrollRequest += 1
        PlatformHapticEngine.shared.playSelection()
    }

    private func rebuildRows() {
        rows = ReviewDiffLayout.rows(for: renderedLines, expanded: expandedFolds)
        changeIDs = ReviewDiffLayout.changeRowIDs(in: rows)
        cursor.update(count: changeIDs.count)
    }

    // MARK: - Commenting

    private var commentComposer: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Label {
                    Text(FeatureReviewLineSelection.chipTitle(for: selectedLine))
                } icon: {
                    Image(systemName: selectedLine == nil ? "doc" : "text.line.first.and.arrowtriangle.forward")
                }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(T3Colors.textPrimary)
                .padding(.leading, 10)
                .padding(.trailing, selectedLine == nil ? 10 : 4)
                .padding(.vertical, 5)
                .background(T3Colors.subtle, in: Capsule())
                .overlay(alignment: .trailing) {
                    if selectedLine != nil {
                        Button {
                            selectedLine = nil
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(T3Colors.textTertiary)
                        }
                        .buttonStyle(.plain)
                        .offset(x: 20)
                        .accessibilityLabel("Comment on the whole file")
                    }
                }
                Spacer(minLength: 8)
                Button {
                    closeComposer()
                } label: {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(T3Colors.textSecondary)
                .accessibilityLabel("Close review comment")
            }

            TextField("What should change?", text: $comment, axis: .vertical)
                .font(T3Typography.composer)
                .lineLimit(2 ... 6)
                .focused($isCommentFocused)

            if let commentError {
                Text(commentError)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.danger)
            }

            HStack(spacing: 10) {
                Button {
                    UIPasteboard.general.string = reviewDraft.prompt
                    T3HUD.show("Copied Prompt", systemImage: "doc.on.doc")
                } label: {
                    Label("Copy Prompt", systemImage: "doc.on.doc")
                }
                .t3SecondaryButtonStyle()
                .disabled(trimmedComment.isEmpty)

                Spacer()

                Button(action: sendComment) {
                    ZStack {
                        Circle().fill(T3Colors.primaryAction)
                        if isSending {
                            ProgressView()
                                .tint(T3Colors.primaryActionForeground)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(T3Colors.primaryActionForeground)
                        }
                    }
                    .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                    .opacity(trimmedComment.isEmpty ? 0.35 : 1)
                }
                .buttonStyle(.plain)
                .disabled(trimmedComment.isEmpty || isSending)
                .accessibilityLabel("Send to Agent")
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .t3GlassEffect(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .t3GlassRim(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }

    private var trimmedComment: String {
        comment.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var reviewDraft: FeatureReviewCommentDraft {
        FeatureReviewCommentDraft(filePath: file.path, line: selectedLine, body: comment)
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

    private func closeComposer() {
        isCommenting = false
        isCommentFocused = false
        commentError = nil
    }

    private func hydrate() async {
        rebuildRows()
        await highlight(renderedLines)
        isHydrating = true
        defer { isHydrating = false }
        guard let contents = try? await client.loadReviewFileContents(
            threadID: threadID,
            file: file
        ) else {
            return
        }
        let hydrated = FeatureFullDiffHydrator.lines(for: file, contents: contents)
        guard !Task.isCancelled else { return }
        renderedLines = hydrated
        rebuildRows()
        await highlight(hydrated)
    }

    /// Syntax colors, computed once per set of lines off the main thread.
    private func highlight(_ lines: [FeatureDiffLine]) async {
        guard let language = FeatureSourceHighlighter.language(forPath: file.path), !lines.isEmpty else { return }
        let spans = await Task.detached(priority: .userInitiated) {
            ReviewDiffSyntax.spans(for: lines, language: language)
        }.value
        guard !Task.isCancelled else { return }
        syntaxSpans = spans
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
                closeComposer()
                T3HUD.show("Sent to Agent", systemImage: "paperplane.fill")
            } catch {
                commentError = error.localizedDescription
                PlatformHapticEngine.shared.play(.error)
            }
            isSending = false
        }
    }
}

/// A fold or a gap between hunks: the unchanged lines that are not shown.
private struct ReviewCollapsedRow: View {
    let title: String
    var subtitle: String?
    let systemImage: String
    let minimumWidth: CGFloat

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
                .font(.caption.weight(.semibold))
            Text(title)
                .font(.footnote.weight(.medium))
            if let subtitle {
                Text(subtitle)
                    .font(T3Typography.tool)
                    .foregroundStyle(T3Colors.textTertiary)
                    .lineLimit(1)
            }
        }
        .foregroundStyle(T3Colors.accent)
        .padding(.horizontal, 12)
        .frame(width: minimumWidth, alignment: .leading)
        .frame(minHeight: 32)
        .background(T3Colors.accent.opacity(0.08))
        .contentShape(Rectangle())
    }
}

struct FeatureDiffLineRow: View {
    let line: FeatureDiffLine
    /// Syntax colors for the line, when the file's language is known.
    var syntax: [FeatureSourceSpan]?
    let isSelected: Bool
    let minimumWidth: CGFloat
    var numberWidth: CGFloat = 48
    /// Old and new numbers side by side at regular width; one column (the new
    /// number, or the old one for a deletion) on an iPhone.
    var showsBothNumbers = true
    /// Pull request diffs select lines by tapping; Review uses a context menu,
    /// which a text selection's long press would fight.
    var allowsTextSelection = true
    var select: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if line.kind == .hunk {
                Text(line.text)
                    .foregroundStyle(T3Colors.accent)
                    .padding(.horizontal, 10)
                    .fixedSize(horizontal: true, vertical: false)
            } else {
                if showsBothNumbers {
                    lineNumber(line.oldLine)
                    lineNumber(line.newLine)
                } else {
                    lineNumber(line.newLine ?? line.oldLine)
                }
                Text(prefix)
                    .foregroundStyle(prefixColor)
                    .frame(width: 16)
                diffText
                    .fixedSize(horizontal: true, vertical: false)
                    .modifier(FeatureDiffTextSelection(isEnabled: allowsTextSelection))
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
        .modifier(FeatureDiffLineInteraction(select: select))
    }

    private func lineNumber(_ value: Int?) -> some View {
        Text(value.map(String.init) ?? "")
            .foregroundStyle(.tertiary)
            .frame(width: numberWidth, alignment: .trailing)
            .padding(.trailing, 6)
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
        case .addition: T3Colors.diffAddition
        case .deletion: T3Colors.diffDeletion
        case .context, .hunk: .secondary
        }
    }

    /// Word-level changes win over syntax colors on a changed line: what
    /// changed is the point of a diff.
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
        } else if let syntax, !syntax.isEmpty {
            syntax.reduce(Text("")) { output, span in
                output + Text(verbatim: span.text).foregroundColor(syntaxColor(span.kind))
            }
        } else {
            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(.primary)
        }
    }

    private func syntaxColor(_ kind: FeatureSourceTokenKind) -> Color {
        switch kind {
        case .plain: T3Colors.textPrimary.opacity(0.92)
        case .comment: T3Colors.textTertiary
        case .keyword: T3Colors.syntaxKeyword
        case .literal: T3Colors.syntaxLiteral
        case .number: T3Colors.syntaxNumber
        case .property: T3Colors.syntaxProperty
        }
    }

    private var changedSpanBackground: Color {
        switch line.kind {
        case .addition: T3Colors.diffAddition.opacity(0.28)
        case .deletion: T3Colors.diffDeletion.opacity(0.28)
        case .context, .hunk: Color.clear
        }
    }

    private var background: Color {
        switch line.kind {
        case .addition: T3Colors.diffAddition.opacity(0.11)
        case .deletion: T3Colors.diffDeletion.opacity(0.11)
        case .hunk: T3Colors.accent.opacity(0.08)
        case .context: Color.clear
        }
    }
}

private struct FeatureDiffLineInteraction: ViewModifier {
    let select: (() -> Void)?
    @ViewBuilder func body(content: Content) -> some View {
        if let select {
            content.onTapGesture(perform: select).accessibilityAction(named: "Add review comment", select)
        } else { content }
    }
}

private struct FeatureDiffTextSelection: ViewModifier {
    let isEnabled: Bool
    @ViewBuilder func body(content: Content) -> some View {
        if isEnabled {
            content.textSelection(.enabled)
        } else {
            content
        }
    }
}
