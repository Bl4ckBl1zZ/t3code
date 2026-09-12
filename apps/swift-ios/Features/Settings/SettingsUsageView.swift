import Charts
import SwiftUI

// Ported from apps/mobile/src/features/usage/UsageRouteScreen.tsx and the web
// usage page: totals, a daily stacked bar chart by provider, and a per-model
// breakdown, merged across every saved environment with transcript-directory
// de-duplication (`UsageMerge.swift`).

public struct SettingsUsageView: View {
    private enum LoadState: Equatable {
        case loading
        case loaded(FeatureMergedUsage)
        case failed(String)
    }

    /// Series and stack order, bottom band first — matches the Expo screen.
    private static let providerOrder = ["codex", "claude"]

    @Bindable private var model: FeatureRootModel

    @State private var state: LoadState = .loading
    @AppStorage("t3.usage.showsLimits") private var showsLimits = false
    @State private var limitsRefreshID = UUID()
    @State private var loadGeneration = UUID()
    @State private var loadedSelection: String?
    @AppStorage("t3.usage.windowDays") private var windowDays = 30
    @AppStorage("t3.usage.showsCost") private var showsCost = true
    @State private var selectedEnvironmentIDs: Set<String>?
    @State private var selectionRevision = UUID()
    @State private var scanningEnvironments: [String] = []

    private var selectedIDs: Set<String> { selectedEnvironmentIDs ?? Set(model.snapshot.environments.map(\.id)) }
    /// Environments that answered nothing this refresh (offline, old server):
    /// their usage is absent, and the screen must say so rather than present
    /// the merged number as complete.
    @State private var unreachableEnvironments: [String] = []

