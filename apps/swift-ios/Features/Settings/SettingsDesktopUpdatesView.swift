import SwiftUI

struct SettingsDesktopUpdatesView: View {
    @Bindable var model: FeatureRootModel
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var environmentID = ""
    @State private var descriptor: EnvironmentDescriptor?
    @State private var loading = false
    @State private var pending = false
    @State private var confirming = false
    @State private var continueRunningThreads = false
    @State private var stage: String?
    @State private var errorMessage: String?
    @State private var successMessage: String?

    private var manager: any FeatureServerSettingsManaging {
        (model.client as? any FeatureServerSettingsManaging) ?? EmptyFeatureServerSettingsManager.shared
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Picker("Environment", selection: $environmentID) {
                    ForEach(model.snapshot.environments) { environment in
                        Label(environment.name, systemImage: environment.machineSymbol).tag(environment.id)
                    }
                }.disabled(pending)
                if let errorMessage { SettingsErrorBanner(message: errorMessage) }
                if loading { ProgressView().frame(maxWidth: .infinity) }
                ThreadDetailsSection(title: "Desktop app") {
                    VStack(alignment: .leading, spacing: 12) {
                        if let descriptor { Text("Version \(descriptor.serverVersion)").font(T3Typography.supportingStrong) }
                        Text("Check the desktop app on this machine for an update. It will close and relaunch, briefly disconnecting its clients.")
                            .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                        if descriptor?.capabilities.threadRestartContinuation == true {
                            Text(continueRunningThreads ? "Eligible threads will resume after the update." : "Enable restart continuation in Thread organization to resume running threads after updates.")
                                .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                        }
                        if descriptor?.capabilities.desktopAppUpdate == true {
                            Button { confirming = true } label: {
                                Label("Check and update", systemImage: "arrow.down.circle")
                                    .frame(minHeight: T3Metrics.minimumTapTarget)
                            }.disabled(pending || loading)
                        } else {
                            Text("Remote updates require a recent desktop app. Update the app on that machine first. Standalone servers use their service installer.")
                                .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                        }
                        if pending { ProgressView(stageLabel).font(T3Typography.supporting) }
                        if let successMessage { Text(successMessage).font(T3Typography.supporting).foregroundStyle(T3Colors.success) }
                    }.padding(SettingsMetrics.rowPadding)
                }
            }.padding(18)
        }
        .background(T3Colors.background)
        .navigationTitle("Desktop updates").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(pending) } }
        .interactiveDismissDisabled(pending)
        .onAppear {
            if environmentID.isEmpty { environmentID = model.snapshot.environments.first(where: \.isActive)?.id ?? model.snapshot.environments.first?.id ?? "" }
        }
        .task(id: environmentID) { await load() }
        .confirmationDialog("Update this machine’s desktop app?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Update and relaunch") { Task { await update() } }
            Button("Cancel", role: .cancel) {}
        } message: { Text(continueRunningThreads ? "Eligible running threads will resume after the app restarts." : "Active agent work may be interrupted while the app restarts.") }
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
        loading = true
        descriptor = nil
        errorMessage = nil
        successMessage = nil
        defer { if environmentID == requestedID { loading = false } }
        do {
            let config = try await manager.providerModelConfiguration(environmentID: requestedID)
            guard !Task.isCancelled, environmentID == requestedID else { return }
            descriptor = config.environment
            continueRunningThreads = config.settings?.continueThreadsAfterServerUpdate ?? false
        } catch { if !Task.isCancelled, environmentID == requestedID { errorMessage = error.localizedDescription } }
    }

    private func update() async {
        guard !pending, descriptor?.capabilities.desktopAppUpdate == true else { return }
        let requestedID = environmentID
        pending = true
        errorMessage = nil
        successMessage = nil
        stage = "downloading"
        defer { pending = false }
        do {
            let version = try await manager.updateDesktopApp(environmentID: requestedID) { stage in
                await MainActor.run { self.stage = stage }
            }
            await load()
            successMessage = "Desktop app reconnected on \(version)."
        } catch { errorMessage = error.localizedDescription }
    }
}
