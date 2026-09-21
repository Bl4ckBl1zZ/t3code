import SwiftUI

/// What new threads and projects on one server start with, and each project's
/// overrides. Pushed from Settings; each project pushes its own page.
struct SettingsProjectDefaultsView: View {
    @Bindable var model: FeatureRootModel
    @State private var store: ProjectDefaultsStore

    init(model: FeatureRootModel) {
        self.model = model
        let manager = (model.client as? any FeatureServerSettingsManaging) ?? EmptyFeatureServerSettingsManager.shared
        _store = State(initialValue: ProjectDefaultsStore(manager: manager))
    }

    private var projects: [FeatureProject] {
        model.snapshot.projects.filter { $0.environmentID == store.environmentID }
    }

    var body: some View {
        SettingsForm {
            if store.page.config == nil {
                if let loadError = store.loadError {
                    SettingsRetrySection(message: loadError) { Task { await store.load() } }
                } else {
                    Section { SettingsPlaceholderRows(count: 3) }
                }
            } else {
                newThreadsSection
                allProjectsSection
                projectsSection
            }
        }
        .settingsServerScope(
            title: "Project Defaults",
            environments: model.snapshot.environments,
            selection: $store.environmentID
        )
        .onAppear {
            if store.environmentID.isEmpty {
                store.environmentID = model.snapshot.environments.first(where: \.isActive)?.id
                    ?? model.snapshot.environments.first?.id ?? ""
            }
        }
        .task(id: store.environmentID) { await store.load() }
        .refreshable { await store.load() }
    }

    private var newThreadsSection: some View {
        Section {
            ProviderModelPicker(
                providers: model.snapshot.providersByEnvironment?[store.environmentID] ?? [],
                selection: Binding(get: { store.modelDefault }, set: { selection in
                    store.save(.init(defaultModelSelection: .some(selection.map(ModelSelection.init(featureSelection:)))), needs: .defaults)
                }),
                materializesDefaultSelection: false,
                setupContext: ProviderSetupContext(client: model.client, environmentID: store.environmentID)
            )
            if store.modelDefault != nil {
                Button("Use Automatic Model Selection") {
                    store.save(.init(defaultModelSelection: .some(nil)), needs: .defaults)
                }
            }
            Picker("Workspace", selection: Binding(
                get: { store.threadEnvironmentMode },
                set: { store.save(.init(defaultThreadEnvMode: $0), needs: .defaults) }
            )) {
                Text("Local").tag(ServerThreadEnvironmentMode.local)
                Text("New Worktree").tag(ServerThreadEnvironmentMode.worktree)
            }
            .pickerStyle(.menu)
        } header: {
            Text("New Threads")
        } footer: {
            SettingsFooter(
                text: store.supports(.defaults)
                    ? "Project settings and choices made in a draft take priority."
                    : "Connect a current server to set defaults for new threads.",
                error: store.writeError
            )
        }
        .disabled(!store.supports(.defaults))
    }

    private var allProjectsSection: some View {
        Section {
            Toggle("Pull Clean Default Branches", isOn: Binding(
                get: { store.defaultAutoPull },
                set: { store.save(.init(defaultAutoPull: $0), needs: .autoPull) }
            ))
            .disabled(!store.supports(.autoPull))
            Toggle("Agent Browser Access", isOn: Binding(
                get: { store.defaultBrowserAccess },
                set: { store.save(.init(enableAgentBrowserAccess: $0), needs: .browser) }
            ))
            .disabled(!store.supports(.browser))
            NavigationLink {
                SettingsMachineActionsView(store: store)
            } label: {
                LabeledContent("Actions") {
                    Text(store.machineScripts.isEmpty ? "None" : store.machineScripts.count.formatted())
                }
            }
            .disabled(!store.supports(.actions))
        } header: {
            Text("All Projects")
        } footer: {
            Text(allProjectsFooter)
        }
    }

    private var allProjectsFooter: String {
        var lines = [
            "Pulls keep clean default branches current. They only fast-forward and follow this machine’s background activity policy.",
            "Browser access changes apply when an agent’s next session starts.",
        ]
        if !store.supports(.autoPull) { lines.append("Connect a current server to configure automatic pulls.") }
        if !store.supports(.browser) { lines.append("Connect a current server to configure browser access.") }
        return lines.joined(separator: " ")
    }

    private var projectsSection: some View {
        Section {
            ForEach(projects) { project in
                NavigationLink {
                    SettingsProjectOverridesView(store: store, project: project)
                } label: {
                    LabeledContent {
                        if store.hasOverrides(project) { Text("Custom") }
                    } label: {
                        Text(project.name)
                    }
                }
            }
        } header: {
            Text("Projects")
        } footer: {
            if projects.isEmpty { Text("No projects on this machine.") }
        }
    }
}

