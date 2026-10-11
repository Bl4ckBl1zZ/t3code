import Foundation

struct FeatureLimitAccount: Identifiable, Equatable, Sendable {
    let id: String
    let provider: String
    let driver: String
    let plan: String?
    var environments: [String]
    var limits: ServerProviderUsageLimits?
    struct ResetTarget: Equatable, Sendable {
        let environmentID: String
        var instanceID: String? = nil
        var sourceID: String? = nil
        var accountID: String? = nil
        var creditID: String? = nil
    }
    var resetTarget: ResetTarget? = nil
}

struct FeatureEnvironmentLimits: Sendable {
    let id: String
    let label: String
    let providers: [ServerProviderSnapshot]
    var sources: [UsageLimitSourceSnapshot] = []
}

enum FeatureUsageLimitsMerge {
    static let redeemableDrivers: Set<String> = ["codex", "claudeAgent"]

    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    /// Ported from `accountIdentityResolver` in usageLimits.logic.ts. Keys a
    /// report by the account it draws on. One email can belong to several
    /// workspaces, each with its own quota, so a report that names its
    /// workspace is keyed by it too. One that does not (a hub, an older
    /// server) joins the only workspace known for its email, and gets no key
    /// when there are several, since it cannot say which one it read.
    struct AccountIdentityResolver {
        private var workspacesByEmail: [String: Set<String>] = [:]

        init(_ reports: [(driver: String, email: String?, workspaceID: String?)]) {
            for report in reports {
                guard let key = Self.emailKey(report.driver, report.email),
                      let workspace = report.workspaceID, !workspace.isEmpty else { continue }
                workspacesByEmail[key, default: []].insert(workspace)
            }
        }

        func identity(driver: String, email: String?, workspaceID: String?) -> String? {
            guard let key = Self.emailKey(driver, email) else { return nil }
            if let workspaceID, !workspaceID.isEmpty { return "\(key):\(workspaceID)" }
            guard let known = workspacesByEmail[key] else { return key }
            return known.count == 1 ? known.first.map { "\(key):\($0)" } : nil
        }

        private static func emailKey(_ driver: String, _ email: String?) -> String? {
            let normalized = email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
            return normalized.isEmpty ? nil : "\(driver):\(normalized)"
        }
    }

