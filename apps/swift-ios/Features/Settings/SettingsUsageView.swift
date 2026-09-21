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
        case unsupported
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
    /// Environments that answered nothing this refresh (offline, old server):
    /// their usage is absent, and the screen must say so rather than present
    /// the merged number as complete.
    @State private var unreachableEnvironments: [String] = []

    private var selectedIDs: Set<String> { selectedEnvironmentIDs ?? Set(model.snapshot.environments.map(\.id)) }

    public init(model: FeatureRootModel) {
        self.model = model
    }

    public var body: some View {
        content
            .navigationTitle(showsLimits ? "Limits" : "Usage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Picker("Usage view", selection: $showsLimits) {
                        Text("Usage").tag(false)
                        Text("Limits").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .fixedSize()
                }
                ToolbarItem(placement: .primaryAction) { filterMenu }
            }
            .task(id: "\(windowDays)-\(showsLimits)-\(selectionRevision)-\(model.snapshot.environments.map(\.id).joined(separator: ","))") {
                if !showsLimits { await reload() }
            }
    }

    @ViewBuilder
    private var content: some View {
        if selectedIDs.isEmpty {
            ContentUnavailableView {
                Label("No Servers Selected", systemImage: "server.rack")
            } description: {
                Text("Choose at least one server in the filter menu.")
            } actions: {
                Button("Show All") { showAllServers() }
                    .t3ProminentButtonStyle()
            }
            .background(T3Colors.background)
        } else if showsLimits {
            SettingsUsageLimitsView(model: model, selectedEnvironmentIDs: selectedIDs, refreshTrigger: limitsRefreshID)
                .refreshable { limitsRefreshID = UUID() }
        } else {
            usageContent
        }
    }

    @ViewBuilder
    private var usageContent: some View {
        switch state {
        case .unsupported:
            ContentUnavailableView(
                "Usage Unavailable",
                systemImage: "chart.bar.xaxis",
                description: Text("This connection does not support usage summaries.")
            )
            .background(T3Colors.background)
        case let .failed(message):
            ContentUnavailableView {
                Label("Couldn't Load Usage", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await reload(refreshPrices: true) } }
                    .t3ProminentButtonStyle()
            }
            .background(T3Colors.background)
        case let .loaded(merged) where merged.totalTokens == 0 && scanningEnvironments.isEmpty:
            ContentUnavailableView {
                Label("No Usage", systemImage: "chart.bar.xaxis")
            } description: {
                Text("No provider transcripts were found \(windowPhrase) on the selected servers.")
            }
            .background(T3Colors.background)
            .refreshable { await reload(refreshPrices: true) }
        case .loading, .loaded:
            SettingsForm {
                chartSection(loadedUsage ?? FeatureMergedUsage())
                    .redacted(reason: loadedUsage == nil ? .placeholder : [])
                if let merged = loadedUsage {
                    statsSection(merged)
                    if !merged.models.isEmpty { modelsSection(merged) }
                }
                Section {
                    NavigationLink {
                        SettingsModelPricesView(model: model).onDisappear { Task { await reload() } }
                    } label: {
                        Text("Model Prices")
                    }
                }
            }
            .refreshable { await reload(refreshPrices: true) }
        }
    }

    private var loadedUsage: FeatureMergedUsage? {
        if case let .loaded(merged) = state { return merged }
        return nil
    }

    // MARK: - Toolbar

    /// Window, servers and metric in one menu, so none of them costs a row.
    private var filterMenu: some View {
        Menu {
            if !showsLimits {
                Picker("Window", selection: $windowDays) {
                    Text("Past 24 Hours").tag(1)
                    Text("7 Days").tag(7)
                    Text("30 Days").tag(30)
                    Text("90 Days").tag(90)
                }
                Picker("Show", selection: $showsCost) {
                    Text("Cost").tag(true)
                    Text("Tokens").tag(false)
                }
            }
            Section("Servers") {
                Button("All Servers") { showAllServers() }
                    .disabled(selectedEnvironmentIDs == nil)
                ForEach(model.snapshot.environments) { environment in
                    Toggle(environment.name, isOn: Binding(
                        get: { selectedIDs.contains(environment.id) },
                        set: { isOn in
                            var ids = selectedIDs
                            if isOn { ids.insert(environment.id) } else { ids.remove(environment.id) }
                            selectedEnvironmentIDs = ids
                            selectionRevision = UUID()
                        }
                    ))
                }
            }
        } label: {
            Label("Filter", systemImage: selectedEnvironmentIDs == nil
                ? "line.3.horizontal.decrease.circle"
                : "line.3.horizontal.decrease.circle.fill")
        }
    }

    private func showAllServers() {
        selectedEnvironmentIDs = nil
        selectionRevision = UUID()
    }

    // MARK: - Sections

    private var windowPhrase: String {
        windowDays == 1 ? "in the past 24 hours" : "in the last \(windowDays) days"
    }

    private var windowTitle: String {
        windowDays == 1 ? "Past 24 Hours" : "Last \(windowDays) Days"
    }

    private var selectedServerNames: String {
        model.snapshot.environments
            .filter { selectedIDs.contains($0.id) }
            .map(\.name)
            .formatted(.list(type: .and))
    }

    /// The headline figure and the chart behind it, like Screen Time.
    private func chartSection(_ merged: FeatureMergedUsage) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(showsCost ? "Total Cost" : "Total Tokens") · \(windowTitle)")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                Text(showsCost ? Self.cost(merged.costUsd) : Self.tokens(merged.totalTokens))
                    .font(.largeTitle.weight(.bold))
                    .foregroundStyle(T3Colors.textPrimary)
                    .monospacedDigit()
                Text(scanningEnvironments.isEmpty
                    ? selectedServerNames
                    : "Still scanning \(scanningEnvironments.formatted(.list(type: .and)))…")
                    .font(T3Typography.supporting)
                    .foregroundStyle(scanningEnvironments.isEmpty ? T3Colors.textSecondary : T3Colors.warning)
                    .unredacted()
                chart(merged)
                    .padding(.top, 10)
            }
            .padding(.vertical, 6)
            ForEach(merged.providers) { provider in
                providerRow(provider)
            }
        } footer: {
            if case .loading = state {
                Text("Scanning transcripts…")
            }
        }
    }

    private func chart(_ merged: FeatureMergedUsage) -> some View {
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
        .chartLegend(.hidden)
        .frame(height: 160)
        .accessibilityLabel("\(windowDays == 1 ? "Hourly" : "Daily") \(showsCost ? "cost" : "tokens") by provider")
    }

    private func providerRow(_ provider: FeatureUsageProviderTotals) -> some View {
        LabeledContent {
            // Cost leads and the volume behind it sits underneath: three
            // metrics on one line stop fitting at 320pt.
            VStack(alignment: .trailing, spacing: 1) {
                Text(Self.cost(provider.costUsd))
                    .foregroundStyle(T3Colors.textPrimary)
                    .monospacedDigit()
                Text(Self.providerVolume(provider))
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .monospacedDigit()
                    .lineLimit(1)
            }
        } label: {
            HStack(spacing: 8) {
                Circle()
                    .fill(Self.providerColor(provider.provider))
                    .frame(width: 10, height: 10)
                    .accessibilityHidden(true)
                Text(providerLabel(provider.provider))
            }
        }
    }

    private func statsSection(_ merged: FeatureMergedUsage) -> some View {
        let activePeriods = windowDays == 1 ? merged.hourly.count : merged.activeDays
        let average = activePeriods == 0 ? "—" : showsCost
            ? Self.cost(merged.costUsd / Double(activePeriods))
            : Self.tokens(merged.totalTokens / activePeriods)
        return Section {
            LabeledContent(windowDays == 1 ? "Hourly Average" : "Daily Average", value: average)
            LabeledContent(showsCost ? "Tokens" : "API Cost", value: showsCost ? Self.tokens(merged.totalTokens) : Self.cost(merged.costUsd))
            LabeledContent("Cached Input", value: merged.cachedInputShare.formatted(.percent.precision(.fractionLength(0))))
            LabeledContent("Sessions", value: merged.sessions.formatted())
            LabeledContent("Cache Savings", value: Self.cost(merged.cacheSavingsUsd))
        } footer: {
            Text((["Cost is the API-equivalent price of these tokens; subscription plans bill separately."] + coverageNotes(merged))
                .joined(separator: "\n"))
        }
        .monospacedDigit()
    }

    private func modelsSection(_ merged: FeatureMergedUsage) -> some View {
        Section("By Model") {
            ForEach(merged.models.sorted { showsCost ? $0.costUsd > $1.costUsd : $0.totalTokens > $1.totalTokens }) { model in
                LabeledContent {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(showsCost ? Self.cost(model.costUsd) : Self.tokens(model.totalTokens))
                            .foregroundStyle(T3Colors.textPrimary)
                        Text(showsCost ? "\(Self.tokens(model.totalTokens)) tokens" : Self.cost(model.costUsd))
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                    .monospacedDigit()
                } label: {
                    Text(model.model).lineLimit(1)
                }
            }
        }
    }

    // MARK: - Loading

    private func reload(refreshPrices: Bool = false) async {
        let generation = UUID()
        loadGeneration = generation
        guard let reader = model.client as? any FeatureUsageReading else {
            state = .unsupported
            return
        }
        let environments = model.snapshot.environments.filter { selectedIDs.contains($0.id) }
        // Nothing selected is a filter state the view explains on its own;
        // scanning nothing would settle as an empty result and contradict it.
        guard !environments.isEmpty else { return }
        let selection = "\(windowDays):\(selectedIDs.sorted().joined(separator: ","))"
        if loadedSelection != selection { state = .loading }
        loadedSelection = selection

        let window = UsageSummaryInput.window(days: windowDays)
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
        scanningEnvironments = []
        unreachableEnvironments = unreachable
        if usable.isEmpty {
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
    /// eight-digit numbers wreck the layout.
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
