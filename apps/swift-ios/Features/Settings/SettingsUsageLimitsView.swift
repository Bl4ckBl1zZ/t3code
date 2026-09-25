import SwiftUI

/// Subscription limits for every provider account across the saved servers:
/// one section per account with a gauge per window. The phone's answer to "am I
/// about to hit my quota?"; cost history and quota hubs live on the computer.
struct SettingsUsageLimitsView: View {
    @Bindable var model: FeatureRootModel
    @State private var refreshTrigger = UUID()
    @State private var accounts: [FeatureLimitAccount] = []
    @State private var notices: [String] = []
    @State private var isLoading = true
    @State private var unsupported = false

    private var selectedEnvironmentIDs: Set<String> { Set(model.snapshot.environments.map(\.id)) }

    var body: some View {
        content
            .navigationTitle("Usage Limits")
            .navigationBarTitleDisplayMode(.inline)
            .task(id: taskID) { await reload() }
            .refreshable { refreshTrigger = UUID() }
    }

    @ViewBuilder
    private var content: some View {
        if unsupported {
            ContentUnavailableView(
                "Limits Unavailable",
                systemImage: "gauge.with.dots.needle.33percent",
                description: Text("This connection does not support subscription limits.")
            )
            .background(T3Colors.background)
        } else if !isLoading, accounts.isEmpty {
            ContentUnavailableView {
                Label("No Accounts", systemImage: "person.crop.circle.badge.questionmark")
            } description: {
                Text((["No enabled providers report limits on your servers."] + notices).joined(separator: "\n"))
            }
            .background(T3Colors.background)
        } else {
            SettingsForm {
                if isLoading, accounts.isEmpty {
                    Section { SettingsPlaceholderRows(count: 3) } footer: { Text("Reading subscription limits…") }
                }
                comparisonSections
                poolSection
                ForEach(accounts) { account in accountSection(account) }
                Section {} footer: {
                    SettingsFooter(
                        text: "Known accounts are counted once across your servers. Percentages are per account, not additive quota.",
                        error: notices.isEmpty ? nil : notices.joined(separator: "\n")
                    )
                }
            }
        }
    }

    private var taskID: String {
        "\(refreshTrigger)-\(selectedEnvironmentIDs.sorted().joined(separator: ","))"
    }

    @ViewBuilder
    private var comparisonSections: some View {
        ForEach(Array(Set(accounts.map(\.driver))).sorted(), id: \.self) { driver in
            let members = accounts.filter { $0.driver == driver }
            if members.count > 1 {
                Section {
                    ForEach(FeatureUsageLimitsMerge.comparisonWindows(members)) { row in
                        ForEach(members) { account in
                            comparisonRow(row, account: account)
                        }
                    }
                } header: {
                    Text("Compare \(Self.driverLabel(driver)) Accounts")
                } footer: {
                    Text("Each row stays with one account. Missing reports are shown as such.")
                }
            }
        }
    }