    static func merge(_ environments: [FeatureEnvironmentLimits]) -> [FeatureLimitAccount] {
        var accounts: [String: FeatureLimitAccount] = [:]
        // Every enabled login counts, read or not, so an unreadable workspace
        // still counts as one.
        let resolver = AccountIdentityResolver(environments.flatMap { environment in
            environment.providers.filter(\.enabled).map { ($0.driver, $0.auth.email, $0.auth.workspaceId) }
                + environment.sources.flatMap(\.accounts).map { ($0.driver, $0.email, $0.workspaceId) }
        })
        for environment in environments.sorted(by: { $0.id < $1.id }) {
            for provider in environment.providers where provider.enabled {
                // Unknown identity stays separate: collapsing two unnamed accounts
                // would claim quota the server cannot prove they share.
                let key = resolver.identity(driver: provider.driver, email: provider.auth.email, workspaceID: provider.auth.workspaceId)
                    ?? "\(provider.driver):instance:\(environment.id):\(provider.instanceId)"
                // Codex and Claude redeem banked resets through the owning
                // instance; servers only report credits where redemption works.
                let resetTarget: FeatureLimitAccount.ResetTarget? = FeatureUsageLimitsMerge.redeemableDrivers.contains(provider.driver)
                    && provider.usageLimits?.resetCredits != nil
                    ? .init(environmentID: environment.id, instanceID: provider.instanceId) : nil
                if var account = accounts[key] {
                    if !account.environments.contains(environment.label) { account.environments.append(environment.label) }
                    if (date(provider.usageLimits?.checkedAt) ?? .distantPast) > (date(account.limits?.checkedAt) ?? .distantPast) {
                        account.limits = provider.usageLimits
                        account.resetTarget = resetTarget
                    }
                    accounts[key] = account
                } else {
                    accounts[key] = .init(id: key, provider: FeatureAccountLabel.display(provider.displayName, fallback: provider.driver), driver: provider.driver, plan: provider.auth.label.flatMap { $0.contains("@") ? nil : $0 }, environments: [environment.label], limits: provider.usageLimits, resetTarget: resetTarget)
                }
            }
            for source in environment.sources {
                for member in source.accounts {
                    let key = resolver.identity(driver: member.driver, email: member.email, workspaceID: member.workspaceId)
                        ?? "\(member.driver):hub:\(environment.id):\(source.id):\(member.id)" + (member.workspaceId.map { ":\($0)" } ?? "")
                    let label = "\(environment.label) · \(source.label)"
                    let resetTarget = member.usageLimits.resetCredits?.nextCreditId.map {
                        FeatureLimitAccount.ResetTarget(environmentID: environment.id, sourceID: source.id, accountID: member.id, creditID: $0)
                    }
                    if var account = accounts[key] {
                        if !account.environments.contains(label) { account.environments.append(label) }
                        if (date(member.usageLimits.checkedAt) ?? .distantPast) > (date(account.limits?.checkedAt) ?? .distantPast) {
                            account.limits = member.usageLimits
                            account.resetTarget = resetTarget
                        }
                        accounts[key] = account
                    } else {
                        accounts[key] = .init(id: key, provider: FeatureAccountLabel.display(member.id, fallback: member.driver), driver: member.driver, plan: member.plan,
                            environments: [label], limits: member.usageLimits, resetTarget: resetTarget)
                    }
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
                let pooled = poolKey(driver: account.driver, window: window)
                // An account with two windows of one kind keeps the second apart.
                let key = grouped[pooled]?.contains { $0.0.id == account.id } == true
                    ? "\(account.driver):\(window.id):\(window.windowDurationMins ?? 0)"
                    : pooled
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


extension FeatureUsageLimitsMerge {
    /// Codex ids are slots, not allowances: a weekly-only plan reports its
    /// weekly window as `primary`, other plans as `secondary`. Its windows pool
    /// by kind; other drivers' ids name distinct allowances.
    static func poolKey(driver: String, window: ServerProviderUsageLimits.Window) -> String {
        driver == "codex"
            ? "codex:\(window.kind)"
            : "\(driver):\(window.id):\(window.windowDurationMins ?? 0)"
    }

    /// Antigravity reports a five-hour and a weekly window per model group
    /// (`gemini-5h`, `gemini-weekly`, `<family>-quota`, ...): each group's
    /// windows stay together, Gemini first. Other drivers keep the server's order.
    static func displayOrder(driver: String, windows: [ServerProviderUsageLimits.Window]) -> [ServerProviderUsageLimits.Window] {
        guard driver == "antigravity" else { return windows }
        func group(_ id: String) -> String {
            id.replacingOccurrences(of: #"-(5h|weekly|quota)$"#, with: "", options: .regularExpression)
        }
        func kindRank(_ kind: String) -> Int { windowKindOrder.firstIndex(of: kind) ?? windowKindOrder.count }
        return windows.enumerated().sorted { left, right in
            let (l, r) = (left.element, right.element)
            let lGemini = l.id.hasPrefix("gemini-"), rGemini = r.id.hasPrefix("gemini-")
            if lGemini != rGemini { return lGemini }
            if group(l.id) != group(r.id) { return group(l.id) < group(r.id) }
            if kindRank(l.kind) != kindRank(r.kind) { return kindRank(l.kind) < kindRank(r.kind) }
            return left.offset < right.offset
        }.map(\.element)
    }

    /// `WINDOW_KIND_ORDER`: shortest window first.
    private static let windowKindOrder = ["session", "weekly", "monthly", "other"]
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
