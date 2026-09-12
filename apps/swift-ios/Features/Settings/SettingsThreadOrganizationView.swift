import SwiftUI

struct SettingsThreadOrganizationView: View {
    @Bindable var model: FeatureRootModel
    @State private var writingInstructions = ""
    @State private var mismatches: [FeatureSharedSettingsMismatch] = []
    @State private var environmentID = ""
    @State private var config: ServerConfigSnapshot?
    @State private var loading = false
    @State private var saving = false
    @State private var errorMessage: String?

    private var manager: any FeatureServerSettingsManaging {
        (model.client as? any FeatureServerSettingsManaging) ?? EmptyFeatureServerSettingsManager.shared
    }
    private var supported: Bool { config?.environment?.capabilities.threadAutoSettlement == true }
    private var restartSupported: Bool { config?.environment?.capabilities.threadRestartContinuation == true }
    private var days: Double? { config?.settings?.sidebarAutoSettleAfterDays }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Picker("Environment", selection: $environmentID) {
                    ForEach(model.snapshot.environments) { environment in
                        Label(environment.name, systemImage: environment.machineSymbol).tag(environment.id)
                    }
                }.disabled(saving)
                Text("Move finished or quiet threads to Settled. These preferences are shared across connected, supported machines, which keep organizing threads even when no app is open. You can reopen a thread at any time.")
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                if let errorMessage { SettingsErrorBanner(message: errorMessage) }
                if !mismatches.isEmpty {
                    ThreadDetailsSection(title: "Preferences differ") {
                        Text("Different values on " + mismatches.map(\.name).joined(separator: ", ") + ". Apply this machine’s shared preferences to all connected machines.")
                            .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(14)
                        Button("Apply to all") { Task { await applyToAll() } }.padding(14).disabled(loading || saving)
                    }
                }
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
                ThreadDetailsSection(title: "Restart recovery") {
                    Toggle("Continue after restarts", isOn: Binding(
                        get: { config?.settings?.continueThreadsAfterServerUpdate ?? false },
                        set: { value in Task { await save(.init(continueThreadsAfterServerUpdate: value)) } }
                    )).padding(14)
                    Text(restartSupported ? "Resume interrupted threads when this machine starts T3 again, including after updates. Saved provider sessions are required. Terminal commands may still be interrupted." : "Connect an updated server to configure restart recovery.")
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(14)
                }.disabled(!restartSupported || loading || saving)
                ThreadDetailsSection(title: "Git and generated text") {
                    Toggle("Start new worktrees from origin", isOn: Binding(
                        get: { config?.settings?.newWorktreesStartFromOrigin ?? true },
                        set: { value in Task { await save(.init(newWorktreesStartFromOrigin: value)) } }
                    )).padding(14)
                    ThreadDetailsDivider()
                    Text("Generated titles and Git messages").font(T3Typography.supportingStrong).padding(.horizontal, 14).padding(.top, 14)
                    ProviderModelPicker(
                        providers: (model.snapshot.providersByEnvironment?[environmentID] ?? []).filter { provider in
                            config?.providers.first(where: { $0.instanceId == provider.id })?.supportsTextGeneration != false
                        },
                        selection: Binding(get: { generationModel }, set: { selection in
                            if let selection { Task { await save(.init(textGenerationModelSelection: coreSelection(selection))) } }
                        }),
                        materializesDefaultSelection: false,
                        setupContext: ProviderSetupContext(client: model.client, environmentID: environmentID)
                    ).padding(14)
                    ThreadDetailsDivider()
                    Picker("Writing style", selection: Binding(
                        get: { config?.settings?.sourceControlWritingStyle?.mode ?? "repo_conventions" },
                        set: { mode in
                            Task { await save(.init(sourceControlWritingStyle: .init(mode: mode))) }
                        }
                    )) {
                        Text("Repository conventions").tag("repo_conventions")
                        Text("Conventional commits").tag("conventional_commits")
                        Text("Custom instructions").tag("custom")
                    }.padding(14)
                    if config?.settings?.sourceControlWritingStyle?.mode == "custom" {
                        TextField("Writing instructions", text: $writingInstructions, axis: .vertical)
                            .lineLimit(3...8).textFieldStyle(.roundedBorder).padding(.horizontal, 14)
                        Button("Save instructions") {
                            let instructions = writingInstructions.trimmingCharacters(in: .whitespacesAndNewlines)
                            Task { await save(.init(sourceControlWritingStyle: .init(customInstructions: instructions))) }
                        }.padding(14)
                    }
                    Toggle("Follow pull request templates", isOn: Binding(
                        get: { config?.settings?.sourceControlWritingStyle?.followChangeRequestTemplates ?? true },
                        set: { enabled in
                            Task { await save(.init(sourceControlWritingStyle: .init(followChangeRequestTemplates: enabled))) }
                        }
                    )).padding(14)
                }.disabled(!supported || loading || saving)
                Button("Reload") { Task { await load() } }.disabled(loading || saving)
            }.padding(18)
        }
        .background(T3Colors.background)
        .navigationTitle("Shared preferences")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { if environmentID.isEmpty { environmentID = model.snapshot.environments.first(where: \.isActive)?.id ?? model.snapshot.environments.first?.id ?? "" } }
        .task(id: environmentID) { await load() }
    }

    private var generationModel: FeatureSelection? {
        guard let value = config?.settings?.textGenerationModelSelection else { return nil }
        return FeatureSelection(providerID: value.instanceId, modelID: value.model, options: (value.options ?? []).compactMap { option in
            switch option.value {
            case let .string(value): return FeatureModelOptionSelection(id: option.id, value: .string(value))
            case let .bool(value): return FeatureModelOptionSelection(id: option.id, value: .boolean(value))
            default: return nil
            }
        })
    }
    private func coreSelection(_ selection: FeatureSelection) -> ModelSelection {
        let options = selection.options.map { option in
            let value: JSONValue
            switch option.value {
            case let .string(raw): value = .string(raw)
            case let .boolean(raw): value = .bool(raw)
            }
            return ModelSelection.OptionSelection(id: option.id, value: value)
        }
        return ModelSelection(instanceId: selection.providerID, model: selection.modelID, options: options.isEmpty ? nil : options)
    }
    private func load() async {
        let requestedID = environmentID
        guard !requestedID.isEmpty else { return }
        loading = true; config = nil; mismatches = []
        defer { if requestedID == environmentID { loading = false } }
        do {
            let result = try await manager.providerModelConfiguration(environmentID: requestedID)
            guard !Task.isCancelled, requestedID == environmentID else { return }
            config = result; errorMessage = nil
            writingInstructions = result.settings?.sourceControlWritingStyle?.customInstructions ?? ""
            let differences = try await manager.sharedSettingsMismatches(environmentID: requestedID)
            guard !Task.isCancelled, requestedID == environmentID else { return }
            mismatches = differences
        } catch { if !Task.isCancelled && requestedID == environmentID { errorMessage = error.localizedDescription } }
    }
    private func save(_ patch: ServerSettingsPatchInput) async {
        let isRestartPatch = patch.continueThreadsAfterServerUpdate != nil
        guard (isRestartPatch ? restartSupported : supported), !loading, !saving else { return }
        saving = true
        let requestedID = environmentID
        defer { saving = false }
        do {
            let current = try await manager.providerModelConfiguration(environmentID: requestedID)
            let available = isRestartPatch ? current.environment?.capabilities.threadRestartContinuation : current.environment?.capabilities.threadAutoSettlement
            guard available == true else { throw FeatureCapabilityUnavailable(isRestartPatch ? "Restart recovery" : "Automatic settlement") }
            try await manager.updateServerSettings(environmentID: requestedID, patch: patch)
            guard !Task.isCancelled, requestedID == environmentID else { return }
            await load()
        } catch { if !Task.isCancelled && requestedID == environmentID { errorMessage = error.localizedDescription } }
    }
    private func applyToAll() async {
        guard !loading, !saving else { return }
        let requestedID = environmentID
        saving = true
        defer { saving = false }
        do {
            try await manager.applySharedSettings(environmentID: requestedID)
            guard requestedID == environmentID, !Task.isCancelled else { return }
            await load()
        } catch { if requestedID == environmentID, !Task.isCancelled { errorMessage = error.localizedDescription } }
    }

}
