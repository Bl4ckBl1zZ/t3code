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

struct ProviderSetupView: View {
    let context: ProviderSetupContext
    let instanceID: String?
    @State private var config: ServerConfigSnapshot?
    @State private var errorMessage: String?
    @State private var loading = false
    @State private var opening = false
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
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                Text("Set up the account on this task’s machine. The terminal prepares a command for you to review and run.")
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                if let errorMessage { SettingsErrorBanner(message: errorMessage) }
                if loading || opening { ProgressView().frame(maxWidth: .infinity) }
                ForEach(providers) { provider in
                    ThreadDetailsSection(title: provider.displayName ?? provider.driver) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(provider.message ?? (provider.installed ? (provider.auth.status == "unauthenticated" ? "Sign in to use this account." : "Refresh status or sign in again to change this account.") : "Install this agent on the selected machine."))
                                .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                            Button(provider.installed ? "Sign in" : "Install agent") {
                                Task { await open(provider.instanceId) }
                            }.disabled(opening || loading || !provider.enabled || config?.environment?.capabilities.providerTerminalEnvironment != true)
                        }.padding(14)
                    }
                }
                if !loading && config != nil && providers.isEmpty {
                    Text("This account is unavailable or does not support inline setup. Check the machine’s provider settings.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                }
                if config?.environment?.capabilities.providerTerminalEnvironment != true && !loading {
                    Text("A current server is required for account-specific setup terminals.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                }
                Button("Refresh status") { Task { await load(refresh: true) } }.disabled(loading || opening)
            }.padding(18)
        }
        .background(T3Colors.background)
        .navigationTitle("Agent setup")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .task { await load(refresh: false) }
        .onDisappear { generation = UUID() }
        .sheet(item: $terminal, onDismiss: { Task { await load(refresh: true) } }) { presentation in
            AgentSetupTerminalView(session: presentation.session)
        }
    }
    private func load(refresh: Bool) async {
        let request = generation
        loading = true
        defer { if generation == request { loading = false } }
        do {
            if refresh { _ = try await context.terminals.refreshSetupProviders(environmentID: context.environmentID) }
            let next = try await context.settings.providerModelConfiguration(environmentID: context.environmentID)
            guard !Task.isCancelled, generation == request else { return }
            config = next; errorMessage = nil
        } catch { if generation == request && !Task.isCancelled { errorMessage = error.localizedDescription } }
    }
    private func open(_ instanceID: String) async {
        guard !opening else { return }
        opening = true
        let request = generation
        defer { opening = false }
        do {
            let session = try await context.terminals.makeAgentSetupTerminal(environmentID: context.environmentID, providerInstanceID: instanceID)
            guard generation == request, !Task.isCancelled else { await session.close(); return }
            terminal = TerminalPresentation(session: session)
        } catch { if generation == request { errorMessage = error.localizedDescription } }
    }
}
