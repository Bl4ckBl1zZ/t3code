import Foundation

/// A primary badge may only become terminal after every linked request has answered as terminal.
enum FeatureLinkedPullRequestSettlement {
    static func aggregate(_ reads: [FeaturePullRequest?]) -> FeaturePullRequest? {
        let known = reads.compactMap { $0 }
        guard var result = known.first(where: { $0.state == "open" }) ?? known.first else { return nil }
        if result.state == "open" { return result }
        guard known.count == reads.count,
              known.allSatisfy({ $0.state == "closed" || $0.state == "merged" }) else {
            result.state = "unknown"
            return result
        }
        // If merge settlement is disabled, a mixed closed/merged collection must stay active.
        result.state = known.contains(where: { $0.state == "merged" }) ? "merged" : "closed"
        result.updatedAt = known.compactMap(\.updatedAt).max()
        return result
    }
}
