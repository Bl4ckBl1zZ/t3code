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
        public var nextCreditId: String? = nil
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

public struct UsageLimitSourceConfig: Codable, Equatable, Sendable {
    public var kind: String = "cliproxy"
    public var label: String?
    public var url: String
    public var managementKey: String
    public var enabled: Bool = true
    public var json: JSONValue { .object([
        "kind": .string(kind), "url": .string(url), "managementKey": .string(managementKey),
        "enabled": .bool(enabled), "label": label.map(JSONValue.string) ?? .null
    ].filter { $0.key != "label" || label != nil }) }
}
public struct UsageLimitSourceSnapshot: Codable, Equatable, Sendable, Identifiable {
    public struct Account: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        public let driver: String
        public let email: String?
        public let plan: String?
        public let usageLimits: ServerProviderUsageLimits
    }
    public let id: String
    public let kind: String
    public let label: String
    public let checkedAt: String
    public let accounts: [Account]
    public let error: String?
}
