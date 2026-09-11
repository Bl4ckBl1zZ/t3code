import SwiftUI

struct SettingsThreadOrganizationView: View {
    @Bindable var model: FeatureRootModel
    @State private var environmentID = ""
    @State private var config: ServerConfigSnapshot?
    @State private var loading = false
    @State private var saving = false
    @State private var errorMessage: String?

    private var manager: any FeatureServerSettingsManaging {
        (model.client as? any FeatureServerSettingsManaging) ?? EmptyFeatureServerSettingsManager.shared
    }
    private var supported: Bool { config?.environment?.capabilities.threadAutoSettlement == true }
    private var days: Double? { config?.settings?.sidebarAutoSettleAfterDays }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Picker("Environment", selection: $environmentID) {
                    ForEach(model.snapshot.environments) { environment in
                        Label(environment.name, systemImage: environment.machineSymbol).tag(environment.id)
                    }
                }.disabled(saving)
                Text("Move finished or quiet threads to Settled. This machine keeps organizing them even when no app is open. You can reopen a thread at any time.")
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                if let errorMessage { SettingsErrorBanner(message: errorMessage) }
                if loading || saving { ProgressView().frame(maxWidth: .infinity) }
                if !loading && !supported {
                    Text("Connect a current server to configure automatic settlement.")
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                }
                ThreadDetailsSection(title: "Automatic settlement") {
                    Toggle("Settle merged pull requests", isOn: Binding(
                        get: { config?.settings?.sidebarAutoSettleOnMerge ?? true },
                        set: { value in Task { await save(.init(sidebarAutoSettleOnMerge: value)) } }
                    )).padding(14)
                    ThreadDetailsDivider()
                    Toggle("Settle inactive threads", isOn: Binding(
                        get: { days != nil },
                        set: { value in Task { await save(.init(sidebarAutoSettleAfterDays: .some(value ? 3 : nil))) } }
                    )).padding(14)
                    if let days {
                        Stepper("After \(days.formatted()) days", value: Binding(
                            get: { days },
                            set: { value in Task { await save(.init(sidebarAutoSettleAfterDays: .some(value))) } }
                        ), in: 1...90, step: 1).padding(14)
                    }
                    Text("Running work, blocking requests and open linked pull requests stay active.")
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(14)
                }.disabled(!supported || loading || saving)
                Button("Reload") { Task { await load() } }.disabled(loading || saving)
            }.padding(18)
        }
        .background(T3Colors.background)
        .navigationTitle("Thread organization")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { if environmentID.isEmpty { environmentID = model.snapshot.environments.first(where: \.isActive)?.id ?? model.snapshot.environments.first?.id ?? "" } }
        .task(id: environmentID) { await load() }
    }

    private func load() async {
        let requestedID = environmentID
        guard !requestedID.isEmpty else { return }
        loading = true; config = nil
        defer { if requestedID == environmentID { loading = false } }
        do {
            let result = try await manager.providerModelConfiguration(environmentID: requestedID)
            guard !Task.isCancelled, requestedID == environmentID else { return }
            config = result; errorMessage = nil
        } catch { if !Task.isCancelled && requestedID == environmentID { errorMessage = error.localizedDescription } }
    }
    private func save(_ patch: ServerSettingsPatchInput) async {
        guard supported, !loading, !saving else { return }
        saving = true
        let requestedID = environmentID
        defer { saving = false }
        do {
            let current = try await manager.providerModelConfiguration(environmentID: requestedID)
            guard current.environment?.capabilities.threadAutoSettlement == true else { throw FeatureCapabilityUnavailable("Automatic settlement") }
            try await manager.updateServerSettings(environmentID: requestedID, patch: patch)
            guard !Task.isCancelled, requestedID == environmentID else { return }
            await load()
        } catch { if !Task.isCancelled && requestedID == environmentID { errorMessage = error.localizedDescription } }
    }
}
