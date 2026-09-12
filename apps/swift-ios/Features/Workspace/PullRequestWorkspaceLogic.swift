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
              ["ready", "updated", "newest", "oldest", "largest", "smallest"].contains(decoded.sort),
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
