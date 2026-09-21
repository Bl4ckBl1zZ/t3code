import SwiftUI

/// Updates the desktop app on one server. Pushed from Servers → This Server.
struct SettingsDesktopUpdatesView: View {
    @Bindable var model: FeatureRootModel
    @State private var environmentID = ""
    /// `nil` until the server answers; the page claims nothing about what the
    /// server supports before then.
    @State private var config: ServerConfigSnapshot?
    @State private var loadedID: String?
    @State private var loadError: String?
    @State private var pending = false
    @State private var confirming = false
    @State private var stage: String?
    @State private var failure: String?

    private var manager: any FeatureServerSettingsManaging {
        (model.client as? any FeatureServerSettingsManaging) ?? EmptyFeatureServerSettingsManager.shared
    }

    private var descriptor: EnvironmentDescriptor? { config?.environment }
    private var supportsUpdate: Bool { descriptor?.capabilities.desktopAppUpdate == true }
    private var supportsRestartContinuation: Bool { descriptor?.capabilities.threadRestartContinuation == true }
    private var continueRunningThreads: Bool { config?.settings?.continueThreadsAfterServerUpdate ?? false }

    private var serverName: String {
        model.snapshot.environments.first { $0.id == environmentID }?.name ?? "this machine"
    }

    var body: some View {
        SettingsForm {
            if config == nil {
                if let loadError {
                    SettingsRetrySection(message: loadError) { Task { await load() } }
                } else {
                    Section { SettingsPlaceholderRows(count: 2) }
                }
            } else {
                Section {
                    LabeledContent("Version", value: descriptor?.serverVersion ?? "Unknown")
                    if supportsRestartContinuation {
                        NavigationLink {
                            SettingsThreadOrganizationView(model: model, environmentID: environmentID)
                        } label: {
                            LabeledContent("Resume Running Threads", value: continueRunningThreads ? "On" : "Off")
                        }
                    }
                } footer: {
                    Text(supportsUpdate
                        ? "Checking closes and relaunches the desktop app on \(serverName), briefly disconnecting its clients."
                        : "Remote updates require a recent desktop app. Update the app on that machine first. Standalone servers use their service installer.")
                }

                if supportsUpdate {
                    Section {
                        updateButton
                    } footer: {
                        if supportsRestartContinuation {
                            Text(continueRunningThreads
                                ? "Eligible threads will resume after the update."
                                : "Turn on Resume Running Threads to pick up running work after updates.")
                        }
                    }
                }
            }
        }
        .settingsServerScope(
            title: "Desktop Updates",
            environments: model.snapshot.environments,
            selection: $environmentID,
            isEnabled: !pending
        )
        .onAppear {
            if environmentID.isEmpty {
                environmentID = model.snapshot.environments.first(where: \.isActive)?.id
                    ?? model.snapshot.environments.first?.id ?? ""
            }
        }
        .task(id: environmentID) { await load() }
        .refreshable { await load() }
        .alert(
            "Couldn't Update",
            isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
        ) {
            Button("OK") { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

    private var updateButton: some View {
        Button { confirming = true } label: {
            HStack(spacing: 10) {
                if pending { ProgressView() }
                Text(pending ? stageLabel : "Check for Update")
            }
        }
        .disabled(pending)
        .confirmationDialog(
            "Update this machine’s desktop app?",
            isPresented: $confirming,
            titleVisibility: .visible
        ) {
            Button("Update and Relaunch") { Task { await update() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(continueRunningThreads
                ? "Eligible running threads will resume after the app restarts."
                : "Active agent work may be interrupted while the app restarts.")
        }
    }

    private var stageLabel: String {
        switch stage {
        case "installing": "Preparing update…"
        case "resuming": "Restarting and reconnecting…"
        default: "Checking and downloading…"
        }
    }

    private func load() async {
        let requestedID = environmentID
        guard !requestedID.isEmpty else { return }
        if loadedID != requestedID {
            config = nil
            loadError = nil
        }
        do {
            let result = try await manager.providerModelConfiguration(environmentID: requestedID)
            guard !Task.isCancelled, environmentID == requestedID else { return }
            config = result
            loadedID = requestedID
            loadError = nil
        } catch {
            if !Task.isCancelled, environmentID == requestedID { loadError = error.localizedDescription }
        }
    }

    private func update() async {
        guard !pending, supportsUpdate else { return }
        let requestedID = environmentID
        pending = true
        stage = "downloading"
        defer { pending = false }
        do {
            let version = try await manager.updateDesktopApp(environmentID: requestedID) { stage in
                await MainActor.run { self.stage = stage }
            }
            await load()
            T3HUD.show("Updated to \(version)", systemImage: "arrow.down.circle.fill")
        } catch {
            PlatformHapticEngine.shared.play(.error)
            failure = error.localizedDescription
        }
    }
}
