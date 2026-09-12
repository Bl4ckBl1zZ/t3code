import Foundation
import Observation

@MainActor @Observable
final class PullRequestReviewerModel {
    private(set) var candidates: [PullRequestReviewerCandidate] = []
    private(set) var truncated = false
    private(set) var loading = false
    private(set) var pending: String?
    private(set) var error: String?
    func matching(_ query: String) -> [PullRequestReviewerCandidate] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return candidates.filter { query.isEmpty || $0.login.localizedCaseInsensitiveContains(query) || ($0.name?.localizedCaseInsensitiveContains(query) ?? false) }
    }
    func load(read: () async throws -> PullRequestReviewerCandidateList) async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let result = try await read()
            guard !Task.isCancelled else { return }
            candidates = result.candidates; truncated = result.truncated
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func toggle(_ candidate: PullRequestReviewerCandidate, send: (PullRequestReviewerRequest) async throws -> Void) async -> Bool {
        guard pending == nil, !loading, ["user", "team"].contains(candidate.kind) else { return false }
        pending = candidate.key; error = nil
        defer { pending = nil }
        let desired = !candidate.isRequested
        do {
            try await send(.init(reviewers: [.init(id: candidate.id, kind: candidate.kind)], requested: desired))
            if let index = candidates.firstIndex(where: { $0.key == candidate.key }) { candidates[index].isRequested = desired }
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
}