/// One project's overrides of the machine defaults.
private struct SettingsProjectOverridesView: View {
    let store: ProjectDefaultsStore
    let project: FeatureProject
    @State private var confirmingInherit = false

    private var projectID: String { project.wireID ?? project.id }
    private var inherits: Bool { store.actionsInherited(project) }

    var body: some View {
        SettingsForm {
            Section {
                overridePicker(
                    "Pull Default Branch",
                    defaultValue: store.defaultAutoPull,
                    selection: store.autoPullOverride(project),
                    needs: .autoPull
                ) { store.save(.init(projectAutoPullOverrides: [projectID: $0]), needs: .autoPull) }
                overridePicker(
                    "Agent Browser Access",
                    defaultValue: store.defaultBrowserAccess,
                    selection: store.browserOverride(project),
                    needs: .browser
                ) { store.save(.init(projectAgentBrowserAccessOverrides: [projectID: $0]), needs: .browser) }
            } footer: {
                SettingsFooter(
                    text: "Default follows this machine’s setting. Browser access changes apply when an agent’s next session starts.",
                    error: store.writeError
                )
            }

            Section {
                Toggle("Use Machine Actions", isOn: Binding(
                    get: { inherits },
                    set: { useMachine in
                        if useMachine {
                            confirmingInherit = true
                        } else {
                            // Start the project's own list from what it was using.
                            store.save(.init(projectScriptOverrides: [projectID: store.scripts(for: project)]), needs: .actions)
                        }
                    }
                ))
                .confirmationDialog(
                    "Use this machine’s actions?",
                    isPresented: $confirmingInherit,
                    titleVisibility: .visible
                ) {
                    Button("Use Machine Actions", role: .destructive) {
                        store.save(.init(projectScriptOverrides: [projectID: nil]), needs: .actions)
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("\(project.name)’s own actions will be removed.")
                }
            } header: {
                Text("Actions")
            } footer: {
                Text(inherits
                    ? "Editing an action below gives \(project.name) its own list."
                    : "Turn on to use this machine’s actions instead.")
            }
            .disabled(!store.supports(.actions))

            SettingsProjectActionsSection(
                scripts: store.scripts(for: project),
                projectName: project.name,
                enabled: store.supports(.actions)
            ) { scripts in
                await store.write(.init(projectScriptOverrides: [projectID: scripts]), needs: .actions)
            }
        }
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .modifier(SettingsSubtitle(text: project.path))
    }

    private func overridePicker(
        _ title: String,
        defaultValue: Bool,
        selection: Bool?,
        needs capability: ProjectDefaultsStore.Capability,
        set: @escaping (Bool?) -> Void
    ) -> some View {
        Picker(title, selection: Binding(
            get: { selection.map { $0 ? "on" : "off" } ?? "inherit" },
            set: { value in set(value == "inherit" ? nil : value == "on") }
        )) {
            Text("Default (\(defaultValue ? "On" : "Off"))").tag("inherit")
            Text("On").tag("on")
            Text("Off").tag("off")
        }
        .pickerStyle(.menu)
        .disabled(!store.supports(capability))
    }
}

/// The machine's own actions, which every project without overrides uses.
private struct SettingsMachineActionsView: View {
    let store: ProjectDefaultsStore

    var body: some View {
        SettingsForm {
            SettingsProjectActionsSection(
                scripts: store.machineScripts,
                projectName: nil,
                enabled: store.supports(.actions)
            ) { scripts in
                await store.write(.init(defaultProjectScripts: scripts ?? []), needs: .actions)
            }
        }
        .navigationTitle("Actions")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A second title line on iOS 26; earlier systems show the title alone.
struct SettingsSubtitle: ViewModifier {
    let text: String

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.navigationSubtitle(text)
        } else {
            content
        }
    }
}

/// Page state for Project Defaults, shared with the pages it pushes so an edit
/// on a project page shows on the list the moment the reader goes back.
@MainActor
@Observable
final class ProjectDefaultsStore {
    /// Which server capability a write depends on.
    enum Capability {
        case actions, defaults, browser, autoPull
    }

    private let manager: any FeatureServerSettingsManaging
    var environmentID = ""
    private(set) var page = ServerSettingsPageState()
    private(set) var loadError: String?
    private(set) var writeError: String?

    init(manager: any FeatureServerSettingsManaging) {
        self.manager = manager
    }

    private var settings: ServerSettingsSnapshot? { page.settings }
    private var pending: ServerSettingsPatchInput { page.pending }

    func supports(_ capability: Capability) -> Bool {
        Self.isSupported(capability, by: page.capabilities)
    }

