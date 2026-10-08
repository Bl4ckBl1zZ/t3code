import SwiftUI
import UIKit

/// A turn's changed files, shown under the reply that ended it. Ported from
/// `AssistantChangedFilesSection` and ChangedFilesTree.tsx on web.
struct ThreadChangedFiles: Equatable {
    let checkpointID: String
    /// The checkpoint turn item this card stands in for.
    let checkpointItemID: String
    let runID: String
    let files: [OrchestrationV2CheckpointFileSummary]
    /// The thread's latest run: its card opens on its own when small enough
    /// and previews its files when closed.
    let isLatestRun: Bool
    let date: Date?

    var id: String { "changed-files:\(checkpointItemID)" }

    var totals: ThreadWorkLogDiffStat {
        ThreadWorkLogDiffStat(
            additions: files.reduce(0) { $0 + $1.additions },
            deletions: files.reduce(0) { $0 + $1.deletions }
        )
    }

    static let autoExpandFileLimit = 5
    static let autoExpandLineLimit = 200

    /// Web's `shouldAutoExpandChangedFiles`: only the latest run, and only a
    /// change small enough to read at a glance.
    var autoExpands: Bool {
        guard isLatestRun, files.count <= Self.autoExpandFileLimit else { return false }
        let stat = totals
        return stat.additions + stat.deletions <= Self.autoExpandLineLimit
    }
}

/// Where each run's changed files go: under the last assistant reply of that
/// run, like web. A run without a reply on screen keeps its checkpoint row in
/// the work log, so the change is never dropped.
enum ThreadChangedFilesPlacement {
    struct Result: Equatable {
        /// Assistant turn-item id to the card that follows it.
        var byAssistantItemID: [String: ThreadChangedFiles] = [:]
        /// Checkpoint turn items now shown as a card instead of a work row.
        var placedCheckpointItemIDs: Set<String> = []
    }

    static func resolve(
        timelineItems: [OrchestrationV2ProjectedTurnItem],
        latestRunID: String?,
        rendersMessage: (String) -> Bool
    ) -> Result {
        var checkpointByRunID: [String: OrchestrationV2TurnItem] = [:]
        var replyByRunID: [String: OrchestrationV2TurnItem] = [:]
        for projected in timelineItems {
            let item = projected.item
            guard let runID = item.base.runId else { continue }
            switch item.payload {
            case let .checkpoint(_, _, files) where !files.isEmpty:
                checkpointByRunID[runID] = item
            case .assistantMessage where rendersMessage(item.id):
                replyByRunID[runID] = item
            default:
                break
            }
        }
        var result = Result()
        for (runID, checkpoint) in checkpointByRunID {
            guard let reply = replyByRunID[runID],
                  case let .checkpoint(checkpointID, _, files) = checkpoint.payload else { continue }
            result.byAssistantItemID[reply.id] = ThreadChangedFiles(
                checkpointID: checkpointID,
                checkpointItemID: checkpoint.id,
                runID: runID,
                files: files,
                isLatestRun: runID == latestRunID,
                // The reply's own time, so a day divider never lands between
                // the two.
                date: ThreadTimelineDay.date(fromISO8601: reply.base.startedAt ?? reply.base.updatedAt)
            )
            result.placedCheckpointItemIDs.insert(checkpoint.id)
        }
        return result
    }
}

// MARK: - Tree

/// Ported from apps/web/src/lib/turnDiffTree.ts: directories first, then files,
/// each sorted by name; a directory with a single subdirectory and nothing
/// else compacts into one `a/b` row.
struct ChangedFilesTreeNode: Equatable, Identifiable {
    enum Kind: Equatable { case directory, file }

    let kind: Kind
    let name: String
    let path: String
    let additions: Int
    let deletions: Int
    /// `added`, `deleted`, ...: the checkpoint's own word for a file.
    var fileKind: String? = nil
    var children: [ChangedFilesTreeNode] = []

    var id: String { "\(kind == .directory ? "dir" : "file"):\(path)" }

