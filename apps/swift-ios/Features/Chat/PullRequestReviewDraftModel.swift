import Foundation
import Observation

struct NativePullRequestPendingComment: Codable, Equatable, Identifiable {
    let id: UUID
    let comment: PullRequestReviewCommentDraft
}

/// Host review drafts are private until submitted. A failed submission preserves every word.
@MainActor @Observable
final class PullRequestReviewDraftModel {
    private struct Saved: Codable { var summary: String; var comments: [NativePullRequestPendingComment] }
    let key: String
    var summary: String { didSet { persist() } }
    private(set) var comments: [NativePullRequestPendingComment]
    private(set) var submitting = false
    private(set) var error: String?
    private let defaults: UserDefaults

    init(key: String, defaults: UserDefaults = .standard) {
        self.key = "swift-ios.pullRequests.reviewDraft.\(key)"
        self.defaults = defaults
        let saved = defaults.data(forKey: self.key).flatMap { try? JSONDecoder().decode(Saved.self, from: $0) }
        summary = saved?.summary ?? ""; comments = saved?.comments ?? []
    }

    func add(file: FeatureReviewFile, line: FeatureDiffLine, body: String) {
        guard Self.validBody(body), let position = Self.position(line) else { return }
        comments.append(.init(id: UUID(), comment: .init(path: file.path, oldPath: file.previousPath == file.path ? nil : file.previousPath, position: position, body: body)))
        persist()
    }

    func edit(_ id: UUID, body: String) {
        guard Self.validBody(body), let index = comments.firstIndex(where: { $0.id == id }) else { return }
        let old = comments[index].comment
        comments[index] = .init(id: id, comment: .init(path: old.path, oldPath: old.oldPath, position: old.position, body: body))
        persist()
    }

    func remove(_ id: UUID) { comments.removeAll { $0.id == id }; persist() }

    static func validBody(_ body: String) -> Bool {
        !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && body.utf16.count <= 65_536
    }

    static func position(_ line: FeatureDiffLine) -> PullRequestReviewPosition? {
        switch line.kind {
        case .addition:
            guard let new = line.newLine, new > 0 else { return nil }
            return .init(kind: "added", oldLine: nil, newLine: new, side: nil)
        case .deletion:
            guard let old = line.oldLine, old > 0 else { return nil }
            return .init(kind: "deleted", oldLine: old, newLine: nil, side: nil)
        case .context:
            guard let old = line.oldLine, let new = line.newLine, old > 0, new > 0 else { return nil }
            return .init(kind: "context", oldLine: old, newLine: new, side: "right")
        case .hunk: return nil
        }
    }

    static func verdicts(capabilities: NativePullRequestCapabilities?, viewer: NativePullRequestViewerPermissions?) -> [String] {
        ["comment", "approve", "request-changes"].filter { capabilities?.review?.verdicts.contains($0) == true && viewer?.verdicts?.contains($0) == true }
    }

    func canSubmit(_ verdict: String, offered: [String]) -> Bool {
        !submitting && offered.contains(verdict) && summary.utf16.count <= 65_536 &&
            (verdict == "approve" || Self.validBody(summary) || !comments.isEmpty)
    }

    func submit(verdict: String, offered: [String], send: (PullRequestReviewSubmission) async throws -> Void) async -> Bool {
        guard canSubmit(verdict, offered: offered) else { return false }
        let submittedSummary = summary, submittedComments = comments
        submitting = true; error = nil
        defer { submitting = false }
        do {
            try await send(.init(verdict: verdict, body: submittedSummary, comments: submittedComments.map(\.comment)))
            let sent = Dictionary(uniqueKeysWithValues: submittedComments.map { ($0.id, $0.comment) })
            comments.removeAll { sent[$0.id] == $0.comment }
            if summary == submittedSummary { summary = "" }
            persist()
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    private func persist() {
        if summary.isEmpty && comments.isEmpty { defaults.removeObject(forKey: key); return }
        if let data = try? JSONEncoder().encode(Saved(summary: summary, comments: comments)) { defaults.set(data, forKey: key) }
    }
}
