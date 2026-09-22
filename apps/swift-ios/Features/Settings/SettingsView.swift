import SwiftUI

/// Settings, presented as a sheet from Home.
///
/// One navigation stack: every row pushes, so nothing stacks a second sheet on
/// top of this one except the flows that really are modal (pairing a server,
/// first-run setup). Changes apply as they are made. Client settings are local
/// and cheap to write, so there is nothing to buffer and nothing a swipe-down
/// could throw away.
public struct SettingsView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable private var model: FeatureRootModel
    @State private var settings: FeatureSettings
    @State private var path: [SettingsRoute] = []
    @State private var query = ""
    @State private var savesInFlight = 0
    @State private var saveError: String?
    @State private var showingSetup = false

    public init(model: FeatureRootModel) {
        self.init(model: model, initialRoute: nil)
    }

    /// Opens with `initialRoute` already pushed, such as Servers from Home's
    /// connection banner. Back still returns to the Settings root.
    init(model: FeatureRootModel, initialRoute: SettingsRoute?) {
        self.model = model
        _settings = State(initialValue: model.snapshot.settings)
        _path = State(initialValue: initialRoute.map { [$0] } ?? [])
    }

    public var body: some View {
        NavigationStack(path: $path) {
            SettingsForm {
                if isSearching {
                    searchResults
                } else {
                    rootSections
                }
            }
            .overlay {
                if isSearching, searchMatches.isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
            .t3Searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: Text("Search")
            )
            .t3SheetToolbar(.close)
            .navigationDestination(for: SettingsRoute.self) { route in
                destination(route)
            }
        }
        .presentationDragIndicator(.visible)
        .sheet(isPresented: $showingSetup) { AgentSetupView(model: model) }
        .onAppear { model.setConnectionManagementPresented(true) }
        .onDisappear { model.setConnectionManagementPresented(false) }
        .onChange(of: settings) { _, next in persist(next) }
        .onChange(of: model.snapshot.settings) { _, next in
            // Another writer — `t3 theme set`, or the root turning Notifications
            // off when iOS permission is missing — changed the saved settings.
            // Adopt them unless one of this screen's own writes is still landing.
            guard savesInFlight == 0, next != settings else { return }
            settings = next
        }
    }

    // MARK: - Root

    @ViewBuilder
    private var rootSections: some View {
        Section { serverCard }

        if hasServers {
            Section {
                routeLink(.agents)
                ProviderModelPicker(
                    providers: model.snapshot.providers,
                    selection: $settings.defaultSelection,
                    setupContext: ProviderSetupContext(client: model.client, environmentID: activeEnvironment?.id)
                )
                Button { showingSetup = true } label: {
                    SettingsTileLabel(title: "Set Up T3 Code", systemImage: "checklist", tint: .green)
                }
            } footer: {
                if let detail = selectedModel?.detail { Text(detail) }
            }
        }

        Section {
            NavigationLink(value: SettingsRoute.appearance) {
                LabeledContent {
                    Text(appearanceLabel)
                } label: {
                    routeLabel(.appearance)
                }
            }
            routeLink(.threads)
            routeLink(.notifications)
            Toggle(isOn: $settings.hapticsEnabled) {
                SettingsTileLabel(title: "Haptics", systemImage: "hand.tap", tint: .pink)
            }
        } footer: {
            SettingsFooter(error: saveError)
        }

        if let activeEnvironment {
            Section("On \(activeEnvironment.name)") {
                routeLink(.sharedPreferences)
                routeLink(.projectDefaults)
            }
        }

        if hasServers {
            Section {
                routeLink(.automations)
                routeLink(.work)
                routeLink(.usage)
            }
            Section {
                routeLink(.loadBalancing)
                routeLink(.integrations)
                routeLink(.voiceInput)
            }
        }

        Section {
            LabeledContent {
                Text(appVersion)
            } label: {
                SettingsTileLabel(title: "Version", systemImage: "info.circle", tint: .gray)
            }
            Link(destination: URL(string: "https://github.com/pingdotgg/t3code")!) {
                HStack {
                    SettingsTileLabel(
                        title: "Open Source",
                        systemImage: "chevron.left.forwardslash.chevron.right",
                        tint: .ink
                    )
                    Spacer(minLength: 8)
                    Image(systemName: "arrow.up.forward.square")
                        .foregroundStyle(T3Colors.textTertiary)
                        .accessibilityHidden(true)
                }
            }
        }
    }

    /// The account-card equivalent: the active server, how it is doing, and the
    /// way into managing the rest. With nothing paired it becomes the way in.
    @ViewBuilder
    private var serverCard: some View {
        if let environment = activeEnvironment ?? model.snapshot.environments.first {
            let status = SettingsServerStatus.card(
                for: environment,
                isActive: environment.isActive,
                connection: model.snapshot.connection.state
            )
            NavigationLink(value: SettingsRoute.servers) {
                SettingsServerCard(
                    title: environment.isActive ? environment.name : "Choose a Server",
                    systemImage: environment.machineSymbol,
                    tint: environment.isActive ? .ink : .gray,
                    status: environment.isActive ? status : nil,
                    detail: environment.isActive
                        ? SettingsServerStatus.host(environment.endpoint)
                        : "\(model.snapshot.environments.count) saved"
                )
            }
            if environment.isActive, model.snapshot.connection.state == .disconnected {
                Button("Reconnect") {
                    Task { await model.activateEnvironment(environment.id) }
                }
            }
        } else {
            NavigationLink(value: SettingsRoute.addServer) {
                SettingsServerCard(
                    title: "Connect a Server",
                    systemImage: "server.rack",
                    tint: .gray,
                    status: nil,
                    detail: "Pair with T3 Code on a Mac or Linux machine, or sign in to T3 Connect."
                )
            }
        }
    }

    // MARK: - Search

    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var searchMatches: [SettingsSearchEntry] {
        SettingsSearchIndex.results(for: query, available: availableRoutes)
    }

    private var searchResults: some View {
        Section {
            ForEach(searchMatches) { entry in
                NavigationLink(value: entry.route) {
                    SettingsTileLabel(
                        title: entry.title,
                        systemImage: entry.route.systemImage,
                        tint: entry.route.tint,
                        subtitle: entry.breadcrumb
                    )
                }
            }
        }
    }

    /// Search only offers what the root would: server pages once a server is
    /// paired, T3 Connect when this build can reach it.
    private var availableRoutes: Set<SettingsRoute> {
        Set(SettingsRoute.allCases.filter { route in
            if route.requiresServer, !hasServers { return false }
            if route == .t3Connect { return model.client is any T3ConnectCapable }
            return true
        })
    }

    // MARK: - Destinations

    @ViewBuilder
    private func destination(_ route: SettingsRoute) -> some View {
        switch route {
        case .servers:
            SettingsServersView(
                model: model,
                onAddServer: { path.append(.addServer) },
                onDisconnected: { dismiss() }
            )
        case .agents:
            SettingsAgentsView(
                serverSettings: serverSettingsManager,
                environmentID: activeEnvironment?.id,
                preferences: activeEnvironmentPreferences,
                environments: model.snapshot.environments
            )
        case .appearance:
            SettingsAppearanceView(
                settings: $settings,
                environmentName: activeEnvironment?.name,
                environmentThemes: activeEnvironmentThemes,
                saveError: saveError
            )
        case .threads:
            SettingsThreadsView(settings: $settings, saveError: saveError)
        case .notifications:
            SettingsNotificationsView(settings: $settings, saveError: saveError)
        case .sharedPreferences:
            SettingsThreadOrganizationView(model: model)
        case .projectDefaults:
            SettingsProjectDefaultsView(model: model)
        case .automations:
            SettingsAutomationsView(
                model: model,
                manager: scheduledTaskManager,
                onAddServer: { path.append(.addServer) }
            )
        case .work:
            WorkManagementView(model: model)
        case .usage:
            SettingsUsageView(model: model)
        case .loadBalancing:
            SettingsLoadBalancingView(model: model, onAddServer: { path.append(.addServer) })
        case .integrations:
            SettingsIntegrationsView(
                manager: voiceSettingsManager,
                serverSettings: serverSettingsManager,
                environmentID: activeEnvironment?.id,
                preferences: activeEnvironmentPreferences
            )
        case .voiceInput:
            SettingsVoiceInputView(manager: voiceSettingsManager)
        case .devices:
            DevicesView(manager: deviceManager)
        case .desktopUpdates:
            SettingsDesktopUpdatesView(model: model)
        case .environmentIcons:
            SettingsEnvironmentIconsView(model: model)
        case .addServer:
            // Pushed without `onCancel`: Back leaves, and it pops itself once
            // the server connects.
            ConnectionOnboardingView(model: model, onConnected: {})
        case .t3Connect:
            if let capability = model.client as? any T3ConnectCapable {
                T3ConnectView(
                    capability: capability,
                    activeEnvironmentID: model.snapshot.environments.first(where: \.isActive)?.id
                )
            } else {
                ContentUnavailableView(
                    "T3 Connect Unavailable",
                    systemImage: "cloud.slash",
                    description: Text("Direct and local connections still work without an account.")
                )
            }
        }
    }

    private func routeLink(_ route: SettingsRoute) -> some View {
        NavigationLink(value: route) { routeLabel(route) }
    }

    private func routeLabel(_ route: SettingsRoute) -> some View {
        SettingsTileLabel(title: route.title, systemImage: route.systemImage, tint: route.tint)
    }

    // MARK: - Saving

    /// Writes one change as soon as it is made. A failed write puts the
    /// controls back to what is actually saved and says so under them.
    private func persist(_ next: FeatureSettings) {
        guard next != model.snapshot.settings else { return }
        savesInFlight += 1
        Task { @MainActor in
            let saved = await model.saveSettings(next)
            savesInFlight -= 1
            if saved {
                saveError = nil
                return
            }
            // The failure is reported here, beside the control, rather than as
            // the root's generic alert once Settings closes.
            let reason = model.errorMessage
            model.errorMessage = nil
            saveError = ["Couldn't save.", reason].compactMap { $0 }.joined(separator: " ")
            PlatformHapticEngine.shared.play(.error)
            if savesInFlight == 0 { settings = model.snapshot.settings }
        }
    }

    // MARK: - Derived state

    private var hasServers: Bool { !model.snapshot.environments.isEmpty }

    private var activeEnvironment: FeatureEnvironment? {
        model.snapshot.environments.first(where: \.isActive)
    }

    private var activeEnvironmentPreferences: FeatureEnvironmentPreferences? {
        guard let id = activeEnvironment?.id else { return nil }
        return model.snapshot.preferencesByEnvironment?[id]
    }

    private var activeEnvironmentThemes: [EnvironmentTheme] {
        guard let id = activeEnvironment?.id else { return [] }
        return model.snapshot.environmentThemesByEnvironment?[id] ?? []
    }

    private var appearanceLabel: String {
        switch settings.appearance {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    private var selectedModel: FeatureModel? {
        guard let selection = settings.defaultSelection else { return nil }
        return model.snapshot.providers
            .first { $0.id == selection.providerID }?
            .models.first { $0.id == selection.modelID }
    }

    /// Marketing version and build, which is what a reader is being asked for
    /// when they are asked which version they are on.
    private var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String
        let build = info?["CFBundleVersion"] as? String
        switch (version, build) {
        case let (version?, build?): return "\(version) (\(build))"
        case let (version?, nil): return version
        default: return "Unknown"
        }
    }

    private var deviceManager: any FeatureDeviceManaging {
        (model.client as? any FeatureDeviceManaging) ?? EmptyFeatureDeviceManager.shared
    }

    /// Same optional-capability shape as ``deviceManager``: a client without the
    /// relay capability still reaches the screens, which then report the
    /// integration as unavailable instead of the rows being missing entirely.
    private var voiceSettingsManager: any FeatureVoiceSettingsManaging {
        (model.client as? any FeatureVoiceSettingsManaging)
            ?? EmptyFeatureVoiceSettingsManager.shared
    }

    private var serverSettingsManager: any FeatureServerSettingsManaging {
        (model.client as? any FeatureServerSettingsManaging)
            ?? EmptyFeatureServerSettingsManager.shared
    }

    private var scheduledTaskManager: any FeatureScheduledTaskManaging {
        (model.client as? any FeatureScheduledTaskManaging)
            ?? EmptyFeatureScheduledTaskManager.shared
    }
}