    static func build(_ files: [OrchestrationV2CheckpointFileSummary]) -> [ChangedFilesTreeNode] {
        final class Directory {
            let name: String
            let path: String
            var additions = 0
            var deletions = 0
            var directories: [String: Directory] = [:]
            var files: [ChangedFilesTreeNode] = []
            init(name: String, path: String) { self.name = name; self.path = path }
        }

        let root = Directory(name: "", path: "")
        for file in files {
            let segments = file.path.replacingOccurrences(of: "\\", with: "/")
                .split(separator: "/", omittingEmptySubsequences: true)
                .map(String.init)
            guard let fileName = segments.last else { continue }
            var ancestors = [root]
            var current = root
            for segment in segments.dropLast() {
                if let existing = current.directories[segment] {
                    current = existing
                } else {
                    let created = Directory(
                        name: segment,
                        path: current.path.isEmpty ? segment : "\(current.path)/\(segment)"
                    )
                    current.directories[segment] = created
                    current = created
                }
                ancestors.append(current)
            }
            current.files.append(ChangedFilesTreeNode(
                kind: .file,
                name: fileName,
                path: segments.joined(separator: "/"),
                additions: file.additions,
                deletions: file.deletions,
                fileKind: file.kind
            ))
            for ancestor in ancestors {
                ancestor.additions += file.additions
                ancestor.deletions += file.deletions
            }
        }

        func byName(_ left: String, _ right: String) -> Bool {
            left.localizedStandardCompare(right) == .orderedAscending
        }

        func nodes(_ directory: Directory) -> [ChangedFilesTreeNode] {
            let directories = directory.directories.values
                .sorted { byName($0.name, $1.name) }
                .map { child in
                    compact(ChangedFilesTreeNode(
                        kind: .directory,
                        name: child.name,
                        path: child.path,
                        additions: child.additions,
                        deletions: child.deletions,
                        children: nodes(child)
                    ))
                }
            return directories + directory.files.sorted { byName($0.name, $1.name) }
        }

        func compact(_ node: ChangedFilesTreeNode) -> ChangedFilesTreeNode {
            var node = node
            while node.children.count == 1, let only = node.children.first, only.kind == .directory {
                node = ChangedFilesTreeNode(
                    kind: .directory,
                    name: "\(node.name)/\(only.name)",
                    path: only.path,
                    additions: only.additions,
                    deletions: only.deletions,
                    children: only.children
                )
            }
            return node
        }

        return nodes(root)
    }

    /// One row of the tree as drawn: a node at its depth.
    struct Line: Equatable, Identifiable {
        let node: ChangedFilesTreeNode
        let depth: Int
        let isExpanded: Bool

        var id: String { node.id }
    }

    /// The rows an expansion state shows, top to bottom. Children of a closed
    /// directory are never visited, so a large closed tree costs its top level.
    static func lines(
        _ nodes: [ChangedFilesTreeNode],
        isExpanded: (String) -> Bool
    ) -> [Line] {
        var result: [Line] = []
        func visit(_ nodes: [ChangedFilesTreeNode], depth: Int) {
            for node in nodes {
                let expanded = node.kind == .directory && isExpanded(node.path)
                result.append(Line(node: node, depth: depth, isExpanded: expanded))
                if expanded { visit(node.children, depth: depth + 1) }
            }
        }
        visit(nodes, depth: 0)
        return result
    }

    static func containsDirectory(_ nodes: [ChangedFilesTreeNode]) -> Bool {
        nodes.contains { $0.kind == .directory }
    }
}

/// Trees by checkpoint, so a card's body does not rebuild its tree on every
/// toggle or reconfigure. A checkpoint's files never change once captured.
@MainActor
private enum ChangedFilesTreeCache {
    private static var trees: [String: [ChangedFilesTreeNode]] = [:]
    private static var order: [String] = []
    private static let limit = 32

    static func tree(for files: ThreadChangedFiles) -> [ChangedFilesTreeNode] {
        let key = "\(files.checkpointID):\(files.files.count)"
        if let cached = trees[key] { return cached }
        let built = ChangedFilesTreeNode.build(files.files)
        trees[key] = built
        order.append(key)
        if order.count > limit { trees.removeValue(forKey: order.removeFirst()) }
        return built
    }
}

// MARK: - Card

/// "N changed files +a −d" over a directory tree of the change. Opens on its
/// own for a small change in the latest run; otherwise the latest run shows a
/// preview of where the change landed, and older runs a single closed row.
struct ChangedFilesTreeCard: View {
    let files: ThreadChangedFiles
    let currentThreadID: String
    let workspaceRoot: String?
    let onOpenFile: (ThreadActivityFileOpenRequest) -> Void
    let onOpenDiff: (String, String?) -> Void

    /// Rows drawn before "Show more": enough for any ordinary change, and a
    /// bound on what one cell lays out for a sweeping one.
    static let initialLineLimit = 120

    @SwiftUI.Environment(\.threadWorkLogHistory) private var sharedHistory
    @State private var localHistory = ThreadWorkLogHistoryStore()
    @State private var lineLimit = Self.initialLineLimit