    private func comparisonRow(_ row: FeatureUsageLimitsMerge.ComparisonWindow, account: FeatureLimitAccount) -> some View {
        let window = account.limits?.unavailable == nil
            ? account.limits?.windows.first { $0.id == row.windowID && $0.windowDurationMins == row.duration }
            : nil
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(row.label) · \(account.provider)")
                Spacer(minLength: 8)
                if let window {
                    Text(Self.percent(window.usedPercent))
                        .foregroundStyle(Self.color(window.usedPercent))
                        .monospacedDigit()
                } else {
                    Text("Not reported").foregroundStyle(T3Colors.textTertiary)
                }
            }
            if let window { gauge(window.usedPercent) }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var poolSection: some View {
        let pools = FeatureUsageLimitsMerge.pools(accounts)
        if !pools.isEmpty {
            Section {
                ForEach(pools) { pool in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(pool.label)
                            Spacer(minLength: 8)
                            Text(Self.percent(pool.usedPercent))
                                .foregroundStyle(Self.color(pool.usedPercent))
                                .monospacedDigit()
                        }
                        gauge(pool.usedPercent)
                        Text("\(Self.percent(100 - pool.usedPercent, suffix: "remaining")) · \(pool.accountCount) accounts")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                    .padding(.vertical, 2)
                }
            } header: {
                Text("Pooled Limits")
            } footer: {
                Text("Equal shares per reporting account, not combined token capacity. Missing accounts are excluded; different plans can have different allowances.")
            }
        }
    }

    private func accountSection(_ account: FeatureLimitAccount) -> some View {
        Section {
            if let limits = account.limits {
                if let unavailable = limits.unavailable {
                    Text(unavailable.reason == "unsupported"
                        ? "This account does not report subscription limits."
                        : "Could not read limits. Pull to refresh.")
                        .foregroundStyle(T3Colors.textSecondary)
                } else if limits.windows.isEmpty {
                    Text("No limit windows reported.").foregroundStyle(T3Colors.textSecondary)
                } else {
                    ForEach(limits.windows) { window in windowRow(window) }
                }
                if let credits = limits.resetCredits, let target = account.resetTarget,
                   let reader = model.client as? any FeatureUsageLimitsReading {
                    SettingsResetCreditsRow(credits: credits, target: target, reader: reader) {
                        await reload(clearExisting: false)
                    }
                }
            } else {
                Text("Limits unavailable. This provider or server does not report them yet.")
                    .foregroundStyle(T3Colors.textSecondary)
            }
        } header: {
            Text([account.provider, account.plan].compactMap { $0 }.joined(separator: " · "))
        } footer: {
            Text(accountFooter(account))
        }
    }

    private func windowRow(_ window: ServerProviderUsageLimits.Window) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(window.label)
                Spacer(minLength: 8)
                Text(Self.percent(window.usedPercent))
                    .foregroundStyle(Self.color(window.usedPercent))
                    .monospacedDigit()
            }
            gauge(window.usedPercent)
            if let reset = FeatureUsageLimitsMerge.date(window.resetsAt) {
                Text("Resets \(reset.formatted(date: .abbreviated, time: .shortened))")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private func gauge(_ usedPercent: Double) -> some View {
        Gauge(value: min(100, max(0, usedPercent)), in: 0...100) { EmptyView() }
            .gaugeStyle(.linearCapacity)
            .tint(Self.color(usedPercent))
            .accessibilityHidden(true)
    }

    private func accountFooter(_ account: FeatureLimitAccount) -> String {
        let servers = account.environments.formatted(.list(type: .and))
        guard let checked = FeatureUsageLimitsMerge.date(account.limits?.checkedAt) else {
            return servers.isEmpty ? "" : "On \(servers)."
        }
        let stale = Date.now.timeIntervalSince(checked) > 300 ? " · may be out of date" : ""
        let on = servers.isEmpty ? "" : " on \(servers)"
        return "Checked \(checked.formatted(date: .omitted, time: .shortened))\(on)\(stale)."
    }

    private static func percent(_ value: Double, suffix: String = "used") -> String {
        "\((value / 100).formatted(.percent.precision(.fractionLength(0)))) \(suffix)"
    }

    /// Red from 90% used, where a window is about to stop work.
    private static func color(_ usedPercent: Double) -> Color {
        usedPercent >= 90 ? T3Colors.danger : T3Colors.accent
    }

    static func driverLabel(_ driver: String) -> String {
        switch driver {
        case "codex": "Codex"
        case "claudeAgent", "claude": "Claude"
        case "cursor": "Cursor"
        case "opencode": "OpenCode"
        case "grok": "Grok"
        case "antigravity": "Antigravity"
        case "hermes": "Hermes"
        default: driver.prefix(1).uppercased() + driver.dropFirst()
        }
    }

    private func reload(clearExisting: Bool = true) async {
        let selected = selectedEnvironmentIDs
        guard let reader = model.client as? any FeatureUsageLimitsReading else {
            unsupported = true
            isLoading = false
            return
        }
        isLoading = true
        if clearExisting { accounts = [] }
        var environments: [FeatureEnvironmentLimits] = []
        var failures: [String] = []
        for environment in model.snapshot.environments where selected.contains(environment.id) {
            do {
                let providers = try await reader.usageLimits(environmentID: environment.id, refresh: true)
                try Task.checkCancellation()
                var sources: [UsageLimitSourceSnapshot] = []
                do {
                    sources = try await reader.usageLimitSources(environmentID: environment.id)
                    for source in sources where source.error != nil {
                        failures.append("\(environment.name) · \(source.label): \(source.error!)")
                    }
                } catch {
                    if Task.isCancelled { return }
                    failures.append("\(environment.name): Quota hubs could not be read; local accounts are shown.")
                }
                environments.append(.init(id: environment.id, label: environment.name, providers: providers, sources: sources))
            } catch {
                if Task.isCancelled { return }
                failures.append("\(environment.name) is unavailable; its accounts are not included.")
            }
        }
        guard !Task.isCancelled, selected == selectedEnvironmentIDs else { return }
        accounts = FeatureUsageLimitsMerge.merge(environments)
        notices = failures
        isLoading = false
    }
}
