import Foundation
import Observation

/// One pull request's review guide as the detail screen holds it: the last
/// result, a write in flight, and the diff its excerpts are cut from.
///
/// A run takes minutes on the server, so the screen polls while it is running
/// instead of holding a request open. A reload never clears `data`; a failed
/// refresh shows beside the guide it already has.
@MainActor @Observable
final class PullRequestReviewGuideModel {
    private(set) var data: PullRequestReviewGuideResult?
    private(set) var error: String?
    private(set) var startError: String?
    private(set) var starting = false
    /// The server predates guides: the method is unknown or its answer does
    /// not decode. The Guide tab hides rather than showing an error forever.
    private(set) var unsupported = false
    /// The pull request's diff, read in pages until a stop's files are in.
    let diff = PullRequestCodeModel()
    private var diffLoaded = false
    private var diffHead: String?

    let number: Int
    private let access: FeaturePullRequestReviewGuideAccess

    init(number: Int, access: FeaturePullRequestReviewGuideAccess) {
        self.number = number
        self.access = access
    }

    var running: Bool { starting || PullRequestReviewGuideState(data).running }
    var state: PullRequestReviewGuideState { PullRequestReviewGuideState(data) }
    var notice: PullRequestReviewGuideNotice {
        PullRequestReviewGuideNotice(data: data, running: running, startError: startError, error: error)
    }

    func refresh() async {
        do {
            let result = try await access.load(number)
            guard !Task.isCancelled else { return }
            data = result
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            if Self.isUnsupported(error) { unsupported = true }
            self.error = error.localizedDescription
        }
    }

    /// Polls every five seconds for as long as a run is in progress and the
    /// caller's task lives; the screen ties that task to being on screen.
    func pollWhileRunning() async {
        while running, !Task.isCancelled {
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            await refresh()
        }
    }

    func write() async {
        guard !running else { return }
        starting = true
        startError = nil
        defer { starting = false }
        do {
            data = try await access.generate(number)
            error = nil
        } catch {
            startError = error.localizedDescription
        }
    }

    /// Reads diff pages until every path is loaded or the host has no more.
    /// The diff is reread when the guide moves to a new head.
    func loadFiles(_ paths: [String], load: @escaping (String?, String?) async throws -> PullRequestDiffResult) async {
        let head = data?.currentHeadSha ?? data?.guide?.headSha
        if !diffLoaded || diffHead != head || (diff.error != nil && diff.files.isEmpty) {
            diffLoaded = true
            diffHead = head
            await diff.refresh(commit: nil, load: load)
        }
        // Another stop's read may hold the model; it carries on with its own pages.
        while !Task.isCancelled, !diff.loading, diff.error == nil, diff.nextCursor != nil,
              paths.contains(where: { path in !diff.files.contains { $0.path == path || $0.previousPath == path } }) {
            await diff.loadMore(commit: nil, load: load)
        }
    }

    func file(_ path: String) -> FeatureReviewFile? {
        diff.files.first { $0.path == path } ?? diff.files.first { $0.previousPath == path }
    }

    static func isUnsupported(_ error: any Error) -> Bool {
        if case RPCError.unsupportedMethod = error { return true }
        return error is DecodingError
    }
}
