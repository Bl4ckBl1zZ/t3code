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
    public struct ResetCredits: Codable, Equatable, Sendable {
        public let availableCount: Int
        public let nextExpiresAt: String?
    }
    public let resetCredits: ResetCredits?
    public let checkedAt: String
    public let windows: [Window]
    public let unavailable: Unavailable?
}

public struct ProviderConsumeResetCreditResult: Codable, Equatable, Sendable {
    public let outcome: String
    public let warning: String?

    public var message: String {
        if let warning { return warning }
        switch outcome {
        case "reset": return "Reset applied. Your windows have cleared."
        case "nothingToReset": return "Nothing to reset right now."
        case "noCredit": return "No reset credit left."
        case "alreadyRedeemed": return "That credit was already redeemed."
        default: return "The provider reported: \(outcome). Refresh to check your limits."
        }
    }
}