/// The large row at the top of Settings, shaped like the account card in the
/// system Settings app.
private struct SettingsServerCard: View {
    let title: String
    let systemImage: String
    let tint: T3SettingsTile.Tint
    let status: SettingsServerStatus?
    let detail: String?

    @ScaledMetric(relativeTo: .title3) private var tileSize: CGFloat = 56

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.system(size: tileSize * 0.48, weight: .medium))
                .foregroundStyle(tint.glyph)
                .frame(width: tileSize, height: tileSize)
                .background(tint.fill, in: RoundedRectangle(cornerRadius: tileSize * 0.25, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(2)
                statusLine
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var statusLine: some View {
        let parts = [status?.title, detail].compactMap { $0 }.filter { !$0.isEmpty }
        // A problem reads in its own color; a healthy line stays secondary.
        let textColor = status.flatMap { $0.isWarning ? $0.color : nil } ?? T3Colors.textSecondary
        if !parts.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                if let status {
                    Image(systemName: status.symbol)
                        .imageScale(.small)
                        .foregroundStyle(status.color)
                        .accessibilityHidden(true)
                }
                Text(parts.joined(separator: " · "))
                    .foregroundStyle(textColor)
                    .lineLimit(2)
            }
            .font(T3Typography.supporting)
        }
    }
}

