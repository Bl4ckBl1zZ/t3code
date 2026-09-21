import SwiftUI

// Ported from apps/mobile/src/features/settings/SettingsIntegrationsRouteScreen.tsx,
// which exports both of the screens below.

/// The integrations index. OpenRouter is the only entry today, but the screen
/// exists as a list because the row's job is to surface connection state
/// without making the reader open the detail to see it.
public struct SettingsIntegrationsView: View {
    private let manager: any FeatureVoiceSettingsManaging
    private let serverSettings: any FeatureServerSettingsManaging
    /// The server the browser row describes. Nil while none is connected,
    /// which — along with a nil `preferences` — leaves that row out.
    private let environmentID: String?
    /// The server's own answer, republished whenever the config subscription
    /// reports it changing.
    private let preferences: FeatureEnvironmentPreferences?

    @State private var status: OpenRouterIntegrationStatus?
    @State private var isLoaded = false

    public init(
        manager: any FeatureVoiceSettingsManaging,
        serverSettings: any FeatureServerSettingsManaging,
        environmentID: String?,
        preferences: FeatureEnvironmentPreferences?
    ) {
        self.manager = manager
        self.serverSettings = serverSettings
        self.environmentID = environmentID
        self.preferences = preferences
    }

    private var connectionLabel: String {
        VoiceIntegrationLabels.connection(status, isLoaded: isLoaded)
    }

    public var body: some View {
        SettingsForm {
            Section {
                NavigationLink {
                    SettingsOpenRouterView(manager: manager) { latest in
                        // The detail owns the credential, so the index takes its
                        // word for the status instead of re-fetching on return.
                        status = latest
                        isLoaded = true
                    }
                } label: {
                    LabeledContent {
                        Text(connectionLabel)
                            .foregroundStyle(connectionLabel == "Error" ? T3Colors.danger : T3Colors.textSecondary)
                            .redacted(reason: isLoaded ? [] : .placeholder)
                    } label: {
                        SettingsTileLabel(title: "OpenRouter", systemImage: "waveform", tint: .indigo)
                    }
                }
            } footer: {
                Text(isLoaded && status == nil
                    ? "OpenRouter powers Voice Input transcription. Couldn't reach the server to check it."
                    : "OpenRouter powers Voice Input transcription.")
            }

            if let preferences, environmentID != nil {
                // Browser access is a server setting whose home is Project
                // Defaults, where projects can also override it.
                Section {
                    NavigationLink(value: SettingsRoute.projectDefaults) {
                        LabeledContent {
                            Text(preferences.enableAgentBrowserAccess ? "On" : "Off")
                        } label: {
                            SettingsTileLabel(title: "Agent Browser Access", systemImage: "globe", tint: .blue)
                        }
                    }
                } footer: {
                    Text("Set in Project Defaults, where each project can override it.")
                }
            }
        }
        .navigationTitle("Integrations")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    @MainActor
    private func load() async {
        // A failed status request settles as "Unavailable" rather than as an
        // error: the row is informational, and the detail screen is where a
        // reader can act on the failure.
        status = try? await manager.openRouterIntegration()
        isLoaded = true
    }
}

/// OpenRouter credential management: enter a key, revalidate it, or disconnect.
/// Existing keys are never displayed, only hinted at.
public struct SettingsOpenRouterView: View {
    private enum Action: Equatable {
        case load, connect, revalidate, disconnect
    }

    private let manager: any FeatureVoiceSettingsManaging
    private let onStatusChange: (OpenRouterIntegrationStatus) -> Void

    @State private var status: OpenRouterIntegrationStatus?
    @State private var apiKey = ""
    @State private var busyAction: Action?
    @State private var isLoaded = false
    @State private var errorMessage: String?
    @State private var showingDisconnect = false

    public init(
        manager: any FeatureVoiceSettingsManaging,
        onStatusChange: @escaping (OpenRouterIntegrationStatus) -> Void = { _ in }
    ) {
        self.manager = manager
        self.onStatusChange = onStatusChange
    }

    /// A client that cannot manage the credential at all. Every write would
    /// throw, so the actions are off rather than offered and then refused.
    private var isSupported: Bool {
        !(manager is EmptyFeatureVoiceSettingsManager)
    }

    private var isBusy: Bool { busyAction != nil }

