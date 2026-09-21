import SwiftUI

/// Provider accounts and model settings on the selected paired server.
public struct SettingsAgentsView: View {
    private let serverSettings: any FeatureServerSettingsManaging
    private let initialEnvironmentID: String?
    private let environments: [FeatureEnvironment]
    @State private var selectedEnvironmentID: String?
    private var environmentID: String? { selectedEnvironmentID ?? initialEnvironmentID }
    /// The server's own answer, republished whenever the config subscription
    /// reports it changing.
    private let preferences: FeatureEnvironmentPreferences?

    @State private var savedAutoCompact: [String: String] = [:]
    @State private var isEditingAutoCompact = false
    @State private var modelConfiguration: ServerConfigSnapshot?
    @State private var loadedEnvironmentID: String?
    @State private var modelError: String?
    /// Add Account, presented from this page.
    @State private var accountEditor: AccountEditorTarget?
    /// Configuration, presented from the pushed account page so the sheet
    /// comes from the view on screen.
    @State private var configurationEditor: AccountEditorTarget?
    /// Hidden-model sets written but not yet read back, by provider. The
    /// toggles read these first so a tap shows at once.
    @State private var pendingHidden: [String: Set<String>] = [:]
    @State private var savingModels: Set<String> = []
    @State private var modelWriteError: String?
    @State private var modelWritesInFlight = 0

    private struct AccountEditorTarget: Identifiable {
        let environmentID: String
        let instanceID: String?
        let driver: String?
        var id: String { "\(environmentID)|\(instanceID ?? "new")" }
    }

    public init(
        serverSettings: any FeatureServerSettingsManaging,
        environmentID: String?,
        preferences: FeatureEnvironmentPreferences?,
        environments: [FeatureEnvironment] = []
    ) {
        self.serverSettings = serverSettings
        self.initialEnvironmentID = environmentID
        self.environments = environments
        self.preferences = preferences
    }

    private var storedAutoCompactWindow: String {
        savedAutoCompact[environmentID ?? ""] ?? modelConfiguration?.settings?.claudeAutoCompactWindow ?? (environmentID == initialEnvironmentID ? preferences?.claudeAutoCompactWindow : nil) ?? ""
    }

    private var autoCompactSummary: String {
        ClaudeAutoCompactWindow.tokens(from: storedAutoCompactWindow) == nil
            ? "Default"
            : ClaudeAutoCompactWindow.summary(for: storedAutoCompactWindow)
    }