/// How a saved server is doing, in the words and colors every Settings row uses.
struct SettingsServerStatus: Equatable {
    let title: String
    let symbol: String
    let color: Color
    var isWarning = false

    /// The card's subtitle for the server Settings is scoped to.
    static func card(
        for environment: FeatureEnvironment,
        isActive: Bool,
        connection: FeatureConnection.State
    ) -> SettingsServerStatus {
        guard isActive else { return row(for: environment, connection: connection) }
        switch connection {
        case .connected:
            return .init(title: "Connected", symbol: "circle.fill", color: T3Colors.success)
        case .connecting:
            return .init(title: "Connecting…", symbol: "wifi.exclamationmark", color: T3Colors.warning, isWarning: true)
        case .reconnecting:
            return .init(title: "Reconnecting…", symbol: "wifi.exclamationmark", color: T3Colors.warning, isWarning: true)
        case .disconnected:
            return .init(title: "Offline", symbol: "wifi.slash", color: T3Colors.danger, isWarning: true)
        }
    }

    /// A server's value in the Servers list. The active one reads the live
    /// connection; the others read their last probe.
    static func row(
        for environment: FeatureEnvironment,
        connection: FeatureConnection.State
    ) -> SettingsServerStatus {
        let state = environment.isActive ? connection : environment.connectionState
        switch state {
        case .connected where environment.isActive:
            return .init(title: "Connected", symbol: "circle.fill", color: T3Colors.success)
        case .connected:
            return .init(title: "Ready", symbol: "network", color: T3Colors.textSecondary)
        case .connecting, .reconnecting:
            return .init(title: environment.isActive ? "Connecting…" : "Checking", symbol: "wifi.exclamationmark", color: T3Colors.warning)
        case .disconnected:
            return .init(title: "Offline", symbol: "wifi.slash", color: T3Colors.danger)
        case nil:
            return .init(title: "Saved", symbol: "bookmark", color: T3Colors.textTertiary)
        }
    }

    /// The part of an endpoint worth reading on a phone: its host. Empty when
    /// the endpoint is unknown, so the caller drops it rather than printing a
    /// placeholder.
    static func host(_ endpoint: String) -> String {
        let trimmed = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        return URL(string: trimmed)?.host ?? trimmed
    }
}
