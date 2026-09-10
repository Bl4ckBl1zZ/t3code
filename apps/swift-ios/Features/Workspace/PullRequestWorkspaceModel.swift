import Foundation
import Observation

@MainActor
@Observable
final class NativePullRequestWorkspaceModel {
    private struct Lane: Sendable {
        let id: String
        let environmentID: String
        let environmentName: String
        var input: PullRequestListInput
    }
    private struct Page {
        var entries: [String: PullRequestListEntry]
        var result: PullRequestListResult
        var limit: Int
    }
    private enum Reply: Sendable {
        case success(Lane, PullRequestListResult)
        case failure(Lane, String)
    }
    private var lanes: [Lane] = []
    private var pages: [String: Page] = [:]
    private var failures: [String: String] = [:]
    private var stats: [String: PullRequestDiffStat] = [:]
    private var generation = UUID()
    private var statsGeneration = UUID()
    var listingRevision: UUID { generation }
    private(set) var loading = false
    private(set) var loadingStats = false

    var hosts: [String] { Set(pages.values.flatMap { $0.result.providers.map(\.host) }).sorted() }
    var hasMore: Bool { pages.values.contains { !$0.result.nextCursors.isEmpty || ($0.result.truncated && $0.limit < 500) } }
    var reachedHostLimit: Bool { pages.values.contains { $0.result.truncated && $0.result.nextCursors.isEmpty && $0.limit >= 500 } }
    var messages: [String] {
        var messages = Array(failures.values)
        for lane in lanes {
            guard let result = pages[lane.id]?.result else { continue }
            messages += result.errors.map { "\(lane.environmentName) · \($0.projectTitle): \($0.message)" }
            messages += result.providers.compactMap { provider in
                if !provider.configured { return "\(lane.environmentName) · \(provider.host): \(provider.detail ?? "Sign in on the environment to read this host.")" }
                return nil
            }
        }
        return Set(messages).sorted()
    }
    var localSearchHosts: [String] { Set(pages.values.flatMap { $0.result.providers.filter { !$0.searchesOnHost }.map(\.host) }).sorted() }

    func rows(preferences: NativePullRequestPreferences) -> [NativePullRequestRow] {
        var rows: [String: NativePullRequestRow] = [:]
        for lane in lanes {
            guard let page = pages[lane.id] else { continue }
            for entry in page.entries.values where rows[entry.id] == nil {
                var row = NativePullRequestRow(environmentID: lane.environmentID, entry: entry,
                    sizeKnown: entry.provider != "github" || entry.additions + entry.deletions > 0,
                    viewer: page.result.viewers[entry.host])
                if let measured = stats[Self.statKey(environmentID: lane.environmentID, projectID: entry.projectId, repository: entry.repository, number: entry.number)] {
                    row.entry.additions = measured.additions
                    row.entry.deletions = measured.deletions
                    row.sizeKnown = true
                }
                if !preferences.query.isEmpty, page.result.providers.first(where: { $0.host == entry.host })?.searchesOnHost == false,
                   NativePullRequestWorkspaceLogic.matchScore(entry, preferences.query) <= 10 { continue }
                rows[entry.id] = row
            }
        }
        return NativePullRequestWorkspaceLogic.sort(Array(rows.values), preferences: preferences)
    }

    func reload(manager: any FeatureProjectPullRequestManaging, environments: [FeatureEnvironment], projects: [FeatureProject], preferences: NativePullRequestPreferences) async {
        let assigned = NativePullRequestWorkspaceLogic.assignedProjects(projects, environments: environments, preferences: preferences)
        let order = environments.sorted { lhs, rhs in lhs.isActive != rhs.isActive ? lhs.isActive : lhs.id < rhs.id }
        lanes = order.flatMap { environment -> [Lane] in
            let ids = assigned[environment.id] ?? []
            // Read priority groups independently, so an older authored/review
            // request is not hidden behind the first page of unrelated work.
            let involvements = preferences.involvement == "all" ? ["authored", "reviewing", "all"] : [preferences.involvement]
            return stride(from: 0, to: ids.count, by: 100).flatMap { start in
                involvements.map { involvement in
                    Lane(id: "\(environment.id)|\(start)|\(involvement)", environmentID: environment.id, environmentName: environment.name,
                        input: preferences.input(projectIDs: Array(ids[start..<min(start + 100, ids.count)]), involvement: involvement))
                }
            }
        }
        pages = [:]
        failures = [:]
        stats = [:]
        await fetch(lanes, manager: manager, preferences: preferences, append: false)
    }