    public var body: some View {
        content
            .settingsServerScope(
                title: "Agents",
                environments: environments,
                selection: Binding(get: { environmentID ?? "" }, set: { selectedEnvironmentID = $0 }),
                isEnabled: modelWritesInFlight == 0
            )
            .task(id: environmentID) { await load() }
            .sheet(item: $accountEditor) { accountSheet($0) }
            .sheet(isPresented: $isEditingAutoCompact) {
                if let environmentID {
                    ClaudeAutoCompactWindowEditor(
                        stored: storedAutoCompactWindow,
                        save: { normalized in
                            let result = try await serverSettings.updateServerSettings(
                                environmentID: environmentID,
                                patch: ServerSettingsPatchInput(claudeAutoCompactWindow: normalized)
                            )
                            savedAutoCompact[environmentID] = result.claudeAutoCompactWindow
                            return result
                        },
                        onFinished: { isEditingAutoCompact = false }
                    )
                    .presentationDetents([.medium, .large])
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if environmentID == nil {
            ContentUnavailableView(
                "No Server",
                systemImage: "cpu",
                description: Text("Connect a server to change its agent settings.")
            )
            .background(T3Colors.background)
        } else {
            SettingsForm {
                accountsSection
                claudeSection
            }
            .refreshable { await load() }
        }
    }

    @ViewBuilder
    private var accountsSection: some View {
        if let config = modelConfiguration, let environmentID {
            Section {
                ForEach(config.providers) { provider in
                    NavigationLink {
                        providerEditor(provider.instanceId)
                    } label: {
                        accountLabel(provider)
                    }
                }
                Button("Add Account…") {
                    accountEditor = AccountEditorTarget(environmentID: environmentID, instanceID: nil, driver: nil)
                }
                .disabled(!accountsSupported(environmentID))
            } header: {
                Text("Accounts")
            } footer: {
                if config.providers.isEmpty {
                    Text("No provider accounts on this server yet.")
                } else if !accountsSupported(environmentID) {
                    Text("Update this server to add provider accounts.")
                }
            }
        } else if let modelError {
            SettingsRetrySection(message: modelError) { Task { await load() } }
        } else {
            Section("Accounts") { SettingsPlaceholderRows(count: 3) }
        }
    }

    private func accountLabel(_ provider: ServerProviderSnapshot) -> some View {
        HStack(spacing: 12) {
            ProviderIcon(
                driver: provider.driver,
                providerID: provider.instanceId,
                fallbackName: provider.displayName ?? provider.driver,
                size: 29
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.displayName ?? provider.driver)
                    .foregroundStyle(T3Colors.textPrimary)
                Text(SettingsAgentStatus.label(for: provider))
                    .font(T3Typography.supporting)
                    .foregroundStyle(SettingsAgentStatus.color(for: provider))
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var claudeSection: some View {
        let available = modelConfiguration?.settings != nil
            || (environmentID == initialEnvironmentID && preferences != nil)
        Section {
            Button {
                isEditingAutoCompact = true
            } label: {
                LabeledContent("Auto-Compact After", value: available ? autoCompactSummary : "Unavailable")
                    .foregroundStyle(T3Colors.textPrimary)
            }
            .disabled(!available)
        } header: {
            Text("Claude")
        } footer: {
            Text("""
            Claude summarizes the conversation once it passes this many tokens, \
            without changing the model's context window. You can also send \
            /compact in any Claude thread.
            """)
        }
    }

    // MARK: - Account page

    @ViewBuilder
    private func providerEditor(_ providerID: String) -> some View {
        if let config = modelConfiguration,
           let provider = config.providers.first(where: { $0.instanceId == providerID }), let environmentID {
            let models = provider.models.filter { !$0.isCustom }
            let hidden = hiddenModels(providerID, in: config)
            SettingsForm {
                Section {
                    LabeledContent("Status") {
                        Text(SettingsAgentStatus.label(for: provider))
                            .foregroundStyle(SettingsAgentStatus.color(for: provider))
                    }
                    if let version = provider.version {
                        LabeledContent("Version", value: version)
                    }
                } footer: {
                    if let message = provider.message {
                        Text(message)
                    } else if !provider.enabled {
                        Text("This account is off. Turn it on in Configuration to use it for new runs.")
                    }
                }
                Section {
                    Button {
                        configurationEditor = AccountEditorTarget(environmentID: environmentID, instanceID: providerID, driver: provider.driver)
                    } label: {
                        Label("Configuration", systemImage: "slider.horizontal.3")
                            .foregroundStyle(T3Colors.textPrimary)
                    }
                    if let client = serverSettings as? any FeatureClient,
                       let context = ProviderSetupContext(client: client, environmentID: environmentID),
                       provider.driver == "codex" || provider.driver == "claudeAgent" {
                        NavigationLink { ProviderSetupView(context: context, instanceID: providerID) } label: {
                            Label("Install or Sign In", systemImage: "person.crop.circle.badge.checkmark")
                        }
                    }
                    NavigationLink {
                        SettingsCustomModelsView(
                            manager: serverSettings,
                            environmentID: environmentID,
                            provider: provider,
                            supported: accountsSupported(environmentID)
                        )
                    } label: {
                        Label("Custom Models", systemImage: "cube.transparent")
                    }
                }
                Section {
                    if models.isEmpty {
                        Text("No built-in models.").foregroundStyle(T3Colors.textSecondary)
                    }
                    ForEach(models) { model in
                        HStack {
                            Toggle(model.name, isOn: Binding(
                                get: { !hidden.contains(model.slug) },
                                set: { enabled in
                                    var next = hidden
                                    if enabled { next.remove(model.slug) } else { next.insert(model.slug) }
                                    saveModels(providerID, hidden: next, changed: [model.slug], environmentID: environmentID)
                                }
                            ))
                            if savingModels.contains("\(providerID)|\(model.slug)") {
                                ProgressView().padding(.leading, 8)
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text("Models")
                        Spacer()
                        if !models.isEmpty {
                            let allOff = models.allSatisfy { hidden.contains($0.slug) }
                            Button(allOff ? "Turn All On" : "Turn All Off") {
                                let slugs = Set(models.map(\.slug))
                                saveModels(
                                    providerID,
                                    hidden: allOff ? hidden.subtracting(slugs) : hidden.union(slugs),
                                    changed: slugs,
                                    environmentID: environmentID
                                )
                            }
                            .font(T3Typography.supporting)
                            .textCase(nil)
                        }
                    }
                } footer: {
                    SettingsFooter(text: "Models turned off are hidden from pickers on every device.", error: modelWriteError)
                }
            }
            .navigationTitle(provider.displayName ?? provider.driver)
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: $configurationEditor) { accountSheet($0) }
        } else {
            ContentUnavailableView(
                "Account Unavailable",
                systemImage: "person.crop.circle.badge.questionmark",
                description: Text("This account was removed or this server is unreachable.")
            )
            .background(T3Colors.background)
        }
    }

    private func accountSheet(_ target: AccountEditorTarget) -> some View {
        SettingsProviderAccountView(
            manager: serverSettings,
            environmentID: target.environmentID,
            instanceID: target.instanceID,
            driver: target.driver,
            supported: accountsSupported(target.environmentID),
            serverName: environments.first { $0.id == target.environmentID }?.name
        ) { await refreshAccounts(target.environmentID) }
    }

    private func hiddenModels(_ providerID: String, in config: ServerConfigSnapshot) -> Set<String> {
        pendingHidden[providerID] ?? Set(config.settings?.providerModelPreferences[providerID]?.hiddenModels ?? [])
    }

    private func accountsSupported(_ environmentID: String) -> Bool {
        environments.first { $0.id == environmentID }?.supportsCustomModelDefinitions == true
    }

    // MARK: - Requests

    private func load() async {
        guard let environmentID else { return }
        if loadedEnvironmentID != environmentID {
            // Another server's accounts must not show under this one's name.
            modelConfiguration = nil
            pendingHidden = [:]
            modelWriteError = nil
        }
        modelError = nil
        do {
            let config = try await serverSettings.providerModelConfiguration(environmentID: environmentID)
            guard !Task.isCancelled, self.environmentID == environmentID else { return }
            modelConfiguration = config
            loadedEnvironmentID = environmentID
            savedAutoCompact[environmentID] = nil
        } catch {
            if !Task.isCancelled, self.environmentID == environmentID, modelConfiguration == nil {
                modelError = error.localizedDescription
            }
        }
    }

    private func refreshAccounts(_ environmentID: String) async {
        do {
            let config = try await serverSettings.providerModelConfiguration(environmentID: environmentID)
            guard self.environmentID == environmentID else { return }
            modelConfiguration = config
            savedAutoCompact[environmentID] = nil
            modelError = nil
        } catch {
            if self.environmentID == environmentID, modelConfiguration == nil { modelError = error.localizedDescription }
        }
    }

    /// Writes the provider's whole hidden list, so the latest tap always wins
    /// even with earlier writes still in flight. A failure puts the toggles
    /// back to what the server last said.
    private func saveModels(_ providerID: String, hidden: Set<String>, changed: Set<String>, environmentID: String) {
        pendingHidden[providerID] = hidden
        modelWriteError = nil
        let keys = Set(changed.map { "\(providerID)|\($0)" })
        savingModels.formUnion(keys)
        modelWritesInFlight += 1
        Task {
            var failed = false
            do {
                try await serverSettings.updateServerSettings(
                    environmentID: environmentID,
                    patch: ServerSettingsPatchInput(hiddenModelsByProvider: [providerID: hidden.sorted()])
                )
            } catch {
                failed = true
                PlatformHapticEngine.shared.play(.error)
                if self.environmentID == environmentID {
                    modelWriteError = "Couldn't save. \(error.localizedDescription)"
                }
            }
            savingModels.subtract(keys)
            modelWritesInFlight -= 1
            if failed { pendingHidden[providerID] = nil }
            guard modelWritesInFlight == 0, self.environmentID == environmentID else { return }
            if let config = try? await serverSettings.providerModelConfiguration(environmentID: environmentID),
               self.environmentID == environmentID, modelWritesInFlight == 0 {
                modelConfiguration = config
                pendingHidden = [:]
            }
        }
    }
}

/// How an account's state reads in Settings, in place of the server's raw
/// status values.
enum SettingsAgentStatus {
    static func label(for provider: ServerProviderSnapshot) -> String {
        guard provider.enabled else { return "Off" }
        if !provider.installed { return "Not Installed" }
        switch provider.status {
        case "ready": return "Ready"
        case "warning": return "Needs Attention"
        case "error": return "Error"
        case "disabled": return "Off"
        default: return provider.status.prefix(1).uppercased() + provider.status.dropFirst()
        }
    }

    static func color(for provider: ServerProviderSnapshot) -> Color {
        guard provider.enabled, provider.installed else { return T3Colors.textSecondary }
        switch provider.status {
        case "warning": return T3Colors.warning
        case "error": return T3Colors.danger
        default: return T3Colors.textSecondary
        }
    }
}

/// Entry sheet for the auto-compaction threshold.
///
/// A sheet rather than an inline field because the value is validated against
/// a range, and the row is also the only place the current value is shown.
struct ClaudeAutoCompactWindowEditor: View {
    let stored: String
    /// Returns the server's own answer, which is what makes a clamped or
    /// rejected value visible instead of silently accepted.
    let save: (String) async throws -> FeatureEnvironmentPreferences
    let onFinished: () -> Void

    @State private var text: String
    @State private var errorMessage: String?
    @State private var isSaving = false
    @FocusState private var isFieldFocused: Bool

    init(
        stored: String,
        save: @escaping (String) async throws -> FeatureEnvironmentPreferences,
        onFinished: @escaping () -> Void
    ) {
        self.stored = stored
        self.save = save
        self.onFinished = onFinished
        _text = State(initialValue: ClaudeAutoCompactWindow.editableText(for: stored))
    }

    private var validation: String? {
        if case let .failure(failure) = ClaudeAutoCompactWindow.normalize(text) {
            return ClaudeAutoCompactWindow.message(for: failure)
        }
        return nil
    }

    private var hasChanges: Bool {
        text != ClaudeAutoCompactWindow.editableText(for: stored)
    }

    var body: some View {
        NavigationStack {
            SettingsForm {
                Section {
                    LabeledContent("Tokens") {
                        TextField("Default", text: $text)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                            .focused($isFieldFocused)
                            .disabled(isSaving)
                    }
                } footer: {
                    SettingsFooter(
                        text: """
                        Between \(ClaudeAutoCompactWindow.minimumTokens.formatted()) and \
                        \(ClaudeAutoCompactWindow.maximumTokens.formatted()) tokens. Leave empty to \
                        use Claude's default.
                        """,
                        error: validation ?? errorMessage
                    )
                }
                // Clearing is the way back to Claude's default, and an empty
                // field is easy to mistake for "unchanged", so the action says
                // what it does.
                if ClaudeAutoCompactWindow.tokens(from: stored) != nil {
                    Section {
                        Button("Use Claude's Default") {
                            text = ""
                            commit()
                        }
                        .disabled(isSaving)
                    }
                }
            }
            .navigationTitle("Auto-Compact After")
            .navigationBarTitleDisplayMode(.inline)
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: "Save",
                    isEnabled: hasChanges && validation == nil && !isSaving,
                    isBusy: isSaving,
                    action: commit
                ),
                hasChanges: hasChanges || isSaving,
                onDismiss: onFinished
            )
            .onAppear { isFieldFocused = true }
        }
    }

    private func commit() {
        guard case let .success(normalized) = ClaudeAutoCompactWindow.normalize(text) else { return }
        errorMessage = nil
        isSaving = true
        Task { @MainActor in
            do {
                _ = try await save(normalized)
                PlatformHapticEngine.shared.play(.success)
                onFinished()
            } catch {
                PlatformHapticEngine.shared.play(.error)
                errorMessage = "Couldn't save. \(error.localizedDescription)"
            }
            isSaving = false
        }
    }
}
