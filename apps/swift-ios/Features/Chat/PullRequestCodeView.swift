import SwiftUI
import UIKit

/// The Code tab: the changed files as a tree, filtered by the detail screen's
/// search field, with a commit picker in the section header. Each file pushes
/// its diff.
struct PullRequestCodeView: View {
    let number: Int
    let updatedAt: String
    let refreshRevision: Int
    let commits: [PullRequestCommit]
    /// The detail screen's `.searchable` text.
    let search: String
    let load: (Int, String?, String?) async throws -> PullRequestDiffResult
    let fileContents: ((PullRequestDiffFileInput) async throws -> PullRequestDiffFileContents)?
    let reviewDraft: PullRequestReviewDraftModel?
    let conversations: PullRequestConversationContext
    let canComment: Bool
    @State private var model = PullRequestCodeModel()
    @State private var selectedCommit: String?
    @State private var collapsed = Set<String>()

    private var rows: [PullRequestCodeTreeRow] {
        PullRequestCodeTreeRow.rows(files: model.files, collapsed: collapsed, search: search)
    }

    private var fileCountLabel: String {
        let count = model.files.count
        return "\(count)\(model.nextCursor == nil ? "" : "+") \(count == 1 && model.nextCursor == nil ? "File" : "Files")"
    }

    var body: some View {
        let rows = rows
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(fileCountLabel)
                    .font(T3Typography.supporting)
                    .monospacedDigit()
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer(minLength: 8)
                if !commits.isEmpty { commitMenu }
            }
            .padding(.horizontal, 16)

