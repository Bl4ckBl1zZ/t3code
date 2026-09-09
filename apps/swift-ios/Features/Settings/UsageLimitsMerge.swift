import Foundation

struct FeatureLimitAccount: Identifiable, Equatable, Sendable {
    let id: String
    let provider: String
    let driver: String
    let plan: String?
    var environments: [String]
    var limits: ServerProviderUsageLimits?
}

struct FeatureEnvironmentLimits: Sendable {
    let id: String
    let label: String
    let providers: [ServerProviderSnapshot]
}

enum FeatureUsageLimitsMerge {
    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    static func merge(_ environments: [FeatureEnvironmentLimits]) -> [FeatureLimitAccount] {
        var accounts: [String: FeatureLimitAccount] = [:]
        for environment in environments.sorted(by: { $0.id < $1.id }) {
            for provider in environment.providers where provider.enabled {
                // Unknown identity stays separate: collapsing two unnamed accounts
                // would claim quota the server cannot prove they share.
                let email = provider.auth.email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let identity = email.flatMap { $0.isEmpty ? nil : $0 } ?? "instance:\(environment.id):\(provider.instanceId)"
                let key = "\(provider.driver):\(identity)"
                if var account = accounts[key] {
                    if !account.environments.contains(environment.label) { account.environments.append(environment.label) }
                    if (date(provider.usageLimits?.checkedAt) ?? .distantPast) > (date(account.limits?.checkedAt) ?? .distantPast) {
                        account.limits = provider.usageLimits
                    }
                    accounts[key] = account
                } else {
                    accounts[key] = .init(id: key, provider: FeatureAccountLabel.display(provider.displayName, fallback: provider.driver), driver: provider.driver, plan: provider.auth.label.flatMap { $0.contains("@") ? nil : $0 }, environments: [environment.label], limits: provider.usageLimits)
                }
            }
        }
        return accounts.values.sorted { ($0.provider, $0.id) < ($1.provider, $1.id) }
    }
}

struct FeatureLimitPoolWindow: Identifiable {
    let id: String
    let label: String
    let accountCount: Int
    let usedPercent: Double
}

extension FeatureUsageLimitsMerge {
    /// Equal account shares, not token capacity: different subscription plans
    /// do not publish comparable absolute quotas.
    static func pools(_ accounts: [FeatureLimitAccount]) -> [FeatureLimitPoolWindow] {
        var grouped: [String: [(FeatureLimitAccount, ServerProviderUsageLimits.Window)]] = [:]
        for account in accounts {
            guard let limits = account.limits, limits.unavailable == nil else { continue }
            for window in limits.windows where window.usedPercent.isFinite {
                let key = "\(account.driver):\(window.id):\(window.windowDurationMins ?? 0)"
                grouped[key, default: []].append((account, window))
            }
        }
        return grouped.sorted { $0.key < $1.key }.compactMap { key, members in
            guard members.count > 1, let first = members.first else { return nil }
            return .init(id: key, label: "\(first.0.driver) · \(first.1.label)", accountCount: members.count,
                         usedPercent: members.reduce(0) { $0 + min(100, max(0, $1.1.usedPercent)) } / Double(members.count))
        }
    }
}


enum FeatureAccountLabel {
    static func display(_ name: String?, fallback: String) -> String {
        guard let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty, !name.contains("@") else { return fallback }
        return name
    }
}


extension FeatureUsageLimitsMerge {
    struct ComparisonWindow: Identifiable {
        let id: String
        let windowID: String
        let duration: Int?
        let label: String
    }

    static func comparisonWindows(_ accounts: [FeatureLimitAccount]) -> [ComparisonWindow] {
        var seen: Set<String> = []
        return accounts.flatMap { $0.limits?.windows ?? [] }.compactMap { window in
            let id = "\(window.id):\(window.windowDurationMins.map(String.init) ?? "unknown")"
            guard seen.insert(id).inserted else { return nil }
            return ComparisonWindow(id: id, windowID: window.id, duration: window.windowDurationMins, label: window.label)
        }.sorted { ($0.duration ?? 0, $0.id) < ($1.duration ?? 0, $1.id) }
    }
}
