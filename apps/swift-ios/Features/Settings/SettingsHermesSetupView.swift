import SwiftUI

/// The entry point for a Work environment that has not been set up yet.
struct WorkSetupSheet: View {
    let model: FeatureRootModel
    @State private var environmentID = ""

    var body: some View {
        NavigationStack {
            Group {
                if !environmentID.isEmpty, let manager = model.client as? any FeatureWorkManaging {
                    SettingsHermesSetupView(
                        manager: manager,
                        environmentID: environmentID,
                        instanceID: "hermes",
                        serverChoice: model.snapshot.environments.count > 1
                            ? SettingsHermesSetupView.ServerChoice(environments: model.snapshot.environments, selection: $environmentID)
                            : nil
                    )
                    .id(environmentID)
                } else {
                    ContentUnavailableView(
                        "No Server",
                        systemImage: "network",
                        description: Text("Pair a server in Settings before setting up Hermes.")
                    )
                    .background(T3Colors.background)
                }
            }
            .navigationTitle("Set Up Hermes")
            .navigationBarTitleDisplayMode(.inline)
            .t3SheetToolbar(.close)
            .task {
                if environmentID.isEmpty {
                    environmentID = (model.snapshot.environments.first(where: \.isActive) ?? model.snapshot.environments.first)?.id ?? ""
                }
            }
        }
    }
}

/// Hermes on one server: its status, the next setup step, and its model
/// account. Pushed from an account's configuration and from Work.
struct SettingsHermesSetupView: View {
    /// A server picker as the page's first row, for entry points that are not
    /// already scoped to one server.
    struct ServerChoice {
        let environments: [FeatureEnvironment]
        let selection: Binding<String>
    }

    let manager: any FeatureWorkManaging
    let environmentID: String
    let instanceID: String
    var serverChoice: ServerChoice? = nil
    @State private var state: HermesWorkSetupState?
    @State private var failure: String?
    @State private var starting = false
    @State private var refreshID = 0
    private var active: Bool { starting || state?.isActive == true }

    var body: some View {
        SettingsForm {
            if let serverChoice {
                Section {
                    Picker("Server", selection: serverChoice.selection) {
                        ForEach(serverChoice.environments) { environment in
                            Label(environment.name, systemImage: environment.machineSymbol).tag(environment.id)
                        }
                    }
                    .pickerStyle(.menu)
                }
            }

            Section {
                if let state {
                    LabeledContent("Status") {
                        HStack(spacing: 8) {
                            if active { ProgressView() }
                            Text(statusLabel(state.phase))
                                .foregroundStyle(statusColor(state.phase))
                        }
                    }
                    if let model = state.model { LabeledContent("Model", value: model) }
                } else if failure == nil {
                    SettingsPlaceholderRows(count: 2)
                }
            } footer: {
                SettingsFooter(text: statusFooter, error: failure)
            }

            if state != nil, state?.phase != "connected" {
                Section {
                    Button {
                        start()
                    } label: {
                        Text(active ? "Setting Up…" : state?.phase == "error" ? "Retry Setup" : "Set Up Hermes")
                            .frame(maxWidth: .infinity)
                    }
                    .t3ProminentButtonStyle()
                    .disabled(active)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .accessibilityIdentifier("hermes-setup-start")
                } footer: {
                    Text("Installs the runtime when needed, configures its connection, and starts its background service on this server.")
                }
            }

            if state?.phase == "needs_model" || state?.phase == "connected" {
                Section {
                    NavigationLink(state?.phase == "needs_model" ? "Connect a Model Account" : "Manage Model Account") {
                        // Connecting a model is what unblocks the rest of setup, so
                        // rerun it here. Polling the status alone would leave the
                        // phase on needs_model and the background scheduler stopped,
                        // because only a setup run starts the Hermes gateway.
                        SettingsHermesModelView(manager: manager, environmentID: environmentID, instanceID: instanceID) { start() }
                    }
                } footer: {
                    if state?.phase == "connected" {
                        Text("Each new Work thread starts a separate conversation. Scheduled tasks continue while this server and its Hermes service keep running.")
                    }
                }
            }
        }
        .navigationTitle("Hermes")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await refresh() }
        .task(id: refreshID) { await observe() }
    }

    private var statusFooter: String? {
        guard let state else { return nil }
        var lines = [state.message]
        if state.phase == "needs_model" {
            lines.append("The runtime is installed, but Hermes still needs a model account before a conversation can start.")
        }
        return lines.filter { !$0.isEmpty }.joined(separator: "\n")
    }

    private func statusLabel(_ phase: String) -> String {
        switch phase {
        case "installing": "Installing…"
        case "configuring": "Configuring…"
        case "connecting": "Starting…"
        case "needs_model": "Needs a Model"
        case "connected": "Connected"
        case "error": "Needs Attention"
        default: "Not Set Up"
        }
    }

    private func statusColor(_ phase: String) -> Color {
        switch phase {
        case "connected": T3Colors.success
        case "error", "needs_model": T3Colors.warning
        default: T3Colors.textSecondary
        }
    }

    private func refresh() async {
        refreshID += 1
    }

    private func start() {
        starting = true
        failure = nil
        Task {
            defer { starting = false }
            do {
                state = try await manager.workSetupStart(environmentID: environmentID, instanceID: instanceID)
                refreshID += 1
            } catch {
                PlatformHapticEngine.shared.play(.error)
                failure = error.localizedDescription
            }
        }
    }

    private func observe() async {
        do {
            repeat {
                let next = try await manager.workSetupStatus(environmentID: environmentID, instanceID: instanceID)
                try Task.checkCancellation()
                if next.phase == "connected", state.map({ $0.phase != "connected" }) == true {
                    PlatformHapticEngine.shared.play(.success)
                }
                state = next
                failure = nil
                guard next.isActive else { return }
                try await Task.sleep(for: .seconds(1))
            } while !Task.isCancelled
        } catch {
            if !Task.isCancelled { failure = error.localizedDescription }
        }
    }
}
