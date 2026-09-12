import Foundation

public struct HostResourcesSnapshot: Codable, Equatable, Sendable {
    public let sampledAt: Double
    public let cpuUtilization: Double?
    public let cpuCount: Int
    public let availableMemoryBytes: Double
    public let totalMemoryBytes: Double
}

struct LoadBalancingCandidate: Sendable {
    let environmentID: String
    let resources: HostResourcesSnapshot?
    /// Milliseconds on this client; host clocks are not compared across machines.
    let receivedAt: Double
    let weight: Double
}

enum LoadBalancedEnvironment {
    static func choose(_ candidates: [LoadBalancingCandidate], now: Double) -> String? {
        var selected: String?
        var bestScore = 0.0
        for candidate in candidates {
            guard let resources = candidate.resources,
                  candidate.weight.isFinite, candidate.weight > 0,
                  now - candidate.receivedAt <= 15_000, candidate.receivedAt <= now + 5_000,
                  let cpu = resources.cpuUtilization, cpu.isFinite, cpu >= 0, cpu < 0.95,
                  resources.cpuCount > 0, resources.totalMemoryBytes > 0 else { continue }
            let available = resources.availableMemoryBytes / resources.totalMemoryBytes
            guard available.isFinite, available > 0.05 else { continue }
            let score = candidate.weight * Double(resources.cpuCount) * (1 - cpu) * available
            if score > bestScore { selected = candidate.environmentID; bestScore = score }
        }
        return selected
    }
}
