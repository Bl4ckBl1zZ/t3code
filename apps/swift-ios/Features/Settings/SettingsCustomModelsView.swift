import SwiftUI

struct SettingsCustomModelsView: View {
    let manager: any FeatureServerSettingsManaging
    let environmentID: String
    let provider: ServerProviderSnapshot
    let supported: Bool
    @State private var entries: [JSONValue] = []
    @State private var builtInModels: [ServerProviderModelSnapshot] = []
    @State private var loading = true
    @State private var pending = false
    @State private var errorMessage: String?
    @State private var editing: NativeCustomModelDefinition?
    @State private var adding = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let errorMessage { SettingsErrorBanner(message: errorMessage) }
                if loading { ProgressView().frame(maxWidth: .infinity) }
                Text("Use a model ID your provider supports. A display name changes its label in the picker. Custom options replace the provider's defaults for this model.")
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                SettingsSection(title: "Custom models") {
                    ForEach(NativeCustomModelDefinition.readEntries(entries)) { entry in
                        HStack(spacing: 12) {
                            Button { editing = entry } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(entry.name).font(T3Typography.supportingStrong).foregroundStyle(T3Colors.textPrimary)
                                    Text(entry.slug).font(.caption.monospaced()).foregroundStyle(T3Colors.textSecondary)
                                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                            }.buttonStyle(.plain).disabled(!supported)
                            Button(role: .destructive) { Task { await remove(entry) } } label: {
                                Image(systemName: "trash").frame(minWidth: T3Metrics.minimumTapTarget, minHeight: T3Metrics.minimumTapTarget)
                            }.accessibilityLabel("Remove \(entry.name)").disabled(!supported)
                        }.padding(.leading, SettingsMetrics.rowPadding).frame(minHeight: T3Metrics.minimumTapTarget)
                    }
                    if entries.isEmpty && !loading { Text("No custom models.").font(T3Typography.supporting).padding(SettingsMetrics.rowPadding) }
                    Button { adding = true } label: { Label("Add custom model", systemImage: "plus").frame(minHeight: T3Metrics.minimumTapTarget) }
                        .disabled(!supported || loading)
                }.disabled(pending)
                if !supported { Text("Update this server to edit custom model definitions.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary) }
                if pending { ProgressView("Saving models…") }
            }.padding(18)
        }
        .background(T3Colors.background).navigationTitle("Custom models").navigationBarTitleDisplayMode(.inline)
        .task(id: environmentID) { await load() }
        .sheet(item: $editing) { entry in
            NavigationStack { NativeCustomModelEditor(definition: entry, driver: provider.driver, builtInModels: builtInModels) { updated in
                try await save(updated, replacing: entry.slug)
            } }
        }
        .sheet(isPresented: $adding) {
            NavigationStack { NativeCustomModelEditor(definition: nil, driver: provider.driver, builtInModels: builtInModels) { updated in
                try await save(updated, replacing: nil)
            } }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let config = try await manager.providerModelConfiguration(environmentID: environmentID)
            guard !Task.isCancelled, let settings = config.settings else { return }
            entries = NativeCustomModelSettings.entries(settings: settings, instanceID: provider.instanceId, driver: provider.driver)
            builtInModels = (config.providers.first { $0.instanceId == provider.instanceId }?.models ?? []).filter { !$0.isCustom }
        } catch { if !Task.isCancelled { errorMessage = error.localizedDescription } }
    }

    private func save(_ entry: NativeCustomModelDefinition, replacing slug: String?) async throws {
        guard supported, !pending else { throw FeatureCapabilityUnavailable("Custom model definitions") }
        pending = true
        defer { pending = false }
        let config = try await manager.providerModelConfiguration(environmentID: environmentID)
        guard let settings = config.settings else { throw CustomModelEditError.invalidAccount }
        var next = NativeCustomModelSettings.entries(settings: settings, instanceID: provider.instanceId, driver: provider.driver)
        if let slug {
            guard let index = next.firstIndex(where: { NativeCustomModelDefinition.read($0)?.slug == slug }) else {
                throw CustomModelEditError.invalidDraft("This custom model was removed. Refresh the account to continue.")
            }
            next[index] = entry.json
        } else {
            let live = config.providers.first { $0.instanceId == provider.instanceId }?.models ?? []
            guard !next.contains(where: { NativeCustomModelDefinition.read($0)?.slug == entry.slug }),
                  !live.contains(where: { !$0.isCustom && $0.slug == entry.slug }) else { throw CustomModelEditError.duplicate }
            next.append(entry.json)
        }
        try await manager.updateServerSettings(environmentID: environmentID,
            patch: NativeCustomModelSettings.patch(settings: settings, instanceID: provider.instanceId, driver: provider.driver, entries: next))
        entries = next
        errorMessage = nil
    }

    private func remove(_ entry: NativeCustomModelDefinition) async {
        guard supported, !pending else { return }
        pending = true
        defer { pending = false }
        do {
            let config = try await manager.providerModelConfiguration(environmentID: environmentID)
            guard let settings = config.settings else { throw CustomModelEditError.invalidAccount }
            let next = NativeCustomModelSettings.entries(settings: settings, instanceID: provider.instanceId, driver: provider.driver)
                .filter { NativeCustomModelDefinition.read($0)?.slug != entry.slug }
            try await manager.updateServerSettings(environmentID: environmentID,
                patch: NativeCustomModelSettings.patch(settings: settings, instanceID: provider.instanceId, driver: provider.driver, entries: next))
            entries = next
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }
}

