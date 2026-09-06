import SwiftUI

struct SettingsUsageLimitsView: View {
    @Bindable var model: FeatureRootModel
    var refreshTrigger: UUID
    @State private var selectedEnvironmentIDs: Set<String>?
    @State private var accounts: [FeatureLimitAccount] = []
    @State private var notices: [String] = []
    @State private var isLoading = true
    @State private var reloadID = UUID()

    private var selectedIDs: Set<String> {
        selectedEnvironmentIDs ?? Set(model.snapshot.environments.map(\.id))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            SettingsSection(title: "Environments", footer: "Known accounts are counted once across selected environments. Percentages are per account, not additive quota.") {
                Menu {
                    ForEach(model.snapshot.environments) { environment in
                        Button {
                            var selected = selectedIDs
                            if !selected.insert(environment.id).inserted { selected.remove(environment.id) }
                            selectedEnvironmentIDs = selected
                            reloadID = UUID()
                        } label: {
                            Label(environment.name, systemImage: selectedIDs.contains(environment.id) ? "checkmark.circle.fill" : "circle")
                        }
                    }
                } label: {
                    HStack { Text("\(selectedIDs.count) selected"); Spacer(); Image(systemName: "chevron.up.chevron.down") }
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                }
                .accessibilityIdentifier("limits-environment-selection")
                Button("Refresh limits") { reloadID = UUID() }.disabled(isLoading || selectedIDs.isEmpty)
            }
            if isLoading { ProgressView("Reading subscription limits…").frame(maxWidth: .infinity) }
            if selectedIDs.isEmpty { SettingsErrorBanner(message: "Select an environment to see its subscription limits.") }
            ForEach(notices, id: \.self) { SettingsErrorBanner(message: $0) }
            let pools = FeatureUsageLimitsMerge.pools(accounts)
            if !pools.isEmpty {
                SettingsSection(title: "Pooled limits", footer: "Equal shares per reporting account, not combined token capacity. Missing accounts are excluded; different plans can have different allowances.") {
                    ForEach(pools) { pool in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(pool.label).font(.subheadline)
                            ProgressView(value: pool.usedPercent, total: 100).tint(T3Colors.accent)
                            Text("\(100 - pool.usedPercent, specifier: "%.0f")% remaining · \(pool.accountCount) accounts")
                                .font(.caption).foregroundStyle(T3Colors.textSecondary)
                        }.padding(.vertical, 8)
                    }
                }
            }
            ForEach(accounts) { account in
                SettingsSection(title: account.provider, footer: account.environments.joined(separator: " · ")) {
                    VStack(alignment: .leading, spacing: 12) {
                        if let plan = account.plan { Text(plan).font(.subheadline).foregroundStyle(T3Colors.textSecondary) }
                        if let limits = account.limits {
                            if let unavailable = limits.unavailable {
                                Text(unavailable.reason == "unsupported" ? "This account does not report subscription limits." : "Could not read limits. Refresh to try again.")
                                    .foregroundStyle(T3Colors.textSecondary)
                            } else if limits.windows.isEmpty {
                                Text("No limit windows reported.").foregroundStyle(T3Colors.textSecondary)
                            } else {
                                ForEach(limits.windows) { window in
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack {
                                            Text(window.label)
                                            Spacer()
                                            Text("\(window.usedPercent, specifier: "%.0f")% used").monospacedDigit()
                                        }.font(.subheadline)
                                        ProgressView(value: min(100, max(0, window.usedPercent)), total: 100)
                                            .tint(window.usedPercent >= 90 ? T3Colors.danger : T3Colors.accent)
                                        if let reset = FeatureUsageLimitsMerge.date(window.resetsAt) {
                                            Text("Resets \(reset.formatted(date: .abbreviated, time: .shortened))")
                                                .font(.caption).foregroundStyle(T3Colors.textSecondary)
                                        }
                                    }
                                }
                            }
                            if let checked = FeatureUsageLimitsMerge.date(limits.checkedAt) {
                                Text("Checked \(checked.formatted(date: .abbreviated, time: .shortened))\(Date.now.timeIntervalSince(checked) > 300 ? " · May be stale" : "")")
                                    .font(.caption).foregroundStyle(T3Colors.textTertiary)
                            }
                        } else {
                            Text("Limits unavailable. This provider or server does not report them yet.").foregroundStyle(T3Colors.textSecondary)
                        }
                    }
                    .padding(.vertical, 8)
                }
            }
            if !isLoading && accounts.isEmpty && notices.isEmpty && !selectedIDs.isEmpty {
                SettingsErrorBanner(message: "No enabled providers in the selected environments.")
            }
        }
        .task(id: [reloadID, refreshTrigger]) { await reload() }
        .accessibilityIdentifier("subscription-limits")
    }

    private func reload() async {
        let request = reloadID
        let selected = selectedIDs
        guard let reader = model.client as? any FeatureUsageLimitsReading else {
            notices = ["This connection does not support subscription limits."]
            isLoading = false
            return
        }
        isLoading = true
        accounts = []
        notices = []
        var environments: [FeatureEnvironmentLimits] = []
        var failures: [String] = []
        for environment in model.snapshot.environments where selected.contains(environment.id) {
            do {
                let providers = try await reader.usageLimits(environmentID: environment.id, refresh: true)
                try Task.checkCancellation()
                environments.append(.init(id: environment.id, label: environment.name, providers: providers))
            } catch {
                if Task.isCancelled { return }
                failures.append("\(environment.name) is unavailable; its accounts are not included.")
            }
        }
        guard !Task.isCancelled, request == reloadID, selected == selectedIDs else { return }
        accounts = FeatureUsageLimitsMerge.merge(environments)
        notices = failures
        isLoading = false
    }
}
