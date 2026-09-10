import SwiftUI
import UIKit

struct PullRequestCodeView: View {
    let number: Int
    let updatedAt: String
    let commits: [PullRequestCommit]
    let load: (Int, String?, String?) async throws -> PullRequestDiffResult
    let reviewDraft: PullRequestReviewDraftModel?
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
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }
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
                                PullRequestCodeFileView(file: file, reviewDraft: reviewDraft, canComment: canComment && selectedCommit == nil)
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
        .task(id: "\(number):\(updatedAt):\(selectedCommit ?? "all")") { await refresh() }
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
    @State private var commentingLine: FeatureDiffLine?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 6) {
                Text(file.path).font(T3Typography.supporting.monospaced()).textSelection(.enabled)
                if let previous = file.previousPath, previous != file.path {
                    Text("Renamed from \(previous)").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                }
                FeatureDiffStatsLabel(additions: file.additions, deletions: file.deletions)
            }.padding(.horizontal, 16)
            if file.lines.isEmpty {
                ContentUnavailableView("No text diff", systemImage: "doc", description: Text(file.change == .binary ? "This is a binary file." : "The host did not include text hunks for this file."))
            } else {
                GeometryReader { geometry in
                    ScrollView([.horizontal, .vertical]) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(file.lines) { line in
                                FeatureDiffLineRow(line: line, isSelected: false, minimumWidth: geometry.size.width,
                                    select: canComment && PullRequestReviewDraftModel.position(line) != nil ? { commentingLine = line } : nil)
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
}
