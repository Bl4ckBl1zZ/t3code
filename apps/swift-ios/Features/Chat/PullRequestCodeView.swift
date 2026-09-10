import SwiftUI
import UIKit

struct PullRequestCodeView: View {
    let number: Int
    let updatedAt: String
    let refreshRevision: Int
    let refreshHost: () async -> Void
    let commits: [PullRequestCommit]
    let load: (Int, String?, String?) async throws -> PullRequestDiffResult
    let fileContents: ((PullRequestDiffFileInput) async throws -> PullRequestDiffFileContents)?
    let reviewDraft: PullRequestReviewDraftModel?
    let conversations: PullRequestConversationContext
    let canComment: Bool
    @State private var model = PullRequestCodeModel()
    @State private var selectedCommit: String?
    @State private var search = ""
    @State private var collapsed = Set<String>()

    private var rows: [PullRequestCodeTreeRow] {
        PullRequestCodeTreeRow.rows(files: model.files, collapsed: collapsed, search: search)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !commits.isEmpty {
                Picker("Changes", selection: $selectedCommit) {
                    Text("All commits").tag(String?.none)
                    ForEach(commits.reversed(), id: \.oid) { commit in
                        Text("\(commit.oid.prefix(7)) · \(commit.messageHeadline)").tag(Optional(commit.oid))
                    }
                }
                .pickerStyle(.menu)
                .frame(minHeight: 44)
            }
            if selectedCommit != nil && canComment {
                Text("Choose All commits to add line comments against the current pull request.")
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
            }
            TextField("Filter changed files", text: $search)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(12).background(T3Colors.subtle, in: RoundedRectangle(cornerRadius: 10))
            HStack {
                Text("\(model.files.count) files\(model.nextCursor == nil ? "" : "+")")
                Spacer()
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await refreshHost() } }
                    .disabled(model.loading)
            }.font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
            if model.truncated {
                Text("The host withheld some hunks or binary contents. Reported file counts are still shown.")
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
            }
            LazyVStack(spacing: 0) {
                ForEach(rows) { row in
                    Group {
                        if let file = row.file {
                            NavigationLink {
                                PullRequestCodeFileView(file: file, reviewDraft: reviewDraft, canComment: canComment && selectedCommit == nil, conversations: conversations, commit: selectedCommit, fileContents: fileContents)
                            } label: {
                                FeatureReviewFileRow(file: file).frame(minHeight: 52)
                            }
                            .buttonStyle(.plain)
                        } else {
                            Button {
                                if !collapsed.insert(row.name).inserted { collapsed.remove(row.name) }
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: row.expanded ? "chevron.down" : "chevron.right").font(.caption)
                                    Image(systemName: "folder")
                                    Text(row.name.split(separator: "/").last.map(String.init) ?? row.name).lineLimit(1)
                                    Spacer()
                                }.font(T3Typography.supportingStrong).frame(minHeight: 44)
                            }.buttonStyle(.plain)
                                .accessibilityValue(row.expanded ? "Expanded" : "Collapsed")
                                .disabled(!search.isEmpty)
                        }
                    }
                    .padding(.leading, CGFloat(min(row.depth, 5)) * 12)
                    Divider()
                }
            }

            if let error = model.error {
                Text(error).font(T3Typography.supporting).foregroundStyle(T3Colors.warning)
                Button("Retry") { Task {
                    if model.nextCursor != nil { await more() } else { await refresh() }
                } }.disabled(model.loading)
            }
            if model.loading { ProgressView().frame(maxWidth: .infinity) }
            else if model.files.isEmpty && model.error == nil {
                Text("The host returned no changed files.").foregroundStyle(T3Colors.textSecondary)
            } else if rows.isEmpty {
                Text("No loaded files match this filter.").foregroundStyle(T3Colors.textSecondary)
            }
            if model.nextCursor != nil {
                Button("Load more files") { Task { await more() } }
                    .frame(minHeight: 44).disabled(model.loading)
            }
        }
        .task(id: "\(number):\(updatedAt):\(selectedCommit ?? "all"):\(refreshRevision)") { await refresh() }
        .onChange(of: commits.map(\.oid)) { _, ids in
            if let selectedCommit, !ids.contains(selectedCommit) { self.selectedCommit = nil }
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
        let placedThreads = placed
        let unplacedThreads = fileThreads.filter { PullRequestThreadPlacement.anchor(thread: $0, file: file, commit: commit) == nil }
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 6) {
                Text(file.path).font(T3Typography.supporting.monospaced()).textSelection(.enabled)
                if let previous = file.previousPath, previous != file.path {
                    Text("Renamed from \(previous)").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                }
                FeatureDiffStatsLabel(additions: file.additions, deletions: file.deletions)
            }.padding(.horizontal, 16)
            if file.change != .binary, fileContents != nil {
                Button(fullContext ? "Show changed hunks" : "Show full file context") { Task { await toggleContext() } }
                    .frame(minHeight: 44).disabled(loadingContext)
                if loadingContext { ProgressView() }
                if let contextError { Text(contextError).font(T3Typography.supporting).foregroundStyle(T3Colors.warning).padding(.horizontal, 16) }
            }
            if fullContext, let fullContents, hydratedLines == nil {
                PullRequestFileVersionsView(contents: fullContents)
            } else if displayedLines.isEmpty {
                ContentUnavailableView("No text diff", systemImage: "doc", description: Text(file.change == .binary ? "This is a binary file." : "The host did not include text hunks for this file."))
            } else {
                GeometryReader { geometry in
                    ScrollView([.horizontal, .vertical]) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(displayedLines) { line in
                                FeatureDiffLineRow(line: line, isSelected: false, minimumWidth: geometry.size.width,
                                    select: canComment && originalPositions.contains(PullRequestFullContext.positionKey(line)) && PullRequestReviewDraftModel.position(line) != nil ? { commentingLine = line } : nil)
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
        .sheet(item: $commentingLine) { line in
            if let reviewDraft { PullRequestLineCommentSheet(file: file, line: line, draft: reviewDraft) }
        }
        .navigationTitle(file.path.split(separator: "/").last.map(String.init) ?? file.path)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Copy path", systemImage: "document.on.document") { UIPasteboard.general.string = file.path }
            }
        }
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
            canResolve: conversations.canResolve, onReplied: conversations.refresh)
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
                Text("Previous version").tag("old"); Text("New version").tag("new")
            }.pickerStyle(.segmented).padding(.horizontal, 16)
            ScrollView([.horizontal, .vertical]) {
                Text(verbatim: side == "old" ? contents.oldContents : contents.newContents)
                    .font(T3Typography.code).textSelection(.enabled).padding(12)
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}