    private static func isSupported(_ capability: Capability, by capabilities: EnvironmentDescriptor.Capabilities?) -> Bool {
        switch capability {
        case .actions: capabilities?.projectActionDefaults == true
        case .defaults: capabilities?.projectDefaults == true
        case .browser: capabilities?.projectBrowserAccess == true
        case .autoPull: capabilities?.projectAutoPull == true
        }
    }

    // Each value reads the write still in flight first, then the server's answer.

    var modelDefault: FeatureSelection? {
        let value: ModelSelection?
        if let pendingValue = pending.defaultModelSelection { value = pendingValue } else { value = settings?.defaultModelSelection }
        return value.map(FeatureSelection.init(serverSelection:))
    }

    var threadEnvironmentMode: ServerThreadEnvironmentMode {
        pending.defaultThreadEnvMode ?? settings?.defaultThreadEnvMode ?? .local
    }

    var defaultAutoPull: Bool { pending.defaultAutoPull ?? settings?.defaultAutoPull ?? false }

    var defaultBrowserAccess: Bool {
        pending.enableAgentBrowserAccess
            ?? settings?.enableAgentBrowserAccess
            ?? ServerSettingsSnapshot.defaultEnableAgentBrowserAccess
    }

    var machineScripts: [ProjectScript] {
        pending.defaultProjectScripts ?? settings?.defaultProjectScripts ?? []
    }

    func autoPullOverride(_ project: FeatureProject) -> Bool? {
        let id = project.wireID ?? project.id
        if let pendingValue = pending.projectAutoPullOverrides?[id] { return pendingValue }
        return settings?.projectAutoPullOverrides[id]
    }

    func browserOverride(_ project: FeatureProject) -> Bool? {
        let id = project.wireID ?? project.id
        if let pendingValue = pending.projectAgentBrowserAccessOverrides?[id] { return pendingValue }
        return settings?.projectAgentBrowserAccessOverrides[id]
    }

    func actionsInherited(_ project: FeatureProject) -> Bool {
        let id = project.wireID ?? project.id
        if let pendingValue = pending.projectScriptOverrides?[id] { return pendingValue == nil }
        if let override = settings?.projectScriptOverrides[id] { return override == nil }
        return project.scriptsInheritDefaults == true
    }

    func scripts(for project: FeatureProject) -> [ProjectScript] {
        let id = project.wireID ?? project.id
        if let pendingValue = pending.projectScriptOverrides?[id] { return pendingValue ?? machineScripts }
        return settings?.resolvedProjectScripts(
            projectID: id,
            legacyScripts: project.scriptsInheritDefaults == true ? [] : project.scripts
        ) ?? project.scripts
    }

    func hasOverrides(_ project: FeatureProject) -> Bool {
        autoPullOverride(project) != nil || browserOverride(project) != nil || !actionsInherited(project)
    }

    // MARK: Requests

    func load() async {
        let requestedID = environmentID
        guard !requestedID.isEmpty else { return }
        if page.environmentID != requestedID { writeError = nil }
        page.beginLoad(environmentID: requestedID)
        defer { if requestedID == environmentID { page.endLoad() } }
        do {
            let result = try await manager.providerModelConfiguration(environmentID: requestedID)
            guard !Task.isCancelled, requestedID == environmentID else { return }
            page.finishLoad(result)
            loadError = nil
        } catch {
            if !Task.isCancelled, requestedID == environmentID { loadError = error.localizedDescription }
        }
    }

    /// Fire-and-forget form of `write` for controls.
    func save(_ patch: ServerSettingsPatchInput, needs capability: Capability) {
        Task { await write(patch, needs: capability) }
    }

    /// Shows the change at once, writes it, and reports whether it stuck. The
    /// capability is checked again against a fresh config, because a sparse
    /// patch sent to a server that reconnected on an older version would be
    /// dropped without complaint.
    @discardableResult
    func write(_ patch: ServerSettingsPatchInput, needs capability: Capability) async -> Bool {
        guard supports(capability) else { return false }
        let requestedID = environmentID
        page.beginWrite(patch)
        writeError = nil
        var failure: String?
        do {
            let current = try await manager.providerModelConfiguration(environmentID: requestedID)
            guard Self.isSupported(capability, by: current.environment?.capabilities) else {
                throw FeatureCapabilityUnavailable("Project defaults")
            }
            try await manager.updateServerSettings(environmentID: requestedID, patch: patch)
        } catch {
            failure = "Couldn't save. \(error.localizedDescription)"
        }
        guard requestedID == environmentID else { return failure == nil }
        if let failure {
            writeError = failure
            PlatformHapticEngine.shared.play(.error)
        }
        if page.finishWrite(succeeded: failure == nil) { await load() }
        return failure == nil
    }
}