    func loadMore(manager: any FeatureProjectPullRequestManaging, preferences: NativePullRequestPreferences) async {
        guard !loading else { return }
        let requests = lanes.compactMap { lane -> Lane? in
            guard let page = pages[lane.id] else { return nil }
            var next = lane
            if !page.result.nextCursors.isEmpty { next.input.cursors = page.result.nextCursors; next.input.limit = page.limit }
            else if page.result.truncated && page.limit < 500 { next.input.limit = min(500, page.limit + 50) }
            else { return nil }
            return next
        }
        await fetch(requests, manager: manager, preferences: preferences, append: true)
    }

    private func fetch(_ requests: [Lane], manager: any FeatureProjectPullRequestManaging, preferences: NativePullRequestPreferences, append: Bool) async {
        let requestGeneration = UUID()
        generation = requestGeneration
        loading = true
        loadingStats = false
        defer { if generation == requestGeneration { loading = false } }
        // Four bounded requests at a time across all environments and groups.
        for start in stride(from: 0, to: requests.count, by: 4) {
            if Task.isCancelled || generation != requestGeneration { return }
            await withTaskGroup(of: Reply.self) { group in
                for lane in requests[start..<min(start + 4, requests.count)] {
                    group.addTask {
                        do { return .success(lane, try await manager.listPullRequests(environmentID: lane.environmentID, input: lane.input)) }
                        catch { return .failure(lane, error.localizedDescription) }
                    }
                }
                for await reply in group {
                    guard !Task.isCancelled, generation == requestGeneration else { group.cancelAll(); return }
                    switch reply {
                    case let .success(lane, result):
                        var entries = append ? pages[lane.id]?.entries ?? [:] : [:]
                        for entry in result.entries { entries[entry.id] = entry }
                        pages[lane.id] = Page(entries: entries, result: result, limit: lane.input.limit)
                        failures[lane.id] = nil
                    case let .failure(lane, message): failures[lane.id] = "\(lane.environmentName): \(message)"
                    }
                }
            }
        }
        guard !Task.isCancelled, generation == requestGeneration else { return }
        loading = false
    }

    func loadStats(visibleRowIDs: Set<String>, manager: any FeatureProjectPullRequestManaging, preferences: NativePullRequestPreferences) async {
        let listingGeneration = generation
        let requestGeneration = UUID()
        statsGeneration = requestGeneration
        let rowsByEnvironment = Dictionary(grouping: rows(preferences: preferences).filter { visibleRowIDs.contains($0.id) && !$0.sizeKnown }, by: \.environmentID)
        loadingStats = !rowsByEnvironment.isEmpty
        guard !rowsByEnvironment.isEmpty else { return }
        defer { if statsGeneration == requestGeneration { loadingStats = false } }
        for (environmentID, rows) in rowsByEnvironment.sorted(by: { $0.key < $1.key }) {
            for start in stride(from: 0, to: rows.count, by: 500) {
                guard !Task.isCancelled, generation == listingGeneration, statsGeneration == requestGeneration else { return }
                do {
                    let result = try await manager.pullRequestStats(environmentID: environmentID, entries: rows[start..<min(start + 500, rows.count)].map(\.entry))
                    guard !Task.isCancelled, generation == listingGeneration, statsGeneration == requestGeneration else { return }
                    for stat in result.stats { stats[Self.statKey(environmentID: environmentID, projectID: stat.projectId, repository: stat.repository, number: stat.number)] = stat }
                } catch {
                    // A failed enrichment keeps the row and its unknown size.
                    if Task.isCancelled { return }
                }
            }
        }
    }

    private static func statKey(environmentID: String, projectID: String, repository: String, number: Int) -> String {
        "\(environmentID)|\(projectID)|\(repository.lowercased())|\(number)"
    }
}
