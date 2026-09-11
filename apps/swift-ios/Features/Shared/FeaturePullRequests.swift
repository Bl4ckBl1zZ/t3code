import Foundation

public struct FeaturePullRequestSnapshot: Sendable, Equatable, Hashable, Codable {
    public var state: String
    public var title: String
    public var headBranch: String
    public var baseBranch: String
    public var isDraft: Bool
    public var updatedAt: String?
    public var author: String?
    public var additions: Int?
    public var deletions: Int?
    public var checksState: String?
    public var reviewDecision: String?
    public var mergeability: String?
}

public struct FeaturePullRequestStack: Sendable, Equatable, Hashable, Codable {
    public var id: String
    public var number: Int
    public var url: String
    public var base: String
    public var numbers: [Int]
}

public struct FeatureLinkedPullRequest: Sendable, Equatable, Hashable, Codable {
    public var projectID: String
    public var repository: String
    public var number: Int
    public var url: String
    public var host: String?
    public var source: String?
    public var linkedAt: String?
    public var snapshot: FeaturePullRequestSnapshot?
    public var stack: FeaturePullRequestStack?

    public init(projectID: String, repository: String, number: Int, url: String,
                host: String? = nil, source: String? = nil, linkedAt: String? = nil,
                snapshot: FeaturePullRequestSnapshot? = nil, stack: FeaturePullRequestStack? = nil) {
        self.projectID = projectID
        self.repository = repository
        self.number = number
        self.url = url
        self.host = host
        self.source = source
        self.linkedAt = linkedAt
        self.snapshot = snapshot
        self.stack = stack
    }

    public var sourceLabel: String? {
        switch source {
        case "manual": "Linked by you"
        case "agent": "Linked by the agent"
        case "created": "Created from this thread"
        case "stack": "Found in the stack"
        default: nil
        }
    }

    public var identity: String {
        "\(host?.lowercased() ?? URL(string: url)?.host?.lowercased() ?? "")/\(repository.lowercased())#\(number)"
    }
}

public struct FeaturePullRequestLine: Identifiable, Sendable, Equatable {
    public var link: FeatureLinkedPullRequest
    public var depth: Int
    public var chainSize: Int
    public var isNativeStack: Bool
    public var id: String { link.identity }
}

/// Orders host-native stacks first by their host order, then infers remaining chains
/// from base branches. Ambiguous heads and cycles remain visible as independent requests.
public enum FeaturePullRequestLines {
    /// A single chain gets a layers badge; unrelated requests retain their own identities.
    public static func stackSize(_ input: [FeatureLinkedPullRequest]) -> Int? {
        let visible = input.filter { $0.source != "stack-dismissed" }
        guard visible.count > 1, let first = resolve(visible).first,
              first.chainSize == visible.count else { return nil }
        return visible.count
    }

    public static func resolve(_ input: [FeatureLinkedPullRequest]) -> [FeaturePullRequestLine] {
        let links = input.filter { $0.source != "stack-dismissed" }
        var placed = Set<String>()
        var chains: [(layers: [FeatureLinkedPullRequest], native: Bool)] = []
        func repositoryKey(_ link: FeatureLinkedPullRequest) -> String {
            "\(link.host?.lowercased() ?? URL(string: link.url)?.host?.lowercased() ?? "")/\(link.repository.lowercased())"
        }
        for link in links {
            guard let stack = link.stack, !placed.contains(link.identity) else { continue }
            let members = links.filter { repositoryKey($0) == repositoryKey(link) && $0.stack?.id == stack.id }
            let ordered = stack.numbers.compactMap { number in members.first { $0.number == number } }
            let extras = members.filter { candidate in !ordered.contains { $0.identity == candidate.identity } }
            let layers = ordered + extras
            for layer in layers { placed.insert(layer.identity) }
            if !layers.isEmpty { chains.append((layers, true)) }
        }
        let remaining = links.filter { !placed.contains($0.identity) }
        let byHead = Dictionary(grouping: remaining.filter { $0.snapshot != nil }) {
            "\(repositoryKey($0)):\($0.snapshot!.headBranch)"
        }
        func parent(_ link: FeatureLinkedPullRequest) -> FeatureLinkedPullRequest? {
            guard let snapshot = link.snapshot,
                  let candidates = byHead["\(repositoryKey(link)):\(snapshot.baseBranch)"],
                  candidates.count == 1, candidates[0].identity != link.identity else { return nil }
            return candidates[0]
        }
        let parents = Set(remaining.compactMap { parent($0)?.identity })
        for top in remaining where !parents.contains(top.identity) {
            var layers: [FeatureLinkedPullRequest] = []
            var cursor: FeatureLinkedPullRequest? = top
            while let link = cursor, !placed.contains(link.identity) {
                placed.insert(link.identity)
                layers.insert(link, at: 0)
                cursor = parent(link)
            }
            if !layers.isEmpty { chains.append((layers, false)) }
        }
        for link in remaining where !placed.contains(link.identity) { chains.append(([link], false)) }
        func latest(_ layers: [FeatureLinkedPullRequest]) -> String {
            layers.map { $0.snapshot?.updatedAt ?? $0.linkedAt ?? "" }.max() ?? ""
        }
        return chains.enumerated().sorted {
            let left = latest($0.element.layers), right = latest($1.element.layers)
            return left == right ? $0.offset < $1.offset : left > right
        }.flatMap { entry in
            entry.element.layers.enumerated().map { offset, link in
                FeaturePullRequestLine(link: link, depth: offset, chainSize: entry.element.layers.count, isNativeStack: entry.element.native)
            }
        }
    }
}
