import SwiftUI

// Ported from apps/mobile/src/features/settings/SettingsIntegrationsRouteScreen.tsx,
// which exports both of the screens below.

/// The integrations index. OpenRouter is the only entry today, but the screen
/// exists as a list because the row's job is to surface connection state
/// without making the reader open the detail to see it.
public struct SettingsIntegrationsView: View {
    private let manager: any FeatureVoiceSettingsManaging

    @State private var status: OpenRouterIntegrationStatus?
    @State private var isLoaded = false
    @State private var showingOpenRouter = false

    public init(manager: any FeatureVoiceSettingsManaging) {
        self.manager = manager
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                SettingsSection(
                    title: "Integrations",
                    footer: "OpenRouter powers Voice Input transcription."
                ) {
                    Button {
                        showingOpenRouter = true
                    } label: {
                        SettingsValueNavigationRow(
                            title: "OpenRouter",
                            systemImage: "point.3.connected.trianglepath.dotted",
                            value: VoiceIntegrationLabels.connection(status, isLoaded: isLoaded)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 18)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .navigationTitle("Integrations")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(isPresented: $showingOpenRouter) {
            NavigationStack {
                SettingsOpenRouterView(manager: manager) { latest in
                    // The detail owns the credential, so the index takes its
                    // word for the status instead of re-fetching on dismiss.
                    status = latest
                    isLoaded = true
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showingOpenRouter = false }
                    }
                }
            }
            .presentationDragIndicator(.visible)
        }
    }

    @MainActor
    private func load() async {
        // A failed status request settles as "Unavailable" rather than as an
        // error banner: the row is informational, and the detail screen is
        // where a reader can actually act on the failure.
        status = try? await manager.openRouterIntegration()
        isLoaded = true
    }
}

/// OpenRouter credential management: enter a key, revalidate it, or disconnect.
/// Existing keys are never displayed, only hinted at.
public struct SettingsOpenRouterView: View {
    private let manager: any FeatureVoiceSettingsManaging
    private let onStatusChange: (OpenRouterIntegrationStatus) -> Void

    @State private var status: OpenRouterIntegrationStatus?
    @State private var apiKey = ""
    @State private var isBusy = false
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

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                connectionSection
                apiKeySection
                if status?.configured == true {
                    manageSection
                }
                externalLinkSection
            }
            .padding(.vertical, 18)
        }
        .scrollDismissesKeyboard(.interactively)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .navigationTitle("OpenRouter")
        .navigationBarTitleDisplayMode(.inline)
        .task { await run { try await manager.openRouterIntegration() } }
        .confirmationDialog(
            "Disconnect OpenRouter?",
            isPresented: $showingDisconnect,
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) {
                Task { await run { try await manager.deleteOpenRouterCredential() } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Voice Input preferences will be preserved.")
        }
    }

    private var connectionSection: some View {
        SettingsSection(title: "Connection") {
            VStack(alignment: .leading, spacing: 6) {
                Text(VoiceIntegrationLabels.connection(status, isLoaded: isLoaded))
                    .font(T3Typography.homeTitle)
                    .foregroundStyle(T3Colors.textPrimary)

                Text(credentialDescription)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)

                if let validatedAt = VoiceIntegrationLabels.validatedAt(status?.lastValidatedAt) {
                    Text("Last validated \(validatedAt).")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, SettingsMetrics.rowPadding)
            .padding(.vertical, 12)
            .accessibilityElement(children: .combine)
        }
    }

    private var apiKeySection: some View {
        SettingsSection(title: status?.configured == true ? "Replace API key" : "API key") {
            VStack(alignment: .leading, spacing: 12) {
                SecureField("sk-or-v1-…", text: $apiKey)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.password)
                    .submitLabel(.done)
                    .disabled(isBusy)
                    .settingsInputField()
                    .accessibilityLabel("OpenRouter API key")
                    .onSubmit(connect)

                if let errorMessage {
                    SettingsErrorBanner(message: errorMessage)
                }

                SettingsActionButton(
                    title: "Validate and connect",
                    systemImage: "key",
                    tone: .primary,
                    isBusy: isBusy,
                    isDisabled: trimmedKey.isEmpty,
                    action: connect
                )
                .padding(.horizontal, SettingsMetrics.rowPadding)
            }
        }
    }

    private var manageSection: some View {
        SettingsSection(title: "Manage") {
            VStack(spacing: 12) {
                SettingsActionButton(
                    title: "Revalidate",
                    systemImage: "arrow.clockwise",
                    isDisabled: isBusy
                ) {
                    Task { await run { try await manager.validateOpenRouterCredential() } }
                }

                SettingsActionButton(
                    title: "Disconnect",
                    systemImage: "trash",
                    tone: .danger,
                    isDisabled: isBusy
                ) {
                    showingDisconnect = true
                }
            }
            .padding(.horizontal, SettingsMetrics.rowPadding)
        }
    }

    private var externalLinkSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Link(destination: URL(string: "https://openrouter.ai/settings/keys")!) {
                SettingsNavigationRow(
                    title: "Manage keys on OpenRouter",
                    systemImage: "key.horizontal",
                    trailingSystemImage: "arrow.up.right"
                )
            }
            .buttonStyle(.plain)

            SettingsFootnote(
                """
                Audio and transcripts are processed by OpenRouter and the selected upstream \
                providers.
                """
            )
        }
    }

    private var credentialDescription: String {
        guard let hint = status?.credentialHint, !hint.isEmpty else {
            return "Connect an account-wide key for Voice Input."
        }
        return "Configured key \(hint). Existing keys are never displayed."
    }

    private var trimmedKey: String {
        apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func connect() {
        guard !trimmedKey.isEmpty else { return }
        let key = apiKey
        Task { await run { try await manager.putOpenRouterCredential(apiKey: key) } }
    }

    /// Every OpenRouter mutation settles the same way: it replaces the status,
    /// clears the entered key so a validated secret never lingers in the field,
    /// and surfaces the failure inline rather than as an alert.
    @MainActor
    private func run(
        _ operation: @MainActor () async throws -> OpenRouterIntegrationStatus
    ) async {
        isBusy = true
        errorMessage = nil
        defer {
            isLoaded = true
            isBusy = false
        }
        do {
            let latest = try await operation()
            status = latest
            apiKey = ""
            onStatusChange(latest)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
