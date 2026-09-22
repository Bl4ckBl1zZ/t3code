import Foundation

struct NativePullRequestRow: Identifiable, Equatable, Sendable {
    let environmentID: String
    var entry: PullRequestListEntry
    var sizeKnown = false
    var viewer: String?
    var id: String { entry.id }
    var projectID: String { FeatureScopedID.project(environmentID: environmentID, wireID: entry.projectId) }
    var group: Int {
        if let viewer, entry.author?.login.lowercased() == viewer.lowercased() { return 0 }
        return entry.viewerReviewRequested ? 1 : 2
    }
}

struct NativePullRequestPreferences: Codable, Equatable, Sendable {
    var environmentID: String?
    var projectID: String?
    var host: String?
    var state = "open"
    var involvement = "all"
    var query = ""
    var sort = "ready"
    var draft: String?
    var review: String?
    var checks: String?
    var author = ""
    var labels = ""
    var excludedLabels = ""

    static func read(_ value: String) -> Self {
        guard let data = value.data(using: .utf8), let decoded = try? JSONDecoder().decode(Self.self, from: data),
              ["all", "open", "closed", "merged"].contains(decoded.state),
              ["all", "authored", "reviewing"].contains(decoded.involvement),
              ["ready", "blocked", "updated", "newest", "oldest", "largest", "smallest"].contains(decoded.sort),
              decoded.draft.map({ ["only", "hide"].contains($0) }) ?? true,
              decoded.review.map({ ["approved", "changes-requested", "review-required", "none"].contains($0) }) ?? true,
              decoded.checks.map({ ["passing", "failing"].contains($0) }) ?? true else { return Self() }
        return decoded
    }

    var serialized: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
    var requestKey: String { var value = self; value.sort = "ready"; return value.serialized }

    func input(projectIDs: [String], involvement: String? = nil) -> PullRequestListInput {
        var input = PullRequestListInput()
        input.state = state
        input.involvement = involvement ?? self.involvement
        input.projectIds = projectIDs
        input.host = host
        input.query = Self.bounded(query)
        let labels = Self.qualifiers(labels)
        let excluded = Self.qualifiers(excludedLabels)
        let filters = PullRequestListFilters(draft: draft, review: review, checks: checks,
            labels: labels.isEmpty ? nil : [labels], excludedLabels: excluded.isEmpty ? nil : excluded, author: Self.bounded(author))
        if filters != PullRequestListFilters() { input.filters = filters }
        return input
    }

    private static func bounded(_ value: String) -> String? {
        let trimmed = String(value.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        return trimmed.isEmpty ? nil : trimmed
    }
    private static func qualifiers(_ value: String) -> [String] {
        Array(value.components(separatedBy: ",").compactMap(bounded).prefix(10))
    }
}

enum NativePullRequestWorkspaceLogic {
    static func assignedProjects(_ projects: [FeatureProject], environments: [FeatureEnvironment], preferences: NativePullRequestPreferences) -> [String: [String]] {
        let available = environments.filter { $0.supportsPullRequests == true && (preferences.environmentID == nil || $0.id == preferences.environmentID) }
            .sorted { lhs, rhs in lhs.isActive != rhs.isActive ? lhs.isActive : lhs.id < rhs.id }
        var seen = Set<String>()
        var assigned: [String: [String]] = [:]
        for environment in available {
            for project in projects.filter({ $0.environmentID == environment.id && (preferences.projectID == nil || $0.id == preferences.projectID) }).sorted(by: { $0.id < $1.id }) {
                if let canonical = project.repositoryCanonicalKey, !seen.insert(canonical.lowercased()).inserted { continue }
                assigned[environment.id, default: []].append(project.wireID ?? project.id)
            }
        }
        return assigned
    }

    static func sort(_ rows: [NativePullRequestRow], preferences: NativePullRequestPreferences) -> [NativePullRequestRow] {
        rows.sorted { left, right in
            if preferences.involvement == "all", left.group != right.group { return left.group < right.group }
            let a = left.entry, b = right.entry
            if !preferences.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let scores = (matchScore(a, preferences.query), matchScore(b, preferences.query))
                if scores.0 != scores.1 { return scores.0 > scores.1 }
            } else {
                switch preferences.sort {
                case "ready":
                    if tier(a) != tier(b) { return tier(a) < tier(b) }
                    if left.sizeKnown != right.sizeKnown { return left.sizeKnown }
                    if a.additions + a.deletions != b.additions + b.deletions { return a.additions + a.deletions < b.additions + b.deletions }
                case "blocked":
                    let tiers = (blockedTier(left, involvement: preferences.involvement), blockedTier(right, involvement: preferences.involvement))
                    if tiers.0 != tiers.1 { return tiers.0 < tiers.1 }
                case "newest": if a.createdAt != b.createdAt { return a.createdAt > b.createdAt }
                case "oldest": if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
                case "largest", "smallest":
                    if left.sizeKnown != right.sizeKnown { return left.sizeKnown }
                    let sizeA = a.additions + a.deletions, sizeB = b.additions + b.deletions
                    if sizeA != sizeB { return preferences.sort == "largest" ? sizeA > sizeB : sizeA < sizeB }
                default: break
                }
            }
            return a.updatedAt != b.updatedAt ? a.updatedAt > b.updatedAt : a.id < b.id
        }
    }

