import SwiftUI

/// Server-authoritative provider settings.
///
/// Web renders this whole tree from the settings schema's `providerSettingsForm`
/// annotations; almost none of it is reachable from a phone (binary paths, CLI
/// launch arguments, config directories), so this screen carries the fields a
/// person would actually change from one — starting with Claude's
/// auto-compaction threshold, which is what keeps a long-lived thread from
/// burning usage on full history.
///
/// The write lands on one paired server. Without a connected environment there
/// is nothing to write to, so the section stays out rather than offering a row
/// that cannot save — the same rule the Browser section in Integrations follows.
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
    @State private var modelError: String?
    @State private var isSavingModels = false

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

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if let modelError { SettingsErrorBanner(message: modelError) }
                if environments.count > 1 {
                    Picker("Environment", selection: Binding(get: { environmentID ?? "" }, set: { selectedEnvironmentID = $0 })) {
                        ForEach(environments) { environment in Label(environment.name, systemImage: environment.machineSymbol).tag(environment.id) }
                    }.padding(.horizontal, SettingsMetrics.rowPadding).disabled(isSavingModels)
                }
                if let config = modelConfiguration {
                    SettingsSection(title: "Accounts") {
                        ForEach(config.providers) { provider in
                            NavigationLink {
                                providerEditor(provider.instanceId)
                            } label: {
                                HStack(spacing: 12) {
                                    ProviderIcon(driver: provider.driver, providerID: provider.instanceId, fallbackName: provider.displayName ?? provider.driver, size: 22)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(provider.displayName ?? provider.driver).font(T3Typography.supportingStrong).foregroundStyle(T3Colors.textPrimary)
                                        Text(provider.enabled ? provider.status : "Disabled").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                                    }
                                    Spacer()
                                    if let version = provider.version { Text(version).font(T3Typography.supporting).foregroundStyle(T3Colors.textTertiary).lineLimit(1) }
                                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(T3Colors.textTertiary)
                                }.padding(SettingsMetrics.rowPadding).frame(minHeight: T3Metrics.minimumTapTarget)
                            }.buttonStyle(.plain)
                        }
                    }
                }
                if let environmentID, modelConfiguration?.settings != nil || (environmentID == initialEnvironmentID && preferences != nil) {
                    SettingsSection(
                        title: "Claude",
                        footer: """
                        Claude summarizes the conversation once it passes this many tokens, \
                        without changing the model's context window. You can also send \
                        /compact in any Claude thread.
                        """
                    ) {
                        Button {
                            isEditingAutoCompact = true
                        } label: {
                            SettingsValueNavigationRow(
                                title: "Auto-compact after",
                                systemImage: "arrow.down.right.and.arrow.up.left",
                                value: ClaudeAutoCompactWindow.summary(for: storedAutoCompactWindow)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                    .sheet(isPresented: $isEditingAutoCompact) {
                        NavigationStack {
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
                        }
                        .presentationDragIndicator(.visible)
                    }
                } else {
                    SettingsSection(
                        title: "Claude",
                        footer: "Connect a server to change its agent settings."
                    ) {
                        SettingsValueNavigationRow(
                            title: "Auto-compact after",
                            systemImage: "arrow.down.right.and.arrow.up.left",
                            value: "Unavailable",
                            isEnabled: false
                        )
                    }
                }
            }
            .padding(.vertical, 18)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .task(id: environmentID) {
            modelConfiguration = nil
            modelError = nil
            guard let environmentID else { return }
            do {
                let config = try await serverSettings.providerModelConfiguration(environmentID: environmentID)
                guard !Task.isCancelled, self.environmentID == environmentID else { return }
                modelConfiguration = config
                savedAutoCompact[environmentID] = nil
            }
            catch { if !Task.isCancelled { modelError = error.localizedDescription } }
        }
        .navigationTitle("Agents")
        .navigationBarTitleDisplayMode(.inline)
    }
    @ViewBuilder
    private func providerEditor(_ providerID: String) -> some View {
        if let config = modelConfiguration,
           let provider = config.providers.first(where: { $0.instanceId == providerID }), let environmentID {
            let models = provider.models.filter { !$0.isCustom }
            let hidden = Set(config.settings?.providerModelPreferences[providerID]?.hiddenModels ?? [])
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let modelError { SettingsErrorBanner(message: modelError) }
                    Text(provider.message ?? (provider.enabled ? provider.status : "This account is disabled."))
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                    SettingsSection(title: "Models") {
                        if models.isEmpty { Text("This account has no available built-in models.").padding(SettingsMetrics.rowPadding) }
                        else {
                            Button(models.allSatisfy { hidden.contains($0.slug) } ? "Enable all" : "Disable all") {
                                let slugs = Set(models.map(\.slug))
                                saveModels(providerID, hidden: models.allSatisfy { hidden.contains($0.slug) } ? hidden.subtracting(slugs) : hidden.union(slugs), environmentID: environmentID)
                            }.frame(minHeight: T3Metrics.minimumTapTarget)
                            ForEach(models) { model in
                                Toggle(model.name, isOn: Binding(get: { !hidden.contains(model.slug) }, set: { enabled in
                                    var next = hidden
                                    if enabled { next.remove(model.slug) } else { next.insert(model.slug) }
                                    saveModels(providerID, hidden: next, environmentID: environmentID)
                                })).padding(.horizontal, SettingsMetrics.rowPadding)
                            }
                        }
                    }.disabled(isSavingModels)
                    if isSavingModels { ProgressView("Saving models…") }
                }.padding(18)
            }.background(T3Colors.background).navigationTitle(provider.displayName ?? provider.driver).navigationBarTitleDisplayMode(.inline)
        } else { ContentUnavailableView("Account unavailable", systemImage: "person.crop.circle.badge.questionmark") }
    }

    private func saveModels(_ providerID: String, hidden: Set<String>, environmentID: String) {
        guard !isSavingModels else { return }
        isSavingModels = true
        modelError = nil
        Task {
            defer { isSavingModels = false }
            do {
                try await serverSettings.updateServerSettings(environmentID: environmentID,
                    patch: ServerSettingsPatchInput(hiddenModelsByProvider: [providerID: hidden.sorted()]))
                let config = try await serverSettings.providerModelConfiguration(environmentID: environmentID)
                guard self.environmentID == environmentID else { return }
                modelConfiguration = config
            } catch { if self.environmentID == environmentID { modelError = "Could not save models: \(error.localizedDescription)" } }
        }
    }
}

