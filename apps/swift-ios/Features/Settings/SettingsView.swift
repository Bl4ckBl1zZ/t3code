import SwiftUI

public struct SettingsView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable private var model: FeatureRootModel
    @State private var settings: FeatureSettings
    @State private var isSaving = false
    @State private var showingDisconnect = false
    @State private var showingAddEnvironment = false
    @State private var showingDevices = false
    @State private var showingT3Connect = false
    @State private var showingIntegrations = false
    @State private var showingAgents = false
    @State private var showingVoiceInput = false
    @State private var showingAutomations = false
    @State private var showingHermesRuns = false
    @State private var showingUsage = false
    /// Lives here rather than in the runs screen so the badge on the row stays
    /// live without opening it, and so both read one subscription.
    @State private var hermesInboxStore = HermesInboxStore()
    @State private var removalTarget: FeatureEnvironment?
    @State private var saveErrorMessage: String?

    public init(model: FeatureRootModel) {
        self.model = model
        _settings = State(initialValue: model.snapshot.settings)
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                settingsHeader

                Divider()
                    .overlay(T3Colors.border)

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        connectionSection
                        t3ConnectSection
                        agentSection
                        ThemeSection(
                            appearance: $settings.appearance,
                            lightThemeID: $settings.lightThemeID,
                            darkThemeID: $settings.darkThemeID,
                            environmentName: activeEnvironment?.name,
                            environmentThemes: activeEnvironmentThemes
                        )
                        ThreadAppearanceSection(
                            alwaysExpandActivity: $settings.alwaysExpandActivity,
                            showSkillsInSlashMenu: $settings.showSkillsInSlashMenu
                        )
                        preferencesSection
                        configurationSection
                        aboutSection
                    }
                    .padding(.vertical, 18)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .background(T3Colors.background)
            .toolbar(.hidden, for: .navigationBar)
            .confirmationDialog(
                "Disconnect from this server?",
                isPresented: $showingDisconnect,
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) {
                    Task {
                        await model.disconnect()
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Your saved server and credentials will stay on this iPhone.")
            }
            .alert(
                "Remove saved server?",
                isPresented: Binding(
                    get: { removalTarget != nil },
                    set: { if !$0 { removalTarget = nil } }
                ),
                presenting: removalTarget
            ) { environment in
                Button("Remove", role: .destructive) {
                    Task {
                        await model.removeEnvironment(environment.id)
                        removalTarget = nil
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: { environment in
                Text("\(environment.name) will need a new pairing code to be added again.")
            }
            .alert(
                "Couldn’t save settings",
                isPresented: Binding(
                    get: { saveErrorMessage != nil },
                    set: { if !$0 { saveErrorMessage = nil } }
                )
            ) {
                Button("OK") { saveErrorMessage = nil }
            } message: {
                Text(saveErrorMessage ?? "Something went wrong.")
            }
            .sheet(isPresented: $showingAddEnvironment) {
                ConnectionOnboardingView(
                    model: model,
                    onConnected: {
                        showingAddEnvironment = false
                    },
                    onCancel: {
                        showingAddEnvironment = false
                    }
                )
            }
            .sheet(isPresented: $showingDevices) {
                NavigationStack {
                    DevicesView(manager: deviceManager)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Done") { showingDevices = false }
                            }
                        }
                }
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingIntegrations) {
                NavigationStack {
                    SettingsIntegrationsView(
                        manager: voiceSettingsManager,
                        serverSettings: serverSettingsManager,
                        environmentID: activeEnvironmentID,
                        preferences: activeEnvironmentPreferences
                    )
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Done") { showingIntegrations = false }
                            }
                        }
                }
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingAgents) {
                NavigationStack {
                    SettingsAgentsView(
                        serverSettings: serverSettingsManager,
                        environmentID: activeEnvironmentID,
                        preferences: activeEnvironmentPreferences
                    )
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Done") { showingAgents = false }
                            }
                        }
                }
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingVoiceInput) {
                NavigationStack {
                    SettingsVoiceInputView(manager: voiceSettingsManager)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Done") { showingVoiceInput = false }
                            }
                        }
                }
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingAutomations) {
                NavigationStack {
                    SettingsAutomationsView(model: model, manager: scheduledTaskManager)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Done") { showingAutomations = false }
                            }
                        }
                }
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingUsage) {
                NavigationStack {
                    SettingsUsageView(model: model)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Done") { showingUsage = false }
                            }
                        }
                }
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingHermesRuns) {
                NavigationStack {
                    SettingsHermesRunsView(
                        model: model,
                        manager: hermesInboxManager,
                        store: hermesInboxStore,
                        onOpenThread: openThreadFromHermesRun
                    )
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { showingHermesRuns = false }
                        }
                    }
                }
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingT3Connect) {
                if let capability = model.client as? any T3ConnectCapable {
                    NavigationStack {
                        T3ConnectView(capability: capability)
                            .toolbar {
                                ToolbarItem(placement: .cancellationAction) {
                                    Button("Done") { showingT3Connect = false }
                                }
                            }
                    }
                    .presentationDragIndicator(.visible)
                }
            }
            .onAppear {
                model.setConnectionManagementPresented(true)
            }
            .onDisappear {
                model.setConnectionManagementPresented(false)
            }
            .onChange(of: model.snapshot.settings) { previous, next in
                // A live `t3 theme set` may update the saved client settings
                // while this sheet is open. Preserve local edits, but keep an
                // untouched form from becoming a stale overwrite.
                if settings == previous { settings = next }
            }
            // Follows every environment's Hermes inbox for as long as Settings
            // is open, which is what keeps the row's badge honest before anyone
            // taps into the list.
            .task(id: model.snapshot.environments.map(\.id)) {
                await hermesInboxStore.observe(
                    environments: model.snapshot.environments,
                    manager: hermesInboxManager
                )
            }
        }
        .presentationDragIndicator(.visible)
    }

    /// Leaves Settings behind before routing: the thread opens in the workspace
    /// underneath, and a sheet still covering it would look like nothing
    /// happened.
    private func openThreadFromHermesRun(environmentID: String, threadID: String) {
        showingHermesRuns = false
        dismiss()
        NotificationCenter.default.post(
            name: .platformRouteReceived,
            object: nil,
            userInfo: ["route": PlatformRoute.thread(
                environmentID: environmentID,
                threadID: threadID
            )]
        )
    }

    private var settingsHeader: some View {
        // The title is centred by overlay rather than by two fixed-width
        // columns: "Saving…" is wider than "Save", and the old 72pt column
        // truncated it while shifting the title off centre as it changed.
        HStack(spacing: 12) {
            Button("Cancel") { dismiss() }
                .foregroundStyle(T3Colors.accent)

            Spacer(minLength: 12)

            Button {
                save()
            } label: {
                if isSaving {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Saving")
                } else {
                    Text("Save").fontWeight(.semibold)
                }
            }
            .foregroundStyle(canSave ? T3Colors.accent : T3Colors.textTertiary)
            .disabled(!canSave)
        }
        .font(T3Typography.control)
        .overlay {
            Text("Settings")
                .font(T3Typography.navigationTitle)
                .foregroundStyle(T3Colors.textPrimary)
                .accessibilityAddTraits(.isHeader)
        }
        .padding(.horizontal, SettingsMetrics.headerInset)
        .frame(minHeight: 54)
    }

    private var connectionSection: some View {
        SettingsSection(title: "Connections") {
            VStack(spacing: 0) {
                if model.snapshot.environments.isEmpty {
                    connectionFallbackRow
                } else {
                    ForEach(Array(model.snapshot.environments.enumerated()), id: \.element.id) {
                        index, environment in
                        if index > 0 {
                            settingsDivider
                        }
                        environmentRow(environment)
                    }
                }

                settingsDivider

                Button {
                    showingDevices = true
                } label: {
                    SettingsNavigationRow(
                        title: "Devices and sessions",
                        systemImage: "laptopcomputer.and.iphone"
                    )
                }
                .buttonStyle(.plain)

                settingsDivider

                Button {
                    showingAddEnvironment = true
                } label: {
                    SettingsActionRow(
                        title: "Add server",
                        systemImage: "plus"
                    )
                }
                .buttonStyle(.plain)

                settingsDivider

                Button(role: .destructive) {
                    showingDisconnect = true
                } label: {
                    SettingsActionRow(
                        title: "Disconnect current server",
                        systemImage: "rectangle.portrait.and.arrow.right",
                        color: T3Colors.danger
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var agentSection: some View {
        SettingsSection(title: "Default agent") {
            VStack(spacing: 0) {
                ProviderModelPicker(
                    providers: model.snapshot.providers,
                    selection: $settings.defaultSelection
                )
                .padding(.horizontal, SettingsMetrics.rowPadding)
                .frame(minHeight: 58)

                if let provider = selectedProvider {
                    SettingsRowDivider(isInsetForIcon: false)

                    SettingsValueRow(title: "Provider", value: provider.name)
                }

                if let detail = selectedModel?.detail {
                    SettingsRowDivider(isInsetForIcon: false)

                    Text(detail)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .padding(.horizontal, SettingsMetrics.rowPadding)
                        .padding(.vertical, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private var t3ConnectSection: some View {
        SettingsSection(
            title: "T3 Connect",
            footer: "Optional account sync for relay-managed environments."
        ) {
            if model.client is any T3ConnectCapable {
                Button {
                    showingT3Connect = true
                } label: {
                    SettingsNavigationRow(
                        title: "Cloud environments",
                        systemImage: "cloud"
                    )
                }
                .buttonStyle(.plain)
            } else {
                SettingsValueRow(
                    title: "Cloud environments",
                    value: "Unavailable",
                    systemImage: "cloud.slash"
                )
            }
        }
    }

    private var preferencesSection: some View {
        SettingsSection(title: "Preferences") {
            VStack(spacing: 0) {
                // Appearance moved into ThemeSection, where it sits with the
                // palette it selects a half of.
                SettingsToggleRow(
                    title: "Haptics",
                    systemImage: "iphone.radiowaves.left.and.right",
                    isOn: $settings.hapticsEnabled
                )
                settingsDivider
                SettingsToggleRow(
                    title: "Notifications",
                    systemImage: "bell",
                    isOn: $settings.notificationsEnabled
                )
                settingsDivider
                SettingsToggleRow(
                    title: "Live Activities",
                    systemImage: "waveform.path.ecg.rectangle",
                    isOn: $settings.liveActivitiesEnabled
                )
                settingsDivider
                SettingsToggleRow(
                    title: "Confirm before unpinning",
                    systemImage: "pin.slash",
                    isOn: $settings.confirmThreadUnpin
                )
            }
        }
    }

    /// The three screens the React Native client files under Configuration,
    /// General and Threads. They are one section here because this sheet is a
    /// single scroll rather than a navigation tree: three one-row sections would
    /// be three headers introducing nothing.
    private var configurationSection: some View {
        SettingsSection(title: "Features") {
            VStack(spacing: 0) {
                Button {
                    showingAgents = true
                } label: {
                    SettingsNavigationRow(
                        title: "Agents",
                        systemImage: "sparkles"
                    )
                }
                .buttonStyle(.plain)

                settingsDivider

                Button {
                    showingIntegrations = true
                } label: {
                    SettingsNavigationRow(
                        title: "Integrations",
                        systemImage: "point.3.connected.trianglepath.dotted"
                    )
                }
                .buttonStyle(.plain)

                settingsDivider

                Button {
                    showingVoiceInput = true
                } label: {
                    SettingsNavigationRow(
                        title: "Voice Input",
                        systemImage: "mic"
                    )
                }
                .buttonStyle(.plain)

                settingsDivider

                Button {
                    showingAutomations = true
                } label: {
                    SettingsNavigationRow(
                        title: "Automations",
                        systemImage: "calendar.badge.clock"
                    )
                }
                .buttonStyle(.plain)

                settingsDivider

                Button {
                    showingHermesRuns = true
                } label: {
                    SettingsNavigationRow(
                        title: "Hermes Runs",
                        systemImage: "clock.arrow.circlepath",
                        badge: HermesRunLabels.badgeText(unreadCount: hermesInboxStore.totalUnreadCount)
                    )
                }
                .buttonStyle(.plain)

                settingsDivider

                Button {
                    showingUsage = true
                } label: {
                    SettingsNavigationRow(
                        title: "Usage",
                        systemImage: "chart.bar.xaxis"
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var aboutSection: some View {
        SettingsSection(title: "About") {
            VStack(spacing: 0) {
                SettingsValueRow(
                    title: "Version",
                    value: appVersion,
                    systemImage: "info.circle"
                )
                settingsDivider
                Link(destination: URL(string: "https://github.com/pingdotgg/t3code")!) {
                    SettingsNavigationRow(
                        title: "Open source",
                        systemImage: "chevron.left.forwardslash.chevron.right",
                        trailingSystemImage: "arrow.up.right"
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var connectionFallbackRow: some View {
        HStack(spacing: 12) {
            SettingsRowIcon(systemName: connectionSymbol, color: connectionColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.snapshot.connection.environmentName ?? "T3 server")
                    .font(T3Typography.homeTitle)
                    .foregroundStyle(T3Colors.textPrimary)
                Text(connectionDescription)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(connectionStatus)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(connectionColor)
        }
        .padding(.horizontal, SettingsMetrics.rowPadding)
        .frame(minHeight: 58)
        .accessibilityElement(children: .combine)
    }

    private func environmentRow(_ environment: FeatureEnvironment) -> some View {
        Button {
            guard !environment.isActive else { return }
            Task { await model.activateEnvironment(environment.id) }
        } label: {
            HStack(spacing: 12) {
                let status = environmentStatus(for: environment)
                let activeIsConnected = environment.isActive
                    && model.snapshot.connection.state == .connected
                SettingsRowIcon(
                    systemName: activeIsConnected ? "checkmark.circle.fill" : "desktopcomputer",
                    color: activeIsConnected ? T3Colors.success : T3Colors.textTertiary
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text(environment.name)
                        .font(T3Typography.homeTitle)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    Text(environment.endpoint)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                Spacer(minLength: 8)

                Label(status.title, systemImage: status.symbol)
                    .labelStyle(SettingsStatusLabelStyle())
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(status.color)

            }
            .padding(.leading, SettingsMetrics.rowPadding)
            .padding(.trailing, environment.isActive ? SettingsMetrics.rowPadding : 52)
            .frame(minHeight: 62)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint(environment.isActive ? "Current server" : "Switch to this server")
        .overlay(alignment: .trailing) {
            if !environment.isActive {
                Menu {
                    Button(role: .destructive) {
                        removalTarget = environment
                    } label: {
                        Label("Remove saved server", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(T3Typography.control)
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(width: T3Metrics.minimumTapTarget, height: 62)
                        .contentShape(Rectangle())
                }
                .padding(.trailing, 8)
                .accessibilityLabel("Actions for \(environment.name)")
            }
        }
        .contextMenu {
            if !environment.isActive {
                Button(role: .destructive) {
                    removalTarget = environment
                } label: {
                    Label("Remove saved server", systemImage: "trash")
                }
            }
        }
    }

    private var settingsDivider: some View { SettingsRowDivider() }

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

    private var canSave: Bool {
        !isSaving && settings != model.snapshot.settings
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

    /// The server a server-authoritative row writes to. Settings is otherwise
    /// scoped to the connected environment — it is the one "Disconnect current
    /// server" means — so a setting belonging to a server follows the same one.
    private var activeEnvironmentID: String? {
        model.snapshot.environments.first(where: \.isActive)?.id
    }

    private var activeEnvironmentPreferences: FeatureEnvironmentPreferences? {
        guard let activeEnvironmentID else { return nil }
        return model.snapshot.preferencesByEnvironment?[activeEnvironmentID]
    }

    private var activeEnvironment: FeatureEnvironment? {
        model.snapshot.environments.first(where: \.isActive)
    }

    private var activeEnvironmentThemes: [EnvironmentTheme] {
        guard let environmentID = activeEnvironment?.id else { return [] }
        return model.snapshot.environmentThemesByEnvironment?[environmentID] ?? []
    }

    private var scheduledTaskManager: any FeatureScheduledTaskManaging {
        (model.client as? any FeatureScheduledTaskManaging)
            ?? EmptyFeatureScheduledTaskManager.shared
    }

    private var hermesInboxManager: any FeatureHermesInboxManaging {
        (model.client as? any FeatureHermesInboxManaging)
            ?? EmptyFeatureHermesInboxManager.shared
    }

    private var selectedProvider: FeatureProvider? {
        guard let selection = settings.defaultSelection else { return nil }
        return model.snapshot.providers.first { $0.id == selection.providerID }
    }

    private var selectedModel: FeatureModel? {
        guard let selection = settings.defaultSelection else { return nil }
        return selectedProvider?.models.first { $0.id == selection.modelID }
    }

    private var connectionStatus: String {
        switch model.snapshot.connection.state {
        case .connected: "Online"
        case .connecting: "Connecting"
        case .reconnecting: "Reconnecting"
        case .disconnected: "Offline"
        }
    }

    private var connectionSymbol: String {
        model.snapshot.connection.state == .connected ? "checkmark.circle.fill" : "network.slash"
    }

    private var connectionColor: Color {
        model.snapshot.connection.state == .connected ? .green : .secondary
    }

    private var connectionDescription: String {
        model.snapshot.connection.endpoint ?? "No active server"
    }

    private func environmentStatus(
        for environment: FeatureEnvironment
    ) -> EnvironmentStatusPresentation {
        let state = environment.isActive
            ? model.snapshot.connection.state
            : environment.connectionState
        switch state {
        case .connected where environment.isActive:
            return EnvironmentStatusPresentation(
                title: "Active",
                symbol: "dot.radiowaves.left.and.right",
                color: T3Colors.accent
            )
        case .connected:
            return EnvironmentStatusPresentation(
                title: "Ready",
                symbol: "network",
                color: T3Colors.textSecondary
            )
        case .connecting, .reconnecting:
            return EnvironmentStatusPresentation(
                title: "Checking",
                symbol: "arrow.triangle.2.circlepath",
                color: T3Colors.warning
            )
        case .disconnected:
            return EnvironmentStatusPresentation(
                title: "Offline",
                symbol: "network.slash",
                color: T3Colors.danger
            )
        case nil:
            return EnvironmentStatusPresentation(
                title: "Saved",
                symbol: "bookmark",
                color: T3Colors.textTertiary
            )
        }
    }

    @MainActor
    private func save() {
        isSaving = true
        Task {
            let didSave = await model.saveSettings(settings)
            isSaving = false
            if didSave {
                dismiss()
            } else {
                saveErrorMessage = model.errorMessage ?? "Settings could not be saved."
            }
        }
    }
}

private struct EnvironmentStatusPresentation {
    let title: String
    let symbol: String
    let color: Color
}

/// The settings row vocabulary. Internal rather than private so every settings
/// screen in this folder renders from the same chrome instead of re-deriving it.
/// Shared metrics for the settings screens.
///
/// Named rather than repeated so a row, its divider and its card cannot drift
/// apart — the previous inset was a literal in five files and had already
/// stopped matching the icon it was supposed to clear.
enum SettingsMetrics {
    /// Card inset from the screen edge.
    static let cardInset: CGFloat = 16
    /// Row padding inside a card.
    static let rowPadding: CGFloat = 12
    static let rowMinHeight: CGFloat = 52
    static let iconSize: CGFloat = 36
    static let iconGap: CGFloat = 12
    /// Starts at the icon's trailing edge, so the rule reads as a list
    /// separator instead of cutting the card in half.
    static let dividerInset: CGFloat = rowPadding + iconSize
    static let cardRadius: CGFloat = 20
    /// Section headers, and the footnotes that sit beside cards rather than in
    /// them, align here — the card's own inset plus its internal header inset.
    static let headerInset: CGFloat = cardInset + 4
}

/// A titled card of rows.
///
/// Matches `ThreadDetailsSection`, which is the card treatment the rest of the
/// app already uses. Settings previously drew its rows straight onto the page
/// background with a full-bleed rule between them, so the one screen a reader
/// opens to change something looked less finished than the sheet they opened it
/// from.
struct SettingsSection<Content: View>: View {
    let title: String
    let footer: String?
    let content: Content

    init(
        title: String,
        footer: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(T3Typography.eyebrow)
                .kerning(0.9)
                .foregroundStyle(T3Colors.textTertiary)
                .padding(.horizontal, 4)
                .frame(minHeight: 24, alignment: .leading)
                .accessibilityAddTraits(.isHeader)

            VStack(spacing: 0) {
                content
            }
            .background(T3Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: SettingsMetrics.cardRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: SettingsMetrics.cardRadius, style: .continuous)
                    .strokeBorder(T3Colors.border, lineWidth: 1)
            )

            if let footer {
                Text(footer)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .padding(.horizontal, 4)
                    .padding(.top, 2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, SettingsMetrics.cardInset)
    }
}

/// The icon puck, matching `ThreadDetailsRowIcon`.
///
/// Neutral by default. Color is spent only where it carries meaning — a
/// destructive action, a connected server — rather than tinting every row,
/// which made the old screen read as a wall of accent blue with no hierarchy.
struct SettingsRowIcon: View {
    let systemName: String
    var color: Color = T3Colors.textSecondary

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 16, weight: .medium))
            .foregroundStyle(color)
            .frame(width: SettingsMetrics.iconSize, height: SettingsMetrics.iconSize)
            .background(T3Colors.subtle, in: Circle())
            .accessibilityHidden(true)
    }
}

struct SettingsNavigationRow: View {
    let title: String
    let systemImage: String
    var trailingSystemImage = "chevron.right"
    /// Unread-style count shown before the chevron. `nil` draws no badge, so a
    /// row that has nothing waiting keeps its plain shape.
    var badge: String?

    var body: some View {
        HStack(spacing: 12) {
            SettingsRowIcon(systemName: systemImage)
            Text(title)
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textPrimary)
            Spacer(minLength: 8)
            if let badge {
                Text(badge)
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(T3Colors.accent, in: Capsule())
                    .accessibilityLabel("\(badge) unread")
            }
            Image(systemName: trailingSystemImage)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textTertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, SettingsMetrics.rowPadding)
        .frame(minHeight: SettingsMetrics.rowMinHeight)
        .contentShape(Rectangle())
    }
}

struct SettingsActionRow: View {
    let title: String
    let systemImage: String
    var color: Color = T3Colors.accent

    var body: some View {
        HStack(spacing: 12) {
            SettingsRowIcon(systemName: systemImage, color: color)
            Text(title)
                .font(T3Typography.threadBody)
                .foregroundStyle(color)
            Spacer(minLength: 8)
        }
        .padding(.horizontal, SettingsMetrics.rowPadding)
        .frame(minHeight: SettingsMetrics.rowMinHeight)
        .contentShape(Rectangle())
    }
}

struct SettingsValueRow: View {
    let title: String
    let value: String
    var systemImage: String? = nil

    var body: some View {
        HStack(spacing: SettingsMetrics.iconGap) {
            if let systemImage {
                SettingsRowIcon(systemName: systemImage)
            }
            Text(title)
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textPrimary)
            Spacer(minLength: 12)
            Text(value)
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, SettingsMetrics.rowPadding)
        .frame(minHeight: SettingsMetrics.rowMinHeight)
        .accessibilityElement(children: .combine)
    }
}

struct SettingsToggleRow: View {
    let title: String
    let systemImage: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            HStack(spacing: 12) {
                SettingsRowIcon(systemName: systemImage)
                Text(title)
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textPrimary)
            }
        }
        .tint(T3Colors.accent)
        .padding(.horizontal, SettingsMetrics.rowPadding)
        .frame(minHeight: SettingsMetrics.rowMinHeight)
    }
}

private struct SettingsStatusLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
            configuration.title
        }
    }
}