    private var store: ThreadWorkLogHistoryStore { sharedHistory ?? localHistory }
    private var key: String { "\(currentThreadID):\(files.id)" }
    /// The card's own fold and each directory's, against the expand-all default.
    private var history: ThreadWorkLogHistory { store.entry(key) }
    private var allDirectoriesHistory: ThreadWorkLogHistory { store.entry("\(key):all") }

    private var isExpanded: Bool { history.groupExpanded ?? files.autoExpands }
    private var allDirectoriesExpanded: Bool { allDirectoriesHistory.groupExpanded ?? files.autoExpands }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if isExpanded {
                Divider().overlay(ChatTimelineStyle.hairline)
                tree
            } else if files.isLatestRun {
                Divider().overlay(ChatTimelineStyle.hairline)
                preview
            }
        }
        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, ChatTimelineStyle.entrySpacing)
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            Button(action: toggleCard) {
                HStack(spacing: 8) {
                    TimelineDisclosureChevron(isExpanded: isExpanded)
                    Text(verbatim: "\(files.files.count) changed \(files.files.count == 1 ? "file" : "files")")
                        .font(ChatTimelineStyle.bodyStrong)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    WorkRowDiffStat(additions: files.totals.additions, deletions: files.totals.deletions)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget + 4, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                "\(files.files.count) changed \(files.files.count == 1 ? "file" : "files"), "
                    + "\(files.totals.additions) additions, \(files.totals.deletions) deletions"
            )
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
            .accessibilityAddTraits(.isButton)

            if isExpanded, hasDirectories {
                Button(action: toggleAllDirectories) {
                    Image(systemName: allDirectoriesExpanded ? "rectangle.compress.vertical" : "rectangle.expand.vertical")
                        .font(ChatTimelineStyle.small.weight(.semibold))
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders")
            }

            Button("Open Diff") { onOpenDiff(files.checkpointID, nil) }
                .font(ChatTimelineStyle.bodyStrong)
                .t3SecondaryButtonStyle()
                .buttonBorderShape(.capsule)
                .controlSize(.small)
        }
        .padding(.leading, 12)
        .padding(.trailing, 10)
    }

    // MARK: Preview

    /// Where the change landed and up to three files, one per area first.
    private var preview: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: ChangedFilesPreview.summarizeScopes(files.files)
                .map { "\($0.label) · \($0.fileCount) \($0.fileCount == 1 ? "file" : "files")" }
                .joined(separator: "   "))
                .font(ChatTimelineStyle.small)
                .foregroundStyle(T3Colors.textTertiary)
                .lineLimit(2)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) { previewChips }
                VStack(alignment: .leading, spacing: 6) { previewChips }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var previewChips: some View {
        ForEach(ChangedFilesPreview.preview(files.files), id: \.path) { file in
            Button { onOpenDiff(files.checkpointID, file.path) } label: {
                Label(ChangedFilesPreview.fileName(file.path), systemImage: "doc.text")
                    .font(ChatTimelineStyle.smallMono)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(T3Colors.subtle, in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .contextMenu { fileMenu(path: file.path, kind: file.kind) }
            .accessibilityLabel("Open diff for \(ChangedFilesPreview.fileName(file.path))")
        }
        if files.files.count > ChangedFilesPreview.fileLimit {
            Button("Show All \(files.files.count)", action: toggleCard)
                .font(ChatTimelineStyle.smallStrong)
                .foregroundStyle(T3Colors.textSecondary)
                .buttonStyle(.plain)
                .frame(minHeight: T3Metrics.minimumTapTarget)
        }
    }

    // MARK: Tree

    private var hasDirectories: Bool {
        ChangedFilesTreeNode.containsDirectory(ChangedFilesTreeCache.tree(for: files))
    }

    @ViewBuilder
    private var tree: some View {
        let nodes = ChangedFilesTreeCache.tree(for: files)
        let expansion = history.rowExpansion
        let allExpanded = allDirectoriesExpanded
        let lines = ChangedFilesTreeNode.lines(nodes) {
            expansion.isExpanded($0, expandedByDefault: allExpanded)
        }
        // Files sit one chevron's width in from their folder, but a flat list
        // needs no indent at all.
        let indentsFiles = ChangedFilesTreeNode.containsDirectory(nodes)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(lines.prefix(lineLimit)) { line in
                switch line.node.kind {
                case .directory: directoryRow(line)
                case .file: fileRow(line, indentsFiles: indentsFiles)
                }
            }
            if lines.count > lineLimit {
                Button("Show \(min(Self.initialLineLimit, lines.count - lineLimit)) More") {
                    lineLimit += Self.initialLineLimit
                }
                .font(ChatTimelineStyle.bodyStrong)
                .foregroundStyle(T3Colors.textSecondary)
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget)
            }
        }
        .padding(.vertical, 4)
    }

    private func indent(_ depth: Int) -> CGFloat { 12 + CGFloat(depth) * 14 }

    private func directoryRow(_ line: ChangedFilesTreeNode.Line) -> some View {
        Button {
            history.rowExpansion.toggle(line.node.path, expandedByDefault: allDirectoriesExpanded)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(ChatTimelineStyle.small.weight(.semibold))
                    .foregroundStyle(T3Colors.textTertiary)
                    .rotationEffect(.degrees(line.isExpanded ? 90 : 0))
                    .frame(width: 14)
                Image(systemName: line.isExpanded ? "folder" : "folder.fill")
                    .font(ChatTimelineStyle.small)
                    .foregroundStyle(T3Colors.textTertiary)
                Text(verbatim: line.node.name)
                    .font(ChatTimelineStyle.smallMono)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                WorkRowDiffStat(additions: line.node.additions, deletions: line.node.deletions)
            }
            .padding(.leading, indent(line.depth))
            .padding(.trailing, 12)
            .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Folder \(line.node.name), \(line.node.additions) additions, \(line.node.deletions) deletions")
        .accessibilityValue(line.isExpanded ? "Expanded" : "Collapsed")
        .accessibilityAddTraits(.isButton)
    }

    private func fileRow(_ line: ChangedFilesTreeNode.Line, indentsFiles: Bool) -> some View {
        let node = line.node
        return Button { onOpenDiff(files.checkpointID, node.path) } label: {
            HStack(spacing: 6) {
                if indentsFiles { Color.clear.frame(width: 14, height: 1) }
                Image(systemName: "doc.text")
                    .font(ChatTimelineStyle.small)
                    .foregroundStyle(T3Colors.textTertiary)
                Text(verbatim: node.name)
                    .font(ChatTimelineStyle.smallMono)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let badge = Self.kindBadge(node.fileKind) {
                    Text(verbatim: badge)
                        .font(ChatTimelineStyle.micro.weight(.medium))
                        .foregroundStyle(T3Colors.textSecondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(T3Colors.subtle, in: Capsule())
                }
                WorkRowDiffStat(additions: node.additions, deletions: node.deletions)
            }
            .padding(.leading, indent(line.depth))
            .padding(.trailing, 12)
            .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu { fileMenu(path: node.path, kind: node.fileKind) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            [node.name, Self.kindBadge(node.fileKind), "\(node.additions) additions, \(node.deletions) deletions"]
                .compactMap { $0 }
                .joined(separator: ", ")
        )
        .accessibilityHint("Opens the diff.")
        .accessibilityAddTraits(.isButton)
        .accessibilityActions { fileMenu(path: node.path, kind: node.fileKind) }
    }

    @ViewBuilder
    private func fileMenu(path: String, kind: String?) -> some View {
        Button("Open Diff", systemImage: "plusminus") { onOpenDiff(files.checkpointID, path) }
        // A deleted file has nothing left in the workspace to open.
        if !Self.isDeletion(kind) {
            Button("Open File", systemImage: "doc.text") {
                onOpenFile(ThreadActivityFileOpenRequest(
                    relativePath: ThreadWorkspaceFilePath.relative(workspaceRoot: workspaceRoot, target: path) ?? path,
                    line: nil
                ))
            }
        }
        Button("Copy Path", systemImage: "doc.on.doc") {
            UIPasteboard.general.string = path
            T3HUD.show("Copied", systemImage: "doc.on.doc")
        }
    }

    // MARK: Actions

    private func toggleCard() {
        withAnimation(.snappy) { history.groupExpanded = !isExpanded }
    }

    /// Resets every folder to the new default, as web does.
    private func toggleAllDirectories() {
        allDirectoriesHistory.groupExpanded = !allDirectoriesExpanded
        history.rowExpansion = ThreadWorkLogExpansion()
        lineLimit = Self.initialLineLimit
    }

    static func isDeletion(_ kind: String?) -> Bool {
        ["deleted", "removed"].contains(kind?.lowercased() ?? "")
    }

    /// Sentence case, and nothing for an ordinary modification.
    static func kindBadge(_ kind: String?) -> String? {
        guard let kind else { return nil }
        switch kind.lowercased() {
        case "modified", "": return nil
        case "added", "created": return "New"
        case "deleted", "removed": return "Deleted"
        case "renamed": return "Renamed"
        default: return kind.prefix(1).uppercased() + kind.dropFirst()
        }
    }
}
