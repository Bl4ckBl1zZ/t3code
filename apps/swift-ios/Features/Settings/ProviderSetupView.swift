import SwiftUI

@MainActor
public struct ProviderSetupContext {
    let environmentID: String
    let settings: any FeatureServerSettingsManaging
    let terminals: any FeatureAgentSetupTerminalProviding

    init?(client: any FeatureClient, environmentID: String?) {
        guard let environmentID,
              let settings = client as? any FeatureServerSettingsManaging,
              let terminals = client as? any FeatureAgentSetupTerminalProviding else { return nil }
        self.environmentID = environmentID
        self.settings = settings
        self.terminals = terminals
    }
}

/// Install or sign in to Codex and Claude accounts on a server: one row per
/// account with its state and the next step. The step opens a setup terminal
/// that prepares a command to review and run.
struct ProviderSetupView: View {
    let context: ProviderSetupContext
    let instanceID: String?
    @State private var config: ServerConfigSnapshot?
    @State private var errorMessage: String?
    @State private var loading = false
    @State private var openingID: String?
    @State private var generation = UUID()
    private struct TerminalPresentation: Identifiable {
        let id = UUID()
        let session: any FeatureAgentSetupTerminal
    }
    @State private var terminal: TerminalPresentation?

    private var providers: [ServerProviderSnapshot] {
        (config?.providers ?? []).filter { provider in
            (instanceID == nil || provider.instanceId == instanceID) && (provider.driver == "codex" || provider.driver == "claudeAgent")
        }
    }

    private var supportsTerminals: Bool {
        config?.environment?.capabilities.providerTerminalEnvironment == true
    }

    var body: some View {
        content
            .navigationTitle("Install or Sign In")
            .navigationBarTitleDisplayMode(.inline)
            .task { await load(refresh: false) }
            .onDisappear { generation = UUID() }
            .sheet(item: $terminal, onDismiss: { Task { await load(refresh: true) } }) { presentation in
                AgentSetupTerminalView(session: presentation.session)
            }
    }

    @ViewBuilder
    private var content: some View {
        if config != nil, providers.isEmpty {
            ContentUnavailableView {
                Label("No Setup Here", systemImage: "person.crop.circle.badge.questionmark")
            } description: {
                Text("This account is unavailable or does not support setup from here. Check its settings in Agents.")
            } actions: {
                Button("Check Again") { Task { await load(refresh: true) } }
                    .disabled(loading)
            }
            .background(T3Colors.background)
        } else {
            SettingsForm {
                if config == nil {
                    if let errorMessage, !loading {
                        SettingsRetrySection(message: errorMessage) { Task { await load(refresh: false) } }
                    } else {
                        Section { SettingsPlaceholderRows(count: 2) }
                    }
                } else {
                    ForEach(Array(providers.enumerated()), id: \.element.id) { index, provider in
                        Section {
                            row(provider)
                        } footer: {
                            SettingsFooter(
                                text: footer(for: provider, isLast: index == providers.count - 1),
                                error: index == providers.count - 1 ? errorMessage : nil
                            )
                        }
                    }
                }
            }
            .refreshable { await load(refresh: true) }
        }
    }

    private func row(_ provider: ServerProviderSnapshot) -> some View {
        let step = nextStep(provider)
        return HStack(spacing: 12) {
            ProviderIcon(
                driver: provider.driver,
                providerID: provider.instanceId,
                fallbackName: provider.displayName ?? provider.driver,
                size: 29
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.displayName ?? provider.driver)
                    .foregroundStyle(T3Colors.textPrimary)
                Text(status(provider))
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            Spacer(minLength: 8)
            Button {
                Task { await open(provider.instanceId) }
            } label: {
                if openingID == provider.instanceId {
                    ProgressView()
                } else {
                    Text(step.title)
                }
            }
            .buttonStyle(.bordered)
            .tint(step.isNext ? T3Colors.accent : T3Colors.textSecondary)
            .disabled(openingID != nil || loading || !provider.enabled || !supportsTerminals)
        }
    }

    private func status(_ provider: ServerProviderSnapshot) -> String {
        if !provider.enabled { return "Off" }
        if !provider.installed { return "Not Installed" }
        if provider.auth.status == "unauthenticated" { return "Signed Out" }
        return provider.auth.email ?? provider.auth.label ?? "Signed In"
    }

    /// Install and first sign-in are the next step and read as such; signing
    /// in again is available but not suggested.
    private func nextStep(_ provider: ServerProviderSnapshot) -> (title: String, isNext: Bool) {
        if !provider.installed { return ("Install", true) }
        if provider.auth.status == "unauthenticated" { return ("Sign In", true) }
        return ("Sign In Again", false)
    }

    private func footer(for provider: ServerProviderSnapshot, isLast: Bool) -> String? {
        var lines: [String] = []
        if let message = provider.message { lines.append(message) }
        if !provider.enabled { lines.append("Turn this account on in its configuration to set it up.") }
        if isLast {
            lines.append(supportsTerminals
                ? "Setup runs on this server. The terminal prepares a command for you to review and run."
                : "Update this server to set up agents from here.")
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    private func load(refresh: Bool) async {
        let request = generation
        loading = true
        defer { if generation == request { loading = false } }
        do {
            if refresh { _ = try await context.terminals.refreshSetupProviders(environmentID: context.environmentID) }
            let next = try await context.settings.providerModelConfiguration(environmentID: context.environmentID)
            guard !Task.isCancelled, generation == request else { return }
            config = next
            errorMessage = nil
        } catch {
            if generation == request && !Task.isCancelled { errorMessage = error.localizedDescription }
        }
    }

    private func open(_ instanceID: String) async {
        guard openingID == nil else { return }
        openingID = instanceID
        let request = generation
        defer { openingID = nil }
        do {
            let session = try await context.terminals.makeAgentSetupTerminal(environmentID: context.environmentID, providerInstanceID: instanceID)
            guard generation == request, !Task.isCancelled else { await session.close(); return }
            errorMessage = nil
            terminal = TerminalPresentation(session: session)
        } catch {
            guard generation == request else { return }
            PlatformHapticEngine.shared.play(.error)
            errorMessage = error.localizedDescription
        }
    }
}