    public var body: some View {
        SettingsForm {
            statusSection
            if isLoaded {
                keySection
                if status?.configured == true {
                    Section {
                        Button {
                            Task { await run(.revalidate) { try await manager.validateOpenRouterCredential() } }
                        } label: {
                            rowLabel("Revalidate Key", action: .revalidate)
                        }
                        .disabled(isBusy || !isSupported)
                    }
                }
                Section {
                    Link(destination: URL(string: "https://openrouter.ai/settings/keys")!) {
                        HStack {
                            Text("Manage Keys on OpenRouter")
                            Spacer()
                            Image(systemName: "arrow.up.forward.square")
                                .foregroundStyle(T3Colors.textTertiary)
                        }
                    }
                } footer: {
                    Text("Audio and transcripts are processed by OpenRouter and the selected upstream providers.")
                }
                if status?.configured == true {
                    Section {
                        Button(role: .destructive) { showingDisconnect = true } label: {
                            rowLabel("Disconnect", action: .disconnect)
                        }
                        .disabled(isBusy || !isSupported)
                        .confirmationDialog(
                            "Disconnect OpenRouter?",
                            isPresented: $showingDisconnect,
                            titleVisibility: .visible
                        ) {
                            Button("Disconnect", role: .destructive) {
                                Task { await run(.disconnect) { try await manager.deleteOpenRouterCredential() } }
                            }
                            Button("Cancel", role: .cancel) {}
                        } message: {
                            Text("Voice Input preferences will be preserved.")
                        }
                    }
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("OpenRouter")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if busyAction == .connect {
                    ProgressView()
                } else if !trimmedKey.isEmpty {
                    Button("Connect", action: connect)
                        .fontWeight(.semibold)
                        .disabled(isBusy || !isSupported)
                }
            }
        }
        .task { await run(.load) { try await manager.openRouterIntegration() } }
        .refreshable { await run(.load) { try await manager.openRouterIntegration() } }
    }

    @ViewBuilder
    private var statusSection: some View {
        Section {
            if isLoaded {
                LabeledContent("Status") {
                    HStack(spacing: 8) {
                        if status?.state == .validating { ProgressView() }
                        Text(statusLabel).foregroundStyle(statusColor)
                    }
                }
                if let hint = status?.credentialHint, !hint.isEmpty {
                    LabeledContent("Key", value: hint)
                }
                if let validatedAt = VoiceIntegrationLabels.validatedAt(status?.lastValidatedAt) {
                    LabeledContent("Last Validated", value: validatedAt)
                }
            } else {
                SettingsPlaceholderRows(count: 2)
            }
        } footer: {
            if isLoaded, !isSupported {
                Text("This connection doesn't support Voice Input.")
            } else if status?.state == .invalid {
                Text("OpenRouter rejected this key. Enter a new one below.").foregroundStyle(T3Colors.danger)
            }
        }
    }

    private var keySection: some View {
        Section {
            SecureField("sk-or-v1-…", text: $apiKey)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.password)
                .submitLabel(.done)
                .disabled(isBusy || !isSupported)
                .accessibilityLabel("OpenRouter API key")
                .onSubmit(connect)
        } header: {
            Text(status?.configured == true ? "Replace API Key" : "API Key")
        } footer: {
            SettingsFooter(
                text: "The key applies to this whole server. Existing keys are never displayed.",
                error: errorMessage
            )
        }
    }

    private var statusLabel: String {
        let label = VoiceIntegrationLabels.connection(status, isLoaded: isLoaded)
        return label == "Error" ? "Invalid Key" : label
    }

    private var statusColor: Color {
        switch status?.state {
        case .connected: T3Colors.success
        case .invalid: T3Colors.danger
        default: T3Colors.textSecondary
        }
    }

    private func rowLabel(_ title: String, action: Action) -> some View {
        HStack {
            Text(title)
            if busyAction == action {
                Spacer()
                ProgressView()
            }
        }
    }

    private var trimmedKey: String {
        apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func connect() {
        guard !trimmedKey.isEmpty, !isBusy, isSupported else { return }
        let key = apiKey
        Task { await run(.connect) { try await manager.putOpenRouterCredential(apiKey: key) } }
    }

    /// Every OpenRouter mutation settles the same way: it replaces the status,
    /// clears the entered key so a validated secret never lingers in the field,
    /// and surfaces the failure under the key field rather than as an alert.
    @MainActor
    private func run(
        _ action: Action,
        _ operation: @MainActor () async throws -> OpenRouterIntegrationStatus
    ) async {
        busyAction = action
        errorMessage = nil
        defer {
            isLoaded = true
            busyAction = nil
        }
        do {
            let latest = try await operation()
            status = latest
            if action != .load {
                apiKey = ""
                PlatformHapticEngine.shared.play(latest.state == .invalid ? .warning : .success)
            }
            onStatusChange(latest)
        } catch {
            if action != .load { PlatformHapticEngine.shared.play(.error) }
            errorMessage = error.localizedDescription
        }
    }
}