    static func tier(_ entry: PullRequestListEntry) -> Int {
        if entry.mergeability == .conflicting { return 4 }
        if entry.state != .open { return 3 }
        if entry.isDraft { return 2 }
        if entry.checksState == "passing", entry.reviewDecision == "approved" { return 0 }
        return entry.checksState == "passing" ? 1 : 2
    }

    /// "Blocked on me" order, newest first within a tier. Your own changes rank by how surely
    /// the next move is yours: conflicts, requested changes, failing checks, drafts, then
    /// changes waiting on others, with approved-and-passing and finished work last. Requested
    /// reviews put open changes first. Everyone else's changes follow the involvement filter,
    /// and keep recency order when it is "all".
    static func blockedTier(_ row: NativePullRequestRow, involvement: String) -> Int {
        let entry = row.entry
        switch row.group == 0 ? "authored" : row.group == 1 ? "reviewing" : involvement {
        case "authored":
            if entry.state != .open { return 6 }
            if entry.mergeability == .conflicting { return 0 }
            if entry.reviewDecision == "changes-requested" { return 1 }
            if entry.checksState == "failing" { return 2 }
            if entry.isDraft { return 3 }
            if entry.checksState == "passing", entry.reviewDecision == "approved" { return 5 }
            return 4
        case "reviewing":
            return entry.state == .open ? 0 : 1
        default:
            return 0
        }
    }

    static func matchScore(_ entry: PullRequestListEntry, _ query: String) -> Int {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let number = needle.hasPrefix("#") ? String(needle.dropFirst()) : needle
        if !number.isEmpty, number.allSatisfy(\.isNumber) { return String(entry.number) == number ? 100 : 0 }
        let title = entry.title.lowercased(), terms = needle.split(whereSeparator: \.isWhitespace).map(String.init)
        if title == needle { return 90 }
        if title.contains(needle) { return 80 }
        if terms.count > 1, terms.allSatisfy({ title.contains($0) }) { return 70 }
        if entry.headBranch.lowercased().contains(needle) { return 60 }
        if entry.author?.login.lowercased().contains(needle) == true { return 50 }
        if entry.repository.lowercased().contains(needle) { return 40 }
        return terms.contains(where: { title.contains($0) }) ? 30 : 10
    }
}

/// What a row says the moment an action is sent, before the host answers. The
/// host is the record and a later read replaces this, but a pull request closed
/// from an "open" list should leave it on the tap, not after the reads that
/// follow.
struct NativePullRequestOverride: Equatable, Sendable {
    let state: PullRequestState
    var isDraft: Bool?
    let updatedAt: String
    /// Which action wrote it, so a failure takes back its own note and not a
    /// later one's.
    let token: Int
    let at: Date
}

extension NativePullRequestWorkspaceLogic {
    /// How long a read that disagrees is taken for a stale one rather than for news.
    static let overrideTrust: TimeInterval = 60

    static func override(after action: NativePullRequestAction, entry: PullRequestListEntry, now: Date, token: Int) -> NativePullRequestOverride? {
        let updatedAt = now.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        func note(_ state: PullRequestState, isDraft: Bool? = nil) -> NativePullRequestOverride {
            NativePullRequestOverride(state: state, isDraft: isDraft, updatedAt: updatedAt, token: token, at: now)
        }
        switch action {
        case .close: return note(.closed)
        case .reopen: return note(.open)
        case .merge: return note(.merged)
        case .draft: return note(entry.state, isDraft: true)
        case .ready: return note(entry.state, isDraft: false)
        default: return nil
        }
    }

    /// The entry with its pending answer written over it, or nil when the
    /// list's state or draft filter no longer holds it.
    static func applying(_ override: NativePullRequestOverride, to entry: PullRequestListEntry, preferences: NativePullRequestPreferences) -> PullRequestListEntry? {
        if preferences.state != "all", override.state.rawValue != preferences.state { return nil }
        var entry = entry
        entry.state = override.state
        if let isDraft = override.isDraft { entry.isDraft = isDraft }
        entry.updatedAt = override.updatedAt
        if preferences.draft == "only", !entry.isDraft { return nil }
        if preferences.draft == "hide", entry.isDraft { return nil }
        return entry
    }

    /// The overrides an answer confirmed, dropped; the rest kept. A read that
    /// started before the action can land after it and still say the old
    /// thing, so an override clears when the answer agrees, not when one
    /// arrives. A missing row says nothing, since a page is only a page. A row
    /// in another state is taken for a stale read for a minute and for the
    /// host's news after that, which is how a pull request reopened elsewhere
    /// comes back.
    static func settle(_ overrides: [String: NativePullRequestOverride], answered: [PullRequestListEntry], now: Date) -> [String: NativePullRequestOverride] {
        guard !overrides.isEmpty else { return overrides }
        let byID = Dictionary(answered.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return overrides.filter { id, override in
            guard let row = byID[id] else { return true }
            let agrees = row.state == override.state && (override.isDraft == nil || row.isDraft == override.isDraft)
            return !agrees && now.timeIntervalSince(override.at) <= overrideTrust
        }
    }
}
