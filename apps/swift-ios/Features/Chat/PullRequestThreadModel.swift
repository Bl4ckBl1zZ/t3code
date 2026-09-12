import Foundation
import Observation

@MainActor @Observable
final class PullRequestThreadModel {
    private(set) var comments: [PullRequestThreadComment]
    private(set) var cursor: String?
    private(set) var resolved: Bool
    var reply = ""
    private(set) var pending = false
    private(set) var error: String?
    private let threadID: String
    private var cursors = Set<String>()

    init(thread: PullRequestReviewThread) {
        threadID = thread.id; comments = thread.comments; cursor = thread.nextCommentsCursor; resolved = thread.isResolved
    }

    func updateComment(id: String, body: String) {
        if let index = comments.firstIndex(where: { $0.id == id }) { comments[index].body = body }
    }

    func reconcile(_ thread: PullRequestReviewThread) {
        guard thread.id == threadID else { return }
        let freshIDs = Set(thread.comments.map(\.id))
        comments = thread.comments + comments.filter { !freshIDs.contains($0.id) }
        resolved = thread.isResolved
        if cursor == nil, let next = thread.nextCommentsCursor {
            cursor = next; cursors.remove(next)
        }
    }

    func loadMore(load: (String, String) async throws -> PullRequestThreadCommentsResult) async {
        guard !pending, let cursor else { return }
        pending = true; error = nil
        defer { pending = false }
        do {
            let result = try await load(threadID, cursor)
            for comment in result.comments {
                if let index = comments.firstIndex(where: { $0.id == comment.id }) { comments[index] = comment }
                else { comments.append(comment) }
            }
            cursors.insert(cursor)
            if let next = result.nextCursor, cursors.contains(next) {
                self.cursor = nil; error = "The host repeated a comment page. Refresh the pull request to try again."
            } else { self.cursor = result.nextCursor }
        } catch { self.error = error.localizedDescription }
    }

    func send(send: (String, String) async throws -> Void) async -> Bool {
        guard !pending, PullRequestReviewDraftModel.validBody(reply) else { return false }
        let body = reply
        pending = true; error = nil
        defer { pending = false }
        do {
            try await send(threadID, body)
            if reply == body { reply = "" }
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    func toggleResolution(send: (String, Bool) async throws -> Void) async {
        guard !pending else { return }
        let target = !resolved
        pending = true; error = nil
        defer { pending = false }
        do { try await send(threadID, target); resolved = target }
        catch { self.error = error.localizedDescription }
    }
}

/// A conversation belongs beside code only when that exact side/line is present in the PR diff.
enum PullRequestThreadPlacement {
    static func anchor(thread: PullRequestReviewThread, file: FeatureReviewFile, commit: String?) -> String? {
        guard commit == nil, !thread.isOutdated, thread.path == file.path, let number = thread.line else { return nil }
        return file.lines.first { line in
            guard line.kind != .hunk else { return false }
            switch thread.side {
            case "left": return line.oldLine == number
            case "right": return line.newLine == number
            default: return false
            }
        }?.id
    }
}
