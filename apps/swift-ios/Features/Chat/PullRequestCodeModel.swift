import Foundation
import Observation

/// Each page is scoped to the selected PR/commit. Stale requests cannot append to a newer diff.
@MainActor @Observable
final class PullRequestCodeModel {
    private(set) var files: [FeatureReviewFile] = []
    private(set) var loading = false
    private(set) var error: String?
    private(set) var nextCursor: String?
    private(set) var truncated = false
    private var generation = UUID()
    private var loadedCursors = Set<String>()

    func refresh(commit: String?, load: (String?, String?) async throws -> PullRequestDiffResult) async {
        generation = UUID()
        files = []; nextCursor = nil; truncated = false; loadedCursors = []
        await fetch(cursor: nil, commit: commit, load: load)
    }

    func loadMore(commit: String?, load: (String?, String?) async throws -> PullRequestDiffResult) async {
        guard !loading, let nextCursor else { return }
        await fetch(cursor: nextCursor, commit: commit, load: load)
    }

    private func fetch(cursor: String?, commit: String?, load: (String?, String?) async throws -> PullRequestDiffResult) async {
        let request = generation
        loading = true; error = nil
        defer { if generation == request { loading = false } }
        do {
            let result = try await load(cursor, commit)
            guard !Task.isCancelled, generation == request else { return }
            let source = ReviewDiffSource(id: cursor ?? "first", kind: "pull-request", title: "Pull request", baseRef: nil, headRef: nil, diff: result.patch, diffHash: "", truncated: result.truncated)
            var incoming = NativeUnifiedDiffMapper.parseDiff(source)
            for stat in result.omittedFileStats ?? [] {
                if let index = incoming.firstIndex(where: { $0.path == stat.path }) {
                    incoming[index].additions = stat.additions; incoming[index].deletions = stat.deletions
                } else {
                    incoming.append(FeatureReviewFile(path: stat.path, change: .modified, additions: stat.additions, deletions: stat.deletions))
                }
            }
            // Some hosts repeat a boundary file when a page is refreshed. Its authoritative
            // entry replaces the old one without duplicating paths or adding its counts twice.
            for file in incoming {
                if let index = files.firstIndex(where: { $0.path == file.path }) { files[index] = file }
                else { files.append(file) }
            }
            if let cursor { loadedCursors.insert(cursor) }
            truncated = truncated || result.truncated
            if let next = result.nextCursor, loadedCursors.contains(next) {
                nextCursor = nil
                error = "The host repeated a diff page. Refresh to try again."
            } else { nextCursor = result.nextCursor }
        } catch {
            guard !Task.isCancelled, generation == request else { return }
            self.error = error.localizedDescription
        }
    }
}

struct PullRequestCodeTreeRow: Identifiable {
    let id: String
    let name: String
    let depth: Int
    let file: FeatureReviewFile?
    let expanded: Bool

    static func rows(files: [FeatureReviewFile], collapsed: Set<String>, search: String) -> [Self] {
        let matching = files.filter { search.isEmpty || $0.path.localizedCaseInsensitiveContains(search) }
        var result: [Self] = []
        var directories = Set<String>()
        for file in matching.sorted(by: { $0.path.localizedStandardCompare($1.path) == .orderedAscending }) {
            let components = file.path.split(separator: "/").map(String.init)
            var hidden = false
            for index in 0..<max(0, components.count - 1) {
                let path = components.prefix(index + 1).joined(separator: "/")
                let expanded = !search.isEmpty || !collapsed.contains(path)
                if directories.insert(path).inserted {
                    result.append(Self(id: "directory:\(path)", name: path, depth: index, file: nil, expanded: expanded))
                }
                if !expanded { hidden = true; break }
            }
            if !hidden { result.append(Self(id: "file:\(file.path)", name: file.path, depth: max(0, components.count - 1), file: file, expanded: false)) }
        }
        return result
    }
}
