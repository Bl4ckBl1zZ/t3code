import SwiftUI

struct SettingsProjectDefaultsView: View {
    @Bindable var model: FeatureRootModel
    @State private var environmentID = ""
    @State private var config: ServerConfigSnapshot?
    @State private var loading = false
    @State private var saving = false
    @State private var errorMessage: String?

    private var manager: any FeatureServerSettingsManaging {
        (model.client as? any FeatureServerSettingsManaging) ?? EmptyFeatureServerSettingsManager.shared
    }
    private var actionsEnabled: Bool { !loading && !saving && config?.environment?.capabilities.projectActionDefaults == true }
    private var defaultsEnabled: Bool { !loading && !saving && config?.environment?.capabilities.projectDefaults == true }
    private var enabled: Bool { !loading && !saving && config?.environment?.capabilities.projectAutoPull == true }
    private var browserEnabled: Bool { !loading && !saving && config?.environment?.capabilities.projectBrowserAccess == true }
    private var projects: [FeatureProject] { model.snapshot.projects.filter { $0.environmentID == environmentID } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Picker("Environment", selection: $environmentID) {
                    ForEach(model.snapshot.environments) { environment in
                        Label(environment.name, systemImage: environment.machineSymbol).tag(environment.id)
                    }
                }.disabled(saving)
                Text("Keep clean default branches current without local commits. Pulls only fast-forward and follow this machine’s background activity policy. These settings apply to every connected client.")
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                if let errorMessage { SettingsErrorBanner(message: errorMessage) }
                if loading || saving { ProgressView().frame(maxWidth: .infinity) }
                if config?.environment?.capabilities.projectAutoPull != true && !loading {
                    Text("Connect a current server to configure automatic pulls.")
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                }
                ThreadDetailsSection(title: "New threads") {
                    ProviderModelPicker(
                        providers: model.snapshot.providersByEnvironment?[environmentID] ?? [],
                        selection: Binding(get: { modelDefault }, set: { selection in
                            Task { await save(.init(defaultModelSelection: .some(selection.map(coreSelection)))) }
                        }),
                        materializesDefaultSelection: false,
                        setupContext: ProviderSetupContext(client: model.client, environmentID: environmentID)
                    ).padding(14)
                    Button("Use automatic model selection") {
                        Task { await save(.init(defaultModelSelection: .some(nil))) }
                    }.padding(14).disabled(config?.settings?.defaultModelSelection == nil)
                    Picker("Workspace", selection: Binding(
                        get: { config?.settings?.defaultThreadEnvMode ?? .local },
                        set: { value in Task { await save(.init(defaultThreadEnvMode: value)) } }
                    )) {
                        Text("Local").tag(ServerThreadEnvironmentMode.local)
                        Text("New worktree").tag(ServerThreadEnvironmentMode.worktree)
                    }.padding(14)
                    Text("Project defaults and choices made in a draft take priority. These defaults apply to new threads on this machine.")
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(14)
                }.disabled(!defaultsEnabled)
                ThreadDetailsSection(title: "Machine default") {
                    Toggle("Automatically pull", isOn: Binding(
                        get: { config?.settings?.defaultAutoPull ?? false },
                        set: { value in Task { await save(.init(defaultAutoPull: value)) } }
                    )).padding(14)
                }.disabled(!enabled)
                ThreadDetailsSection(title: "Default browser access") {
                    Toggle("Agent browser access", isOn: Binding(
                        get: { config?.settings?.enableAgentBrowserAccess ?? true },
                        set: { value in Task { await save(.init(enableAgentBrowserAccess: value)) } }
                    )).padding(14)
                    Text("Projects can override browser access. Changes apply when an agent’s next session is prepared.")
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(14)
                }.disabled(!browserEnabled)
                SettingsProjectActionsSection(title: "Machine actions", scripts: config?.settings?.defaultProjectScripts ?? [], enabled: actionsEnabled, inherited: false, canReset: !(config?.settings?.defaultProjectScripts.isEmpty ?? true), resetTitle: "Clear default actions") { scripts in
                    await save(.init(defaultProjectScripts: scripts ?? []))
                }
                ThreadDetailsSection(title: "Project overrides") {
                    if projects.isEmpty { Text("No projects on this machine.").padding(14) }
                    ForEach(projects) { project in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(project.name).font(T3Typography.supportingStrong)
                            Picker("Automatically pull", selection: Binding(
                                get: { selection(for: project) },
                                set: { value in
                                    let enabled: Bool? = value == "inherit" ? nil : value == "on"
                                    Task { await save(.init(projectAutoPullOverrides: [project.wireID ?? project.id: enabled])) }
                                }
                            )) {
                                Text("Machine default").tag("inherit")
                                Text("On").tag("on")
                                Text("Off").tag("off")
                            }
                            .disabled(!enabled)
                            Picker("Agent browser access", selection: Binding(
                                get: { browserSelection(for: project) },
                                set: { value in
                                    let enabled: Bool? = value == "inherit" ? nil : value == "on"
                                    Task { await save(.init(projectAgentBrowserAccessOverrides: [project.wireID ?? project.id: enabled])) }
                                }
                            )) {
                                Text("Machine default").tag("inherit")
                                Text("On").tag("on")
                                Text("Off").tag("off")
                            }.disabled(!browserEnabled)
                            SettingsProjectActionsSection(title: "Actions", scripts: config?.settings?.resolvedProjectScripts(projectID: project.wireID ?? project.id, legacyScripts: project.scriptsInheritDefaults == true ? [] : project.scripts) ?? project.scripts, enabled: actionsEnabled, inherited: actionsInherited(project), canReset: !actionsInherited(project)) { scripts in
                                await save(.init(projectScriptOverrides: [project.wireID ?? project.id: scripts]))
                            }
                            Text(project.path).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                        }.padding(14)
                    }
                }
                Button("Reload") { Task { await load() } }.disabled(loading || saving)
            }.padding(18)
        }
        .background(T3Colors.background)
        .navigationTitle("Project defaults")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { if environmentID.isEmpty { environmentID = model.snapshot.environments.first(where: \.isActive)?.id ?? model.snapshot.environments.first?.id ?? "" } }
        .task(id: environmentID) { await load() }
    }

    private func actionsInherited(_ project: FeatureProject) -> Bool {
        project.scriptsInheritDefaults == true
    }
    private var modelDefault: FeatureSelection? {
        guard let value = config?.settings?.defaultModelSelection else { return nil }
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
    private func selection(for project: FeatureProject) -> String {
        guard let value = config?.settings?.projectAutoPullOverrides[project.wireID ?? project.id] else { return "inherit" }
        return value ? "on" : "off"
    }
    private func browserSelection(for project: FeatureProject) -> String {
        guard let value = config?.settings?.projectAgentBrowserAccessOverrides[project.wireID ?? project.id] else { return "inherit" }
        return value ? "on" : "off"
    }
    private func load() async {
        let requestedID = environmentID
        guard !requestedID.isEmpty else { return }
        loading = true
        config = nil
        defer { if requestedID == environmentID { loading = false } }
        do {
            let result = try await manager.providerModelConfiguration(environmentID: requestedID)
            guard !Task.isCancelled, requestedID == environmentID else { return }
            config = result
            errorMessage = nil
        } catch { if !Task.isCancelled && requestedID == environmentID { errorMessage = error.localizedDescription } }
    }
    @discardableResult
    private func save(_ patch: ServerSettingsPatchInput) async -> Bool {
        let isBrowser = patch.projectAgentBrowserAccessOverrides != nil || patch.enableAgentBrowserAccess != nil
        let isAction = patch.defaultProjectScripts != nil || patch.projectScriptOverrides != nil
        let isDefault = patch.defaultModelSelection != nil || patch.defaultThreadEnvMode != nil
        guard isAction ? actionsEnabled : (isDefault ? defaultsEnabled : (isBrowser ? browserEnabled : enabled)) else { return false }
        saving = true
        let requestedID = environmentID
        defer { saving = false }
        do {
            // Recheck the capability before sending a sparse patch to a reconnected server.
            let current = try await manager.providerModelConfiguration(environmentID: requestedID)
            let supported = isAction ? current.environment?.capabilities.projectActionDefaults : (isDefault ? current.environment?.capabilities.projectDefaults : (isBrowser ? current.environment?.capabilities.projectBrowserAccess : current.environment?.capabilities.projectAutoPull))
            guard supported == true else { throw FeatureCapabilityUnavailable("Project defaults") }
            try await manager.updateServerSettings(environmentID: requestedID, patch: patch)
            await load()
            return true
        } catch { errorMessage = error.localizedDescription; return false }
    }
}
