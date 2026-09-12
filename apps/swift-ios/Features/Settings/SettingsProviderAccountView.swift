import SwiftUI

struct SettingsProviderAccountView: View {
    let manager: any FeatureServerSettingsManaging
    let environmentID: String
    let instanceID: String?
    let driver: String?
    let supported: Bool
    let onSaved: () async -> Void
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var draft: NativeProviderAccountDraft?
    @State private var loading = true
    @State private var pending = false
    @State private var errorMessage: String?
    @State private var confirmRemoval = false
    @State private var installedProvider: ServerProviderSnapshot?
    @State private var updatingProvider = false
    @State private var checkingUpdate = false
    private let definitions = NativeProviderSettingsDefinition.catalog
    private var definition: NativeProviderSettingsDefinition? { definitions.first { $0.driver == draft?.driver } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let errorMessage { SettingsErrorBanner(message: errorMessage) }
                if loading { ProgressView("Loading account…").frame(maxWidth: .infinity) }
                if let draft {
                    if draft.isNew {
                        SettingsSection(title: "Provider") {
                            Picker("Provider", selection: Binding(get: { draft.driver }, set: { self.draft = NativeProviderAccountDraft(driver: $0) })) {
                                ForEach(definitions) { item in Text(item.label).tag(item.driver) }
                            }.padding(SettingsMetrics.rowPadding)
                        }
                    }
                    if let definition {
                        identitySection(draft, definition: definition).disabled(updatingProvider || !supported)
                        if !draft.isNew {
                            if draft.driver == "antigravity" {
                                SettingsSection(title: "Antigravity", footer: "Save account changes before installing or signing in. Setup runs on the selected server.") {
                                    NavigationLink {
                                        SettingsAntigravitySetupView(manager: manager, environmentID: environmentID, instanceID: draft.instanceID, authMethod: draft.config["authMethod"]?.stringValue ?? "oauth-personal", binaryPath: draft.config["binaryPath"]?.stringValue ?? "")
                                    } label: { Label("Install and sign in", systemImage: "person.crop.circle.badge.checkmark").frame(minHeight: T3Metrics.minimumTapTarget) }
                                    .disabled(!supported || draft.envelope != draft.original).padding(SettingsMetrics.rowPadding)
                                }
                            } else { providerUpdateSection }
                        }
                        configurationSection(draft, definition: definition).disabled(updatingProvider || !supported)
                        environmentSection(draft, definition: definition).disabled(updatingProvider || !supported)
                        if draft.canRemove {
                            SettingsSection(title: "Remove account", footer: "Existing conversations remain, but this provider account will no longer be available for new runs.") {
                                Button("Remove account", role: .destructive) { confirmRemoval = true }.disabled(updatingProvider || !supported)
                                    .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget)
                            }
                        }
                    } else {
                        Text("This provider's settings are not supported by this version of the app. Its existing configuration is preserved.")
                            .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                    }
                    if !supported { Text("Update this server to edit provider accounts.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary) }
                }
                if pending { ProgressView("Saving account…").frame(maxWidth: .infinity) }
            }.padding(18).disabled(pending)
        }
        .background(T3Colors.background)
        .navigationTitle(instanceID == nil ? "Add account" : "Account configuration")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(pending)
        .interactiveDismissDisabled(pending)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await save() } }.disabled(loading || pending || updatingProvider || draft == nil || definition == nil || !supported)
            }
        }
        .task { await load() }
        .task(id: environmentID) { await observeProviderUpdates() }
        .confirmationDialog("Remove this provider account?", isPresented: $confirmRemoval, titleVisibility: .visible) {
            Button("Remove account", role: .destructive) { Task { await remove() } }
        } message: { Text("You can add it again using the same account ID. Stored environment credentials for this account will be removed.") }
    }

    private var providerUpdateSection: some View {
        SettingsSection(title: "Installed provider", footer: "Updates run on this account’s paired server using its owning installer. Save account changes before updating.") {
            VStack(alignment: .leading, spacing: 12) {
                if let provider = installedProvider {
                    LabeledContent("Version", value: provider.version ?? "Unknown")
                    if let latest = provider.versionAdvisory?.latestVersion {
                        LabeledContent("Latest", value: latest)
                    }
                    if provider.versionAdvisory?.offersUpdate == true, provider.enabled {
                        Button { Task { await performProviderUpdate() } } label: {
                            Label(updatingProvider ? "Updating…" : "Update provider", systemImage: "arrow.down.circle")
                                .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget)
                        }
                        .disabled(updatingProvider || checkingUpdate || provider.updateState?.isActive == true || draft?.envelope != draft?.original)
                        .accessibilityIdentifier("provider-update")
                    } else if provider.versionAdvisory?.status == "behind_latest" {
                        Text("Update this provider using its original installer on the paired server.")
                            .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                    }
                    if let command = provider.versionAdvisory?.updateCommand {
                        Button("Copy update command") { UIPasteboard.general.string = command }
                            .frame(minHeight: T3Metrics.minimumTapTarget)
                    }
                    if let state = provider.updateState, state.status != "idle" {
                        Text(state.message ?? state.status.capitalized)
                            .font(T3Typography.supporting)
                            .foregroundStyle(state.status == "failed" ? T3Colors.warning : T3Colors.textSecondary)
                        if let output = state.output, !output.isEmpty {
                            DisclosureGroup("Update output") {
                                Text(output).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                            }
                        }
                    }
                }
                if updatingProvider || checkingUpdate { ProgressView(updatingProvider ? "Updating provider…" : "Checking version…") }
                Button("Refresh version") { Task { await refreshProviderUpdate() } }
                    .frame(minHeight: T3Metrics.minimumTapTarget)
                    .disabled(updatingProvider || checkingUpdate)
            }.padding(SettingsMetrics.rowPadding)
        }
    }

    private func observeProviderUpdates() async {
        guard let instanceID else { return }
        do {
            let events = try await manager.providerUpdateEvents(environmentID: environmentID)
            for try await providers in events {
                guard !Task.isCancelled else { return }
                installedProvider = providers.first { $0.instanceId == instanceID }
            }
        } catch {
            if !Task.isCancelled { errorMessage = error.localizedDescription }
        }
    }

    private func refreshProviderUpdate() async {
        guard let instanceID, !checkingUpdate, !updatingProvider else { return }
        checkingUpdate = true
        defer { checkingUpdate = false }
        do {
            let providers = try await manager.refreshProviderUpdates(environmentID: environmentID)
            guard !Task.isCancelled else { return }
            installedProvider = providers.first { $0.instanceId == instanceID }
        } catch { errorMessage = error.localizedDescription }
    }

    private func performProviderUpdate() async {
        guard let instanceID, let driver, !updatingProvider, !checkingUpdate,
              installedProvider?.enabled == true, installedProvider?.versionAdvisory?.offersUpdate == true,
              installedProvider?.updateState?.isActive != true, draft?.envelope == draft?.original else { return }
        updatingProvider = true
        errorMessage = nil
        defer { updatingProvider = false }
        do {
            let providers = try await manager.updateProvider(environmentID: environmentID, driver: driver, instanceID: instanceID)
            guard !Task.isCancelled else { return }
            installedProvider = providers.first { $0.instanceId == instanceID }
            await onSaved()
        } catch { errorMessage = error.localizedDescription }
    }

    private func identitySection(_ value: NativeProviderAccountDraft, definition: NativeProviderSettingsDefinition) -> some View {
        SettingsSection(title: "Account", footer: "Settings apply to this paired server. Paths refer to files on that server.") {
            VStack(alignment: .leading, spacing: 16) {
                if let badge = definition.badgeLabel { Text(badge).font(T3Typography.supportingStrong).foregroundStyle(T3Colors.textSecondary) }
                labeledText("Account ID", placeholder: "codex_personal", text: Binding(get: { draft?.instanceID ?? "" }, set: { draft?.instanceID = $0 }))
                    .disabled(!value.isNew)
                labeledText("Display name", placeholder: definition.label, text: Binding(get: { draft?.name ?? "" }, set: { draft?.name = $0 }))
                Toggle("Enabled", isOn: Binding(get: { draft?.enabled ?? false }, set: { draft?.enabled = $0 })).frame(minHeight: T3Metrics.minimumTapTarget)
                labeledText("Account color", placeholder: "Default, or #4F7AFF", text: Binding(get: { draft?.accent ?? "" }, set: { draft?.accent = $0 }))
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 44))]) {
                    ForEach(["#4F7AFF", "#8B5CF6", "#EC4899", "#EF4444", "#F59E0B", "#10B981"], id: \.self) { hex in
                        Button { draft?.accent = hex } label: {
                            ZStack {
                                Circle().fill(color(hex)).frame(width: 24, height: 24)
                                if value.accent.lowercased() == hex.lowercased() { Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(.white) }
                            }.frame(minWidth: T3Metrics.minimumTapTarget, minHeight: T3Metrics.minimumTapTarget)
                        }.buttonStyle(.plain).accessibilityLabel("Account color \(hex)")
                    }
                }.frame(maxWidth: .infinity)
                Button("Use default color") { draft?.accent = "" }.frame(minHeight: T3Metrics.minimumTapTarget)
            }.padding(SettingsMetrics.rowPadding)
        }
    }

    @ViewBuilder private func configurationSection(_ value: NativeProviderAccountDraft, definition: NativeProviderSettingsDefinition) -> some View {
        if !definition.fields.isEmpty {
            SettingsSection(title: "Connection settings") {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(definition.fields) { field in
                        VStack(alignment: .leading, spacing: 5) {
                            if field.control == "switch" {
                                Toggle(field.label, isOn: Binding(get: { value.config[field.key] == .bool(true) || (value.config[field.key] == nil && field.defaultBooleanValue == true) }, set: { draft?.setField(field, value: .bool($0)) }))
                                    .frame(minHeight: T3Metrics.minimumTapTarget)
                            } else if field.control == "select", let choices = field.options {
                                Picker(field.label, selection: Binding(get: { draft?.config[field.key]?.stringValue ?? choices.first?.value ?? "" }, set: { draft?.setField(field, value: .string($0)) })) {
                                    ForEach(choices, id: \.value) { choice in Text(choice.label).tag(choice.value) }
                                }.frame(minHeight: T3Metrics.minimumTapTarget)
                            } else {
                                Text(field.label).font(T3Typography.supportingStrong)
                                let binding = Binding(get: { draft?.config[field.key]?.stringValue ?? "" }, set: { draft?.setField(field, value: .string($0)) })
                                if field.control == "password" {
                                    SecureField(field.placeholder ?? "", text: binding).textContentType(.password).textFieldStyle(.roundedBorder)
                                } else if field.control == "textarea" {
                                    TextField(field.placeholder ?? "", text: binding, axis: .vertical).lineLimit(3...8).textFieldStyle(.roundedBorder)
                                } else { TextField(field.placeholder ?? "", text: binding).textFieldStyle(.roundedBorder) }
                            }
                            if let description = field.description { Text(description).font(.caption).foregroundStyle(T3Colors.textSecondary) }
                        }
                    }
                }.padding(SettingsMetrics.rowPadding).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
        }
    }

    private func environmentSection(_ value: NativeProviderAccountDraft, definition: NativeProviderSettingsDefinition) -> some View {
        SettingsSection(title: "Environment variables", footer: "Sensitive values are stored securely on the server. Replace a saved secret before changing its name or sensitivity.") {
            VStack(alignment: .leading, spacing: 16) {
                ForEach(Array(value.environment.enumerated()), id: \.offset) { index, row in
                    variableRow(index, row: row)
                    Divider()
                }
                ForEach(definition.environmentFields.filter { field in !value.environment.contains { $0["name"]?.stringValue == field.name } }) { field in
                    Button { draft?.addVariable(name: field.name, sensitive: field.sensitive == true) } label: {
                        Label("Add \(field.label)", systemImage: "plus").frame(minHeight: T3Metrics.minimumTapTarget)
                    }
                }
                Button { draft?.addVariable() } label: { Label("Add variable", systemImage: "plus").frame(minHeight: T3Metrics.minimumTapTarget) }
            }.padding(SettingsMetrics.rowPadding)
        }
    }

    private func variableRow(_ index: Int, row: JSONValue) -> some View {
        let redacted = row["valueRedacted"] == .bool(true)
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField("VARIABLE_NAME", text: Binding(get: { row["name"]?.stringValue ?? "" }, set: { draft?.updateVariable(index, key: "name", value: .string($0)) }))
                    .textFieldStyle(.roundedBorder).disabled(redacted)
                Button(role: .destructive) { draft?.environment.remove(at: index) } label: {
                    Image(systemName: "trash").frame(minWidth: T3Metrics.minimumTapTarget, minHeight: T3Metrics.minimumTapTarget)
                }.accessibilityLabel("Remove \(row["name"]?.stringValue ?? "variable")")
            }
            let binding = Binding(get: { redacted ? "" : (row["value"]?.stringValue ?? "") }, set: { draft?.updateVariable(index, key: "value", value: .string($0)) })
            if row["sensitive"] == .bool(true) {
                SecureField(redacted ? "Saved secret — enter replacement" : "Value", text: binding).textFieldStyle(.roundedBorder)
            } else { TextField("Value", text: binding).textFieldStyle(.roundedBorder) }
            Toggle("Sensitive", isOn: Binding(get: { row["sensitive"] == .bool(true) }, set: { draft?.updateVariable(index, key: "sensitive", value: .bool($0)) }))
                .disabled(redacted).frame(minHeight: T3Metrics.minimumTapTarget)
            if redacted {
                Button("Clear saved secret", role: .destructive) { draft?.updateVariable(index, key: "value", value: .string("")) }
                    .frame(minHeight: T3Metrics.minimumTapTarget)
            }
        }.textInputAutocapitalization(.never).autocorrectionDisabled()
    }

    private func labeledText(_ title: String, placeholder: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(T3Typography.supportingStrong)
            TextField(placeholder, text: text).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
        }
    }
    private func color(_ hex: String) -> Color {
        let value = UInt32(hex.dropFirst(), radix: 16) ?? 0
        return Color(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
    }
    private func load() async {
        defer { loading = false }
        guard let instanceID, let driver else {
            if let first = definitions.first { draft = NativeProviderAccountDraft(driver: first.driver) }
            else { errorMessage = "Provider forms could not be loaded." }
            return
        }
        do {
            let config = try await manager.providerModelConfiguration(environmentID: environmentID)
            guard !Task.isCancelled, let settings = config.settings else { return }
            if installedProvider == nil { installedProvider = config.providers.first { $0.instanceId == instanceID } }
            let original = try NativeProviderAccountDraft.resolve(instanceID: instanceID, driver: driver,
                instances: settings.providerInstances, legacy: settings.providerDefinitions, definition: definitions.first { $0.driver == driver })
            draft = NativeProviderAccountDraft(driver: driver, instanceID: instanceID, original: original)
        } catch { errorMessage = error.localizedDescription }
    }
    private func save() async {
        guard supported, !pending, let draft else { return }
        pending = true
        defer { pending = false }
        do {
            let snapshot = try await manager.providerModelConfiguration(environmentID: environmentID)
            guard let settings = snapshot.settings else { throw ProviderAccountEditError.invalid("Server settings are unavailable.") }
            let latest: [String: JSONValue]?
            if draft.isNew {
                guard !snapshot.providers.contains(where: { $0.instanceId == draft.instanceID }),
                      !definitions.contains(where: { $0.hasDefaultInstance && $0.driver == draft.instanceID }) else {
                    throw ProviderAccountEditError.invalid("That account ID is reserved or already exists.")
                }
                latest = nil
            } else {
                latest = try NativeProviderAccountDraft.resolve(instanceID: draft.instanceID, driver: draft.driver,
                    instances: settings.providerInstances, legacy: settings.providerDefinitions, definition: definition)
            }
            let instances = try draft.merging(into: settings.providerInstances, latest: latest)
            var patch = ServerSettingsPatchInput(providerInstances: instances)
            if draft.driver == "hermes", draft.enabled { patch.enableHermes = true }
            try await manager.updateServerSettings(environmentID: environmentID, patch: patch)
            await onSaved()
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
    private func remove() async {
        guard supported, !pending, let draft, draft.canRemove else { return }
        pending = true
        defer { pending = false }
        do {
            let snapshot = try await manager.providerModelConfiguration(environmentID: environmentID)
            guard let settings = snapshot.settings else { throw ProviderAccountEditError.invalid("Server settings are unavailable.") }
            guard settings.providerInstances[draft.instanceID] == draft.original.map(JSONValue.object) else {
                throw ProviderAccountEditError.invalid("This account changed on another client. Reopen its settings before removing it.")
            }
            var instances = settings.providerInstances
            instances.removeValue(forKey: draft.instanceID)
            try await manager.updateServerSettings(environmentID: environmentID, patch: ServerSettingsPatchInput(providerInstances: instances))
            await onSaved()
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
}
