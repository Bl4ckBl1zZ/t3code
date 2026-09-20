import SwiftUI

/// The entry point for a Work environment that has not been set up yet.
struct WorkSetupSheet: View {
    let model: FeatureRootModel
    @State private var environmentID = ""
    @SwiftUI.Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Environment", selection: $environmentID) {
                    ForEach(model.snapshot.environments) { Text($0.name).tag($0.id) }
                }.padding()
                if !environmentID.isEmpty, let manager = model.client as? any FeatureWorkManaging {
                    SettingsHermesSetupView(manager: manager, environmentID: environmentID, instanceID: "hermes")
                        .id(environmentID)
                } else {
                    ContentUnavailableView("Connect an environment", systemImage: "network", description: Text("Pair an environment in Settings before setting up Hermes."))
                }
            }
            .navigationTitle("Set up Hermes")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { if environmentID.isEmpty { environmentID = model.snapshot.environments.first?.id ?? "" } }
        }
    }
}

struct SettingsHermesSetupView: View {
    let manager: any FeatureWorkManaging
    let environmentID: String
    let instanceID: String
    @State private var state: HermesWorkSetupState?
    @State private var failure: String?
    @State private var starting = false
    @State private var refreshID = 0
    private var active: Bool { starting || state?.isActive == true }

    var body: some View {
        Form {
            Section("Hermes on this environment") {
                Text("Set up Hermes installs the runtime when needed, configures its connection, and starts its background service on the selected environment.")
                if let state {
                    Label(phaseLabel(state.phase), systemImage: state.phase == "connected" ? "checkmark.circle" : state.phase == "error" ? "exclamationmark.triangle" : "gearshape")
                    Text(state.message).font(.callout)
                    if let model = state.model { LabeledContent("Model", value: model) }
                    if active { ProgressView(phaseLabel(state.phase)) }
                    if state.phase == "needs_model" {
                        Text("The runtime is installed, but Hermes still needs a model account. Connect an account before starting a conversation.").font(.callout)
                    }
                    if state.phase == "connected" {
                        Text("Hermes is connected. Each new Work thread starts a separate conversation. Scheduled tasks continue while this environment and its Hermes service remain running.").font(.callout)
                    }
                } else if failure == nil { ProgressView("Checking Hermes…") }
                if let failure { Text(failure).foregroundStyle(.red) }
                if state?.phase != "connected" {
                    Button(active ? "Setting up…" : state?.phase == "error" ? "Retry setup" : "Set up Hermes", systemImage: "arrow.down.circle") { start() }
                        .disabled(active)
                        .accessibilityIdentifier("hermes-setup-start")
                }
                if state?.phase == "needs_model" || state?.phase == "connected" {
                    NavigationLink(state?.phase == "needs_model" ? "Connect a model account" : "Manage model account") {
                        // Connecting a model is what unblocks the rest of setup, so
                        // rerun it here. Polling the status alone would leave the
                        // phase on needs_model and the background scheduler stopped,
                        // because only a setup run starts the Hermes gateway.
                        SettingsHermesModelView(manager: manager, environmentID: environmentID, instanceID: instanceID) { start() }
                    }
                }
                Button("Refresh status") { refreshID += 1 }.disabled(starting)
            }
        }
        .navigationTitle("Hermes setup")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: refreshID) { await observe() }
    }

    private func phaseLabel(_ phase: String) -> String {
        switch phase {
        case "installing": "Installing Hermes"
        case "configuring": "Configuring the connection"
        case "connecting": "Starting Hermes"
        case "needs_model": "Connect a model account"
        case "connected": "Connected"
        case "error": "Setup needs attention"
        default: "Ready to set up"
        }
    }
    private func start() {
        starting = true; failure = nil
        Task {
            defer { starting = false }
            do { state = try await manager.workSetupStart(environmentID: environmentID, instanceID: instanceID); refreshID += 1 }
            catch { failure = error.localizedDescription }
        }
    }
    private func observe() async {
        do {
            repeat {
                let next = try await manager.workSetupStatus(environmentID: environmentID, instanceID: instanceID)
                try Task.checkCancellation()
                state = next; failure = nil
                guard next.isActive else { return }
                try await Task.sleep(for: .seconds(1))
            } while !Task.isCancelled
        } catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }
}
