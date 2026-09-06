import Foundation

/// Optional enrichment of ServerProviderSnapshot; an older server omits it.
public struct ServerProviderUsageLimits: Codable, Equatable, Sendable {
    public struct Window: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        public let kind: String
        public let label: String
        public let usedPercent: Double
        public let resetsAt: String?
        public let windowDurationMins: Int?
    }
    public struct Unavailable: Codable, Equatable, Sendable {
        public let reason: String
        public let message: String?
    }
    public let checkedAt: String
    public let windows: [Window]
    public let unavailable: Unavailable?
}