    public init(model: FeatureRootModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                Picker("Usage view", selection: $showsLimits) {
                    Text("Usage").tag(false)
                    Text("Limits").tag(true)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, SettingsMetrics.cardInset)
                if showsLimits { SettingsUsageLimitsView(model: model, refreshTrigger: limitsRefreshID) }
                else {
                NavigationLink {
                    SettingsModelPricesView(model: model).onDisappear { Task { await reload() } }
                } label: {
                    Label("Model prices", systemImage: "dollarsign.circle")
                        .font(T3Typography.threadBody).padding(.horizontal, SettingsMetrics.cardInset)
                }
                environmentSection
                windowSection
                if selectedIDs.isEmpty { SettingsFootnote("Select an environment to see usage.") }
                if !scanningEnvironments.isEmpty { SettingsFootnote("Still scanning: \(scanningEnvironments.joined(separator: ", ")). Totals are partial.") }

                switch state {
                case .loading:
                    ProgressView("Scanning transcripts…")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 48)
                case let .failed(message):
                    SettingsErrorBanner(message: message)
                case let .loaded(merged):
                    if merged.totalTokens == 0 {
                        emptySection
                    } else {
                        totalsSection(merged)
                        chartSection(merged)
                        modelsSection(merged)
                    }
                    coverageSection(merged)
                }
                }
            }
            .padding(.vertical, 18)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: "\(windowDays)-\(showsLimits)-\(selectionRevision)-\(model.snapshot.environments.map(\.id).joined(separator: ","))") { if !showsLimits { await reload() } }
        .refreshable {
            if showsLimits { limitsRefreshID = UUID() }
            else { await reload(refreshPrices: true) }
        }
    }

    // MARK: - Sections

    private var environmentSection: some View {
        SettingsSection(title: "Environments") {
            Menu {
                Button("All environments") { selectedEnvironmentIDs = nil; selectionRevision = UUID() }
                ForEach(model.snapshot.environments) { environment in
                    Button {
                        var ids = selectedIDs
                        if !ids.insert(environment.id).inserted { ids.remove(environment.id) }
                        selectedEnvironmentIDs = ids
                        selectionRevision = UUID()
                    } label: {
                        Label(environment.name, systemImage: selectedIDs.contains(environment.id) ? "checkmark.circle.fill" : "circle")
                    }
                }
            } label: {
                HStack { Text(selectedEnvironmentIDs == nil ? "All environments" : "\(selectedIDs.count) selected"); Spacer(); Image(systemName: "chevron.up.chevron.down") }
                    .frame(minHeight: T3Metrics.minimumTapTarget).padding(.horizontal, SettingsMetrics.rowPadding)
            }
        }
    }

    private var windowSection: some View {
        Picker("Window", selection: $windowDays) {
            Text("Past 24h").tag(1)
            Text("7 days").tag(7)
            Text("30 days").tag(30)
            Text("90 days").tag(90)
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, SettingsMetrics.cardInset)
    }

    private var emptySection: some View {
        SettingsSection(
            title: "No usage",
            footer: "No provider transcripts were found in this window on any connected server."
        ) {
            EmptyView()
        }
    }

    private func totalsSection(_ merged: FeatureMergedUsage) -> some View {
        let activePeriods = windowDays == 1 ? merged.hourly.count : merged.activeDays
        return SettingsSection(
            title: windowDays == 1 ? "Past 24 hours" : "Last \(windowDays) days",
            footer: "Cost is the API-equivalent price of these tokens; subscription plans bill separately."
        ) {
            VStack(spacing: 10) {
                HStack(spacing: 10) {
                    statCard(showsCost ? "Total cost" : "Total tokens", showsCost ? Self.cost(merged.costUsd) : Self.tokens(merged.totalTokens))
                    statCard(
                        windowDays == 1 ? "Hourly average" : "Daily average",
                        activePeriods == 0 ? "—" : showsCost
                            ? Self.cost(merged.costUsd / Double(activePeriods))
                            : Self.tokens(merged.totalTokens / activePeriods)
                    )
                }
                HStack(spacing: 10) {
                    statCard(showsCost ? "Tokens" : "API cost", showsCost ? Self.tokens(merged.totalTokens) : Self.cost(merged.costUsd))
                    statCard(
                        "Cached input",
                        merged.cachedInputShare
                            .formatted(.percent.precision(.fractionLength(0)))
                    )
                }
                HStack(spacing: 10) {
                    statCard("Sessions", "\(merged.sessions)")
                    statCard("Cache savings", Self.cost(merged.cacheSavingsUsd))
                }
            }
            .padding(.horizontal, SettingsMetrics.rowPadding)
        }
    }

    private func chartSection(_ merged: FeatureMergedUsage) -> some View {
        SettingsSection(title: "\(windowDays == 1 ? "Hourly" : "Daily") \(showsCost ? "cost" : "tokens")") {
            VStack(alignment: .leading, spacing: 12) {
                Picker("Metric", selection: $showsCost) {
                    Text("Cost").tag(true)
                    Text("Tokens").tag(false)
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 220)

                Chart {
                    ForEach(windowDays == 1 ? merged.hourly : merged.daily) { day in
                        ForEach(orderedProviders(in: day), id: \.self) { provider in
                            if let slice = day.byProvider[provider] {
                                BarMark(
                                    x: .value("Day", Self.chartDate(day.day)),
                                    y: .value(
                                        showsCost ? "Cost" : "Tokens",
                                        showsCost ? slice.costUsd : Double(slice.totalTokens)
                                    )
                                )
                                .foregroundStyle(by: .value("Provider", providerLabel(provider)))
                            }
                        }
                    }
                }
                .chartForegroundStyleScale(providerScale(merged))
                .chartLegend(position: .bottom, spacing: 8)
                .frame(height: 180)

                providerTotalsRows(merged)
            }
            .padding(.horizontal, SettingsMetrics.rowPadding)
        }
    }

    private func providerTotalsRows(_ merged: FeatureMergedUsage) -> some View {
        VStack(spacing: 6) {
            ForEach(merged.providers) { provider in
                HStack(spacing: 8) {
                    Circle()
                        .fill(Self.providerColor(provider.provider))
                        .frame(width: 8, height: 8)
                    Text(providerLabel(provider.provider))
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    // Cost leads and the volume behind it sits underneath:
                    // three metrics on one line stop fitting at 320pt.
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(Self.cost(provider.costUsd))
                            .font(T3Typography.supporting.weight(.medium))
                            .foregroundStyle(T3Colors.textSecondary)
                            .monospacedDigit()
                        Text(Self.providerVolume(provider))
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textTertiary)
                            .monospacedDigit()
                            .lineLimit(1)
                    }
                }
            }
        }
    }

    private func modelsSection(_ merged: FeatureMergedUsage) -> some View {
        SettingsSection(title: "By model") {
            VStack(spacing: 8) {
                ForEach(merged.models.sorted { showsCost ? $0.costUsd > $1.costUsd : $0.totalTokens > $1.totalTokens }) { model in
                    HStack(spacing: 8) {
                        Text(model.model)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textPrimary)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text(Self.tokens(model.totalTokens))
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textTertiary)
                        Text(Self.cost(model.costUsd))
                            .font(T3Typography.supporting.weight(.medium))
                            .foregroundStyle(T3Colors.textSecondary)
                            .monospacedDigit()
                    }
                }
            }
            .padding(.horizontal, SettingsMetrics.rowPadding)
        }
    }

    @ViewBuilder
    private func coverageSection(_ merged: FeatureMergedUsage) -> some View {
        let notes = coverageNotes(merged)
        if !notes.isEmpty {
            SettingsFootnote(notes.joined(separator: "\n"))
        }
    }

    private func statCard(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
            Text(value)
                .font(T3Typography.threadBody.weight(.semibold))
                .foregroundStyle(T3Colors.textPrimary)
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(T3Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Loading

    private func reload(refreshPrices: Bool = false) async {
        let generation = UUID()
        loadGeneration = generation
        guard let reader = model.client as? any FeatureUsageReading else {
            state = .failed("This connection does not support usage summaries.")
            return
        }
        let selection = "\(windowDays):\(selectedIDs.sorted().joined(separator: ","))"
        if loadedSelection != selection { state = .loading }
        loadedSelection = selection

        let window = UsageSummaryInput.window(days: windowDays)
        let environments = model.snapshot.environments.filter { selectedIDs.contains($0.id) }
        scanningEnvironments = environments.map(\.name)
        var usable: [FeatureEnvironmentUsage] = []
        var unreachable: [String] = []
        // Keep at most one native scan in flight and publish each answer immediately.
        for environment in environments {
            guard !Task.isCancelled, loadGeneration == generation else { return }
            do {
                // Older servers may not expose pricing refresh; their scan still works.
                if refreshPrices { try? await reader.refreshUsageRates(environmentID: environment.id) }
                guard !Task.isCancelled, loadGeneration == generation else { return }
                let summary = try await reader.usageSummary(
                    environmentID: environment.id,
                    input: window
                )
                usable.append(
                    FeatureEnvironmentUsage(
                        environmentID: environment.id,
                        label: environment.name,
                        summary: summary
                    )
                )
            } catch {
                // An unreachable or pre-usage server is partial coverage, not
                // a failed screen.
                unreachable.append(environment.name)
            }
            guard !Task.isCancelled, loadGeneration == generation else { return }
            scanningEnvironments = Array(environments.dropFirst(usable.count + unreachable.count)).map(\.name)
            unreachableEnvironments = unreachable
            if !usable.isEmpty { state = .loaded(FeatureUsageMerge.merge(usable)) }
        }
        guard !Task.isCancelled, loadGeneration == generation else { return }
        unreachableEnvironments = unreachable
        if usable.isEmpty && !environments.isEmpty {
            state = .failed("No connected server answered the usage scan.")
            return
        }
        state = .loaded(FeatureUsageMerge.merge(usable))
    }

    // MARK: - Derivations

    private func coverageNotes(_ merged: FeatureMergedUsage) -> [String] {
        var notes: [String] = []
        if !unreachableEnvironments.isEmpty {
            notes.append(
                "Not included (unreachable): \(unreachableEnvironments.joined(separator: ", "))."
            )
        }
        if !merged.staleEnvironments.isEmpty {
            notes.append(
                "Excluded \(merged.staleEnvironments.count) environment(s) running an older usage contract."
            )
        }
        if !merged.duplicateSources.isEmpty {
            notes.append(
                "Skipped \(merged.duplicateSources.count) duplicate transcript director\(merged.duplicateSources.count == 1 ? "y" : "ies") shared between environments."
            )
        }
        return notes
    }

    /// Stack order for one bar, bottom band first; providers the order list
    /// does not know sort after it so nothing silently disappears.
    private func orderedProviders(in day: FeatureUsageDailyTotals) -> [String] {
        day.byProvider.keys.sorted { left, right in
            let li = Self.providerOrder.firstIndex(of: left) ?? Self.providerOrder.count
            let ri = Self.providerOrder.firstIndex(of: right) ?? Self.providerOrder.count
            return li == ri ? left < right : li < ri
        }
    }

    private func providerScale(_ merged: FeatureMergedUsage) -> KeyValuePairs<String, Color> {
        // Charts wants a literal mapping; cover the known providers and let
        // unknowns fall back to the framework palette.
        [
            "Codex": Self.providerColor("codex"),
            "Claude Code": Self.providerColor("claude"),
        ]
    }

    private func providerLabel(_ provider: String) -> String {
        switch provider {
        case "claude": "Claude Code"
        case "codex": "Codex"
        default: provider.capitalized
        }
    }

    /// Claude's brand orange holds in both themes; Codex is neutral and flips
    /// with the theme so its bars stay visible — same rule as the Expo screen.
    private static func providerColor(_ provider: String) -> Color {
        switch provider {
        case "claude": Color(red: 0.85, green: 0.47, blue: 0.34)
        case "codex": Color.primary.opacity(0.75)
        default: Color.secondary
        }
    }

    // MARK: - Formatting

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static func chartDate(_ day: String) -> Date {
        ISO8601DateFormatter().date(from: day) ?? dayFormatter.date(from: day) ?? Date(timeIntervalSince1970: 0)
    }

    private static func cost(_ value: Double) -> String {
        value.formatted(.currency(code: "USD").precision(.fractionLength(2)))
    }

    /// Compact token magnitude ("48.2M"): exact counts belong to tooling, and
    /// eight-digit numbers wreck the card layout.
    private static func tokens(_ value: Int) -> String {
        Double(value).formatted(.number.notation(.compactName).precision(.significantDigits(3)))
    }

    /// The volume line under a provider's cost. Sessions are dropped rather
    /// than printed as "0 sessions" when the provider's transcripts claimed
    /// none — priced buckets with no owned directory behind them.
    static func providerVolume(_ provider: FeatureUsageProviderTotals) -> String {
        let volume = "\(tokens(provider.totalTokens)) tokens"
        guard provider.sessions > 0 else { return volume }
        let noun = provider.sessions == 1 ? "session" : "sessions"
        return "\(volume) · \(provider.sessions) \(noun)"
    }
}