            if !rows.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        ThreadSheetCardRow(showsDivider: index > 0, dividerInset: 16 + CGFloat(min(row.depth, 5)) * 12) {
                            treeRow(row)
                                .padding(.leading, CGFloat(min(row.depth, 5)) * 12)
                        }
                    }
                }
                .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }

            if let error = model.error {
                HStack {
                    Label(error, systemImage: "exclamationmark.circle")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.danger)
                    Spacer(minLength: 8)
                    Button("Retry") { Task {
                        if model.nextCursor != nil { await more() } else { await refresh() }
                    } }
                    .buttonStyle(.bordered)
                    .tint(T3Colors.textPrimary)
                    .disabled(model.loading)
                }
                .padding(.horizontal, 16)
            }

            if model.loading {
                ProgressView().frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget)
            } else if model.files.isEmpty && model.error == nil {
                ContentUnavailableView("No Changed Files", systemImage: "doc.text",
                    description: Text("The host returned no changed files."))
            } else if rows.isEmpty, !search.isEmpty {
                ContentUnavailableView.search(text: search)
            }

            if model.nextCursor != nil, !model.loading {
                Button("Load More Files") { Task { await more() } }
                    .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget)
            }

            VStack(alignment: .leading, spacing: 4) {
                if selectedCommit != nil && canComment {
                    Text("Choose All Commits to add line comments against the current pull request.")
                }
                if model.truncated {
                    Text("The host withheld some hunks or binary contents. Reported file counts are still shown.")
                }
            }
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textTertiary)
            .padding(.horizontal, 16)
        }
        .task(id: "\(number):\(updatedAt):\(selectedCommit ?? "all"):\(refreshRevision)") { await refresh() }
        .onChange(of: commits.map(\.oid)) { _, ids in
            if let selectedCommit, !ids.contains(selectedCommit) { self.selectedCommit = nil }
        }
    }

    private var commitMenu: some View {
        Menu {
            Picker("Changes", selection: $selectedCommit) {
                Text("All Commits").tag(String?.none)
                ForEach(commits.reversed(), id: \.oid) { commit in
                    Text("\(commit.oid.prefix(7)) · \(commit.messageHeadline)").tag(Optional(commit.oid))
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(selectedCommit.map { String($0.prefix(7)) } ?? "All Commits")
                Image(systemName: "chevron.up.chevron.down").imageScale(.small)
            }
            .font(T3Typography.supporting)
            .frame(minHeight: T3Metrics.minimumTapTarget)
        }
        .accessibilityLabel("Commit")
    }

    @ViewBuilder
    private func treeRow(_ row: PullRequestCodeTreeRow) -> some View {
        if let file = row.file {
            NavigationLink {
                PullRequestCodeFileView(file: file, reviewDraft: reviewDraft, canComment: canComment && selectedCommit == nil, conversations: conversations, commit: selectedCommit, fileContents: fileContents)
            } label: {
                HStack(spacing: 8) {
                    FeatureReviewFileRow(file: file)
                    ThreadSheetDisclosure()
                }
            }
            .buttonStyle(.plain)
        } else {
            Button {
                if !collapsed.insert(row.name).inserted { collapsed.remove(row.name) }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(T3Colors.textTertiary)
                        .rotationEffect(.degrees(row.expanded ? 90 : 0))
                    Image(systemName: "folder").foregroundStyle(T3Colors.textSecondary)
                    Text(row.name.split(separator: "/").last.map(String.init) ?? row.name)
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(row.expanded ? "Expanded" : "Collapsed")
            .disabled(!search.isEmpty)
        }
    }

    private func refresh() async {
        await model.refresh(commit: selectedCommit) { cursor, commit in try await load(number, cursor, commit) }
    }
    private func more() async {
        await model.loadMore(commit: selectedCommit) { cursor, commit in try await load(number, cursor, commit) }
    }
}

private struct PullRequestCodeFileView: View {
    let file: FeatureReviewFile
    let reviewDraft: PullRequestReviewDraftModel?
    let canComment: Bool
    let conversations: PullRequestConversationContext
    let commit: String?
    let fileContents: ((PullRequestDiffFileInput) async throws -> PullRequestDiffFileContents)?
    @SwiftUI.Environment(\.pullRequestSelectionHandoff) private var selectionHandoff
    @State private var selectingLines = false
    @State private var selectionStart: String?
    @State private var selectionEnd: String?
    private var selectedLines: Set<String> {
        guard let selectionStart, let start = displayedLines.firstIndex(where: { $0.id == selectionStart }),
              let end = displayedLines.firstIndex(where: { $0.id == (selectionEnd ?? selectionStart) }) else { return [] }
        return Set(displayedLines[min(start, end)...max(start, end)].map(\.id))
    }
    private var codeSelection: PullRequestHandoffSelection? {
        guard let selectionStart else { return nil }
        return .code(file: file, lines: displayedLines, firstID: selectionStart, lastID: selectionEnd ?? selectionStart, commit: commit)
    }
    private func selectLine(_ line: FeatureDiffLine) {
        if selectionStart == nil || selectionEnd != nil { selectionStart = line.id; selectionEnd = nil }
        else { selectionEnd = line.id }
    }
    @State private var fullContents: PullRequestDiffFileContents?
    @State private var hydratedLines: [FeatureDiffLine]?
    @State private var fullContext = false
    @State private var loadingContext = false
    @State private var contextError: String?
    private var displayedLines: [FeatureDiffLine] { fullContext ? hydratedLines ?? file.lines : file.lines }
    private var fileThreads: [PullRequestReviewThread] { conversations.threads.filter { $0.path == file.path } }
    private var placed: [String: [PullRequestReviewThread]] {
        Dictionary(grouping: fileThreads.compactMap { thread -> (String, PullRequestReviewThread)? in
            PullRequestThreadPlacement.anchor(thread: thread, file: file, commit: commit).map { ($0, thread) }
        }, by: { $0.0 }).mapValues { $0.map { $0.1 } }
    }
    @State private var commentingLine: FeatureDiffLine?
    var body: some View {
        let originalPositions = Set(file.lines.map(PullRequestFullContext.positionKey))
        let selectedIDs = selectedLines
        let placedThreads = placed
        let unplacedThreads = fileThreads.filter { PullRequestThreadPlacement.anchor(thread: $0, file: file, commit: commit) == nil }
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 6) {
                Text(file.path).font(T3Typography.tool).foregroundStyle(T3Colors.textSecondary).textSelection(.enabled)
                FeatureDiffStatsLabel(additions: file.additions, deletions: file.deletions)
                if let previous = file.previousPath, previous != file.path {
                    Text("Renamed from \(previous)").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                }
                if let contextError {
                    ThreadSheetBanner(tone: .warning, title: contextError)
                        .padding(12)
                        .background(ThreadSheetBannerTone.warning.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
            .padding(.horizontal, 16)
            if fullContext, let fullContents, hydratedLines == nil {
                PullRequestFileVersionsView(contents: fullContents)
            } else if displayedLines.isEmpty {
                ContentUnavailableView("No text diff", systemImage: "doc", description: Text(file.change == .binary ? "This is a binary file." : "The host did not include text hunks for this file."))
            } else {
                GeometryReader { geometry in
                    ScrollView([.horizontal, .vertical]) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(displayedLines) { line in
                                FeatureDiffLineRow(line: line, isSelected: selectedIDs.contains(line.id), minimumWidth: geometry.size.width,
                                    select: selectingLines && line.kind != .hunk ? { selectLine(line) } : canComment && originalPositions.contains(PullRequestFullContext.positionKey(line)) && PullRequestReviewDraftModel.position(line) != nil ? { commentingLine = line } : nil)
                                ForEach(placedThreads[line.id] ?? []) { thread in
                                    conversation(thread).frame(width: geometry.size.width).padding(.vertical, 8)
                                }
                            }
                            if !unplacedThreads.isEmpty {
                                Text(commit == nil ? "Conversations outside these hunks" : "PR conversations · not attached to this commit")
                                    .font(T3Typography.supportingStrong).frame(width: geometry.size.width).padding(.vertical, 12)
                            }
                            ForEach(unplacedThreads) { thread in
                                conversation(thread).frame(width: geometry.size.width).padding(.vertical, 8)
                            }
                        }
                    }
                }
            }
        }
        .background(T3Colors.background)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if selectingLines { selectionBar }
        }
        .sheet(item: $commentingLine) { line in
            if let reviewDraft { PullRequestLineCommentSheet(file: file, line: line, draft: reviewDraft) }
        }
        .navigationTitle(file.path.split(separator: "/").last.map(String.init) ?? file.path)
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .onChange(of: fullContext) { _, _ in selectionStart = nil; selectionEnd = nil }
        .toolbar {
            if selectionHandoff != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(selectingLines ? "Done Selecting" : "Select Lines", systemImage: "text.line.first.and.arrowtriangle.forward") {
                        selectingLines.toggle(); selectionStart = nil; selectionEnd = nil
                    }
                    .disabled(displayedLines.isEmpty || (fullContext && hydratedLines == nil))
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if loadingContext {
                    ProgressView()
                } else {
                    Menu {
                        Button("Copy Path", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = file.path
                            T3HUD.show("Copied", systemImage: "doc.on.doc")
                        }
                        if file.change != .binary, fileContents != nil {
                            Toggle(isOn: Binding(get: { fullContext }, set: { _ in Task { await toggleContext() } })) {
                                Label("Show Full File", systemImage: "doc.text.magnifyingglass")
                            }
                        }
                    } label: {
                        Label("More", systemImage: "ellipsis")
                    }
                }
            }
        }
    }

    /// Hint, the handoff for the chosen range, and Clear, floating over the diff.
    private var selectionBar: some View {
        HStack(spacing: 10) {
            Text(selectionStart == nil ? "Tap the first line, then the last line." : "\(selectedLines.count) selected · tap another line to set the range")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let selection = codeSelection { PullRequestSelectionMenu(selection: selection) }
            Button("Clear") { selectionStart = nil; selectionEnd = nil }
                .disabled(selectionStart == nil)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .t3GlassEffect(in: Capsule())
        .t3GlassRim(in: Capsule())
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private func toggleContext() async {
        if fullContext { fullContext = false; return }
        if fullContents != nil { fullContext = true; return }
        guard let fileContents, let input = PullRequestFullContext.input(file: file, commit: commit) else { return }
        loadingContext = true; contextError = nil
        defer { loadingContext = false }
        do {
            let contents = try await fileContents(input)
            guard !Task.isCancelled else { return }
            guard PullRequestFullContext.matchesPatch(file: file, contents: contents) else {
                contextError = "The file no longer matches this diff. Go back and refresh the pull request."
                return
            }
            fullContents = contents
            hydratedLines = PullRequestFullContext.lines(file: file, contents: contents)
            fullContext = true
        } catch { contextError = error.localizedDescription }
    }

    private func conversation(_ thread: PullRequestReviewThread) -> some View {
        PullRequestThreadCard(thread: thread, access: conversations.access, canReply: conversations.canReply,
            canResolve: conversations.canResolve, editing: conversations.editing, reactions: conversations.reactions, canEditComment: conversations.canEditComment, onReplied: conversations.refresh)
    }

}

private struct PullRequestFileVersionsView: View {
    let contents: PullRequestDiffFileContents
    @State private var side = "new"
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("The host omitted the hunks. These are file versions, not a reconstructed diff.")
                .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(.horizontal, 16)
            Picker("File version", selection: $side) {
                Text("Previous Version").tag("old"); Text("New Version").tag("new")
            }.pickerStyle(.segmented).padding(.horizontal, 16)
            ScrollView([.horizontal, .vertical]) {
                Text(verbatim: side == "old" ? contents.oldContents : contents.newContents)
                    .font(T3Typography.code).textSelection(.enabled).padding(12)
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}