/// Entry sheet for the auto-compaction threshold.
///
/// A dedicated sheet rather than an inline field because the value is validated
/// against a range: an inline field would have to grow an error line inside a
/// grouped row, and the row is also the only place the current value is shown.
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

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                SettingsSection(title: "Tokens") {
                    VStack(alignment: .leading, spacing: 12) {
                        TextField("e.g. 300,000", text: $text)
                            .keyboardType(.numberPad)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.done)
                            .focused($isFieldFocused)
                            .disabled(isSaving)
                            .settingsInputField()
                            .accessibilityLabel("Auto-compact after, in tokens")

                        if let errorMessage {
                            SettingsErrorBanner(message: errorMessage)
                        }

                        SettingsActionButton(
                            title: "Save",
                            systemImage: "checkmark",
                            tone: .primary,
                            isBusy: isSaving,
                            action: commit
                        )
                        .padding(.horizontal, SettingsMetrics.rowPadding)

                        // Clearing is the way back to Claude's default, and an
                        // empty field is easy to mistake for "unchanged", so the
                        // action says what it does.
                        if ClaudeAutoCompactWindow.tokens(from: stored) != nil {
                            SettingsActionButton(
                                title: "Use Claude's default",
                                systemImage: "arrow.uturn.backward",
                                isDisabled: isSaving
                            ) {
                                text = ""
                                commit()
                            }
                            .padding(.horizontal, SettingsMetrics.rowPadding)
                        }
                    }
                }

                SettingsFootnote(
                    """
                    Between \(ClaudeAutoCompactWindow.minimumTokens.formatted()) and \
                    \(ClaudeAutoCompactWindow.maximumTokens.formatted()) tokens. Leave empty to \
                    use Claude's default.
                    """
                )
            }
            .padding(.vertical, 18)
        }
        .scrollDismissesKeyboard(.interactively)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .navigationTitle("Auto-compact after")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { onFinished() }
                    .disabled(isSaving)
            }
        }
        .onAppear { isFieldFocused = true }
    }

    private func commit() {
        switch ClaudeAutoCompactWindow.normalize(text) {
        case let .failure(failure):
            errorMessage = ClaudeAutoCompactWindow.message(for: failure)
        case let .success(normalized):
            errorMessage = nil
            isSaving = true
            Task { @MainActor in
                do {
                    _ = try await save(normalized)
                    onFinished()
                } catch {
                    errorMessage = "Could not save: \(error.localizedDescription)"
                }
                isSaving = false
            }
        }
    }
}