struct NativeCustomModelEditor: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let definition: NativeCustomModelDefinition?
    let driver: String
    let builtInModels: [ServerProviderModelSnapshot]
    let save: (NativeCustomModelDefinition) async throws -> Void
    @State private var draft: NativeCustomModelDraft
    @State private var saving = false
    @State private var errorMessage: String?

    init(definition: NativeCustomModelDefinition?, driver: String, builtInModels: [ServerProviderModelSnapshot],
         save: @escaping (NativeCustomModelDefinition) async throws -> Void) {
        self.definition = definition
        self.driver = driver
        self.builtInModels = builtInModels
        self.save = save
        _draft = State(initialValue: NativeCustomModelDraft(definition: definition))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let errorMessage { SettingsErrorBanner(message: errorMessage) }
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Model ID", text: $draft.slug).disabled(definition != nil).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Display name (optional)", text: $draft.name).autocorrectionDisabled()
                }.textFieldStyle(.roundedBorder)
                if !builtInModels.isEmpty {
                    Menu("Copy options from a model") {
                        ForEach(builtInModels) { model in
                            Button(model.name) { draft.options = NativeCustomModelDraft.options(from: model.capabilities, driver: driver) }
                        }
                    }.frame(minHeight: T3Metrics.minimumTapTarget)
                }
                if !NativeCustomModelDraft.presets(driver: driver).isEmpty {
                    Menu("Add a provider option") {
                        ForEach(NativeCustomModelDraft.presets(driver: driver)) { preset in
                            Button(preset.label) { draft.options.append(preset) }
                                .disabled(draft.options.contains { $0.optionID == preset.optionID })
                        }
                    }.frame(minHeight: T3Metrics.minimumTapTarget)
                }
                Text("Options shown in the composer").font(T3Typography.supportingStrong)
                if draft.options.isEmpty { Text("No custom options. The provider's defaults apply.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary) }
                ForEach($draft.options) { $option in
                    NativeCustomModelOptionEditor(option: $option) { draft.options.removeAll { $0.id == option.id } }
                }
                Button { draft.options.append(NativeCustomModelOption()) } label: { Label("Add option", systemImage: "plus").frame(minHeight: T3Metrics.minimumTapTarget) }
                Text("Use option IDs supported by this provider. Other IDs are saved but may be ignored when the model runs.")
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
            }.padding(18).disabled(saving)
        }
        .background(T3Colors.background).navigationTitle(definition == nil ? "Add model" : "Edit model").navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(saving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Saving…" : "Save") { Task { await commit() } }.disabled(saving)
            }
        }
    }

    private func commit() async {
        guard !saving else { return }
        do {
            let entry = try draft.definition()
            saving = true
            defer { saving = false }
            try await save(entry)
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
}

private struct NativeCustomModelOptionEditor: View {
    @Binding var option: NativeCustomModelOption
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                TextField("Option ID", text: $option.optionID).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button(role: .destructive, action: remove) { Image(systemName: "trash").frame(minWidth: T3Metrics.minimumTapTarget, minHeight: T3Metrics.minimumTapTarget) }
                    .accessibilityLabel("Remove option")
            }
            TextField("Label", text: $option.label)
            Picker("Type", selection: $option.kind) { Text("Choices").tag("select"); Text("Toggle").tag("boolean") }.pickerStyle(.segmented)
            if option.kind == "boolean" {
                Toggle("Default on", isOn: Binding(get: { option.currentBooleanValue ?? false }, set: { option.currentBooleanValue = $0 }))
            } else {
                ForEach($option.choices) { $choice in
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("Choice value", text: $choice.value).textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("Choice label", text: $choice.label)
                        HStack {
                            Toggle("Default", isOn: Binding(get: { choice.isDefault }, set: { selected in
                                for index in option.choices.indices { option.choices[index].isDefault = selected && option.choices[index].id == choice.id }
                            }))
                            Button(role: .destructive) { option.choices.removeAll { $0.id == choice.id } } label: {
                                Image(systemName: "minus.circle").frame(minWidth: T3Metrics.minimumTapTarget, minHeight: T3Metrics.minimumTapTarget)
                            }.accessibilityLabel("Remove choice")
                        }
                    }.padding(10).background(T3Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: 10))
                }
                Button { option.choices.append(NativeCustomModelChoice()) } label: { Label("Add choice", systemImage: "plus").frame(minHeight: T3Metrics.minimumTapTarget) }
            }
        }.textFieldStyle(.roundedBorder).padding(14).background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 14))
    }
}
