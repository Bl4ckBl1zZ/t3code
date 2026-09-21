import SwiftUI

/// Model IDs an account can run beyond its built-in list. Add from the
/// toolbar, tap to edit, swipe to remove behind a confirmation.
struct SettingsCustomModelsView: View {
    let manager: any FeatureServerSettingsManaging
    let environmentID: String
    let provider: ServerProviderSnapshot
    let supported: Bool
    @State private var entries: [JSONValue] = []
    @State private var builtInModels: [ServerProviderModelSnapshot] = []
    @State private var loading = true
    @State private var hasLoaded = false
    @State private var busySlug: String?
    @State private var loadError: String?
    @State private var writeError: String?
    @State private var editor: EditorTarget?
    @State private var removalTarget: NativeCustomModelDefinition?

    private struct EditorTarget: Identifiable {
        let definition: NativeCustomModelDefinition?
        var id: String { definition?.slug ?? "\u{0}new" }
    }

    private var definitions: [NativeCustomModelDefinition] {
        NativeCustomModelDefinition.readEntries(entries)
    }

    var body: some View {
        content
            .navigationTitle("Custom Models")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Add Model", systemImage: "plus") { editor = EditorTarget(definition: nil) }
                        .disabled(!supported || !hasLoaded || busySlug != nil)
                }
            }
            .task(id: environmentID) { await load() }
            .sheet(item: $editor) { target in
                NativeCustomModelEditor(
                    definition: target.definition,
                    driver: provider.driver,
                    builtInModels: builtInModels,
                    existingSlugs: Set(definitions.map(\.slug)).union(builtInModels.map(\.slug))
                ) { updated in
                    try await save(updated, replacing: target.definition?.slug)
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if hasLoaded, definitions.isEmpty, loadError == nil {
            ContentUnavailableView {
                Label("No Custom Models", systemImage: "cpu")
            } description: {
                Text(supported
                    ? "Add a model ID \(provider.displayName ?? "this provider") supports to run it from the model picker."
                    : "Update this server to edit custom model definitions.")
            } actions: {
                if supported {
                    Button("Add Model") { editor = EditorTarget(definition: nil) }
                        .t3ProminentButtonStyle()
                }
            }
            .background(T3Colors.background)
        } else {
            SettingsForm {
                if let loadError, !hasLoaded {
                    SettingsRetrySection(message: loadError) { Task { await load() } }
                } else if !hasLoaded {
                    Section { SettingsPlaceholderRows(count: 2) }
                } else {
                    Section {
                        ForEach(definitions) { entry in row(entry) }
                    } footer: {
                        SettingsFooter(
                            text: supported
                                ? "A display name changes the model's label in the picker. Custom options replace the provider's defaults for that model."
                                : "Update this server to edit custom model definitions.",
                            error: writeError
                        )
                    }
                }
            }
            .refreshable { await load() }
        }
    }

    private func row(_ entry: NativeCustomModelDefinition) -> some View {
        Button {
            editor = EditorTarget(definition: entry)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.name).foregroundStyle(T3Colors.textPrimary)
                    if entry.name != entry.slug {
                        Text(entry.slug)
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                }
                Spacer(minLength: 8)
                if busySlug == entry.slug { ProgressView() }
            }
            .contentShape(Rectangle())
        }
        .disabled(!supported || busySlug != nil)
        .swipeActions(edge: .trailing) {
            if supported {
                Button("Remove", systemImage: "trash", role: .destructive) { removalTarget = entry }
            }
        }
        .contextMenu {
            if supported {
                Button("Remove Model", systemImage: "trash", role: .destructive) { removalTarget = entry }
            }
        }
        .confirmationDialog(
            "Remove \(entry.name)?",
            isPresented: Binding(get: { removalTarget?.slug == entry.slug }, set: { if !$0 { removalTarget = nil } }),
            titleVisibility: .visible
        ) {
            Button("Remove Model", role: .destructive) { Task { await remove(entry) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It disappears from model pickers on this server. Threads that used it keep their history.")
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let config = try await manager.providerModelConfiguration(environmentID: environmentID)
            guard !Task.isCancelled else { return }
            guard let settings = config.settings else {
                loadError = CustomModelEditError.invalidAccount.localizedDescription
                return
            }
            entries = NativeCustomModelSettings.entries(settings: settings, instanceID: provider.instanceId, driver: provider.driver)
            builtInModels = (config.providers.first { $0.instanceId == provider.instanceId }?.models ?? []).filter { !$0.isCustom }
            loadError = nil
            hasLoaded = true
        } catch {
            if !Task.isCancelled { loadError = error.localizedDescription }
        }
    }

    private func save(_ entry: NativeCustomModelDefinition, replacing slug: String?) async throws {
        guard supported, busySlug == nil else { throw FeatureCapabilityUnavailable("Custom model definitions") }
        busySlug = slug ?? entry.slug
        defer { busySlug = nil }
        let config = try await manager.providerModelConfiguration(environmentID: environmentID)
        guard let settings = config.settings else { throw CustomModelEditError.invalidAccount }
        var next = NativeCustomModelSettings.entries(settings: settings, instanceID: provider.instanceId, driver: provider.driver)
        if let slug {
            guard let index = next.firstIndex(where: { NativeCustomModelDefinition.read($0)?.slug == slug }) else {
                throw CustomModelEditError.invalidDraft("This custom model was removed on another device. Close the editor to continue.")
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
        writeError = nil
    }

    private func remove(_ entry: NativeCustomModelDefinition) async {
        removalTarget = nil
        guard supported, busySlug == nil else { return }
        busySlug = entry.slug
        defer { busySlug = nil }
        do {
            let config = try await manager.providerModelConfiguration(environmentID: environmentID)
            guard let settings = config.settings else { throw CustomModelEditError.invalidAccount }
            let next = NativeCustomModelSettings.entries(settings: settings, instanceID: provider.instanceId, driver: provider.driver)
                .filter { NativeCustomModelDefinition.read($0)?.slug != entry.slug }
            try await manager.updateServerSettings(environmentID: environmentID,
                patch: NativeCustomModelSettings.patch(settings: settings, instanceID: provider.instanceId, driver: provider.driver, entries: next))
            entries = next
            writeError = nil
        } catch {
            PlatformHapticEngine.shared.play(.error)
            writeError = "Couldn't remove \(entry.name). \(error.localizedDescription)"
        }
    }
}

/// Adds or edits one custom model. An edit sheet: the draft is validated as
/// it is typed, and confirm stays off until it would save.
struct NativeCustomModelEditor: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let definition: NativeCustomModelDefinition?
    let driver: String
    let builtInModels: [ServerProviderModelSnapshot]
    let existingSlugs: Set<String>
    let save: (NativeCustomModelDefinition) async throws -> Void
    private let initialDraft: NativeCustomModelDraft
    @State private var draft: NativeCustomModelDraft
    @State private var saving = false
    @State private var errorMessage: String?

    init(
        definition: NativeCustomModelDefinition?,
        driver: String,
        builtInModels: [ServerProviderModelSnapshot],
        existingSlugs: Set<String> = [],
        save: @escaping (NativeCustomModelDefinition) async throws -> Void
    ) {
        self.definition = definition
        self.driver = driver
        self.builtInModels = builtInModels
        self.existingSlugs = existingSlugs
        self.save = save
        let draft = NativeCustomModelDraft(definition: definition)
        initialDraft = draft
        _draft = State(initialValue: draft)
    }

    private var isNew: Bool { definition == nil }

    private var duplicateSlug: Bool {
        isNew && existingSlugs.contains(draft.slug.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Why the draft cannot be saved yet. An untouched new draft says nothing:
    /// an empty form is not an error.
    private var validation: String? {
        if duplicateSlug { return CustomModelEditError.duplicate.localizedDescription }
        do {
            _ = try draft.definition()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    private var hasChanges: Bool { draft != initialDraft }

    var body: some View {
        NavigationStack {
            SettingsForm {
                Section {
                    if isNew {
                        LabeledContent("Model ID") {
                            TextField("Required", text: $draft.slug)
                                .font(.system(.body, design: .monospaced))
                                .multilineTextAlignment(.trailing)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    } else {
                        LabeledContent("Model ID") {
                            Label(draft.slug, systemImage: "lock.fill")
                                .font(.system(.body, design: .monospaced))
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                    }
                    LabeledContent("Display Name") {
                        TextField("Optional", text: $draft.name)
                            .multilineTextAlignment(.trailing)
                            .autocorrectionDisabled()
                    }
                } footer: {
                    SettingsFooter(
                        text: "Use a model ID your provider supports.",
                        error: duplicateSlug ? CustomModelEditError.duplicate.localizedDescription : nil
                    )
                }

                ForEach($draft.options) { $option in
                    NativeCustomModelOptionSection(
                        index: draft.options.firstIndex { $0.id == option.id } ?? 0,
                        option: $option
                    ) {
                        draft.options.removeAll { $0.id == option.id }
                    }
                }

                Section {
                    addOptionMenu
                } footer: {
                    SettingsFooter(
                        text: draft.options.isEmpty
                            ? "No custom options. The provider's defaults apply."
                            : "Use option IDs this provider supports. Others are saved but may be ignored when the model runs.",
                        error: hasChanges && !duplicateSlug && !draft.slug.isEmpty ? validation : nil
                    )
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .disabled(saving)
            .navigationTitle(isNew ? "Add Model" : "Edit Model")
            .navigationBarTitleDisplayMode(.inline)
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: isNew ? "Add" : "Save",
                    isEnabled: hasChanges && validation == nil && !saving,
                    isBusy: saving,
                    action: { Task { await commit() } }
                ),
                hasChanges: hasChanges || saving
            )
            .alert(
                "Couldn't Save Model",
                isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
            ) {
                Button("OK") { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    private var addOptionMenu: some View {
        Menu {
            Button("Blank Option", systemImage: "plus") { draft.options.append(NativeCustomModelOption()) }
            let presets = NativeCustomModelDraft.presets(driver: driver)
            if !presets.isEmpty {
                Section("Provider Options") {
                    ForEach(presets) { preset in
                        Button(preset.label) { draft.options.append(preset) }
                            .disabled(draft.options.contains { $0.optionID == preset.optionID })
                    }
                }
            }
            if !builtInModels.isEmpty {
                Section("Copy All Options From") {
                    ForEach(builtInModels) { model in
                        Button(model.name) {
                            draft.options = NativeCustomModelDraft.options(from: model.capabilities, driver: driver)
                        }
                    }
                }
            }
        } label: {
            Label("Add Option", systemImage: "plus")
        }
    }

    private func commit() async {
        guard !saving else { return }
        do {
            let entry = try draft.definition()
            saving = true
            defer { saving = false }
            try await save(entry)
            PlatformHapticEngine.shared.play(.success)
            dismiss()
        } catch {
            PlatformHapticEngine.shared.play(.error)
            errorMessage = error.localizedDescription
        }
    }
}

/// One composer option of a custom model: its ID, label and kind, then either
/// the default for a toggle or the choices with a checkmark on the default.
private struct NativeCustomModelOptionSection: View {
    let index: Int
    @Binding var option: NativeCustomModelOption
    let remove: () -> Void

    var body: some View {
        Section {
            LabeledContent("ID") {
                TextField("Required", text: $option.optionID)
                    .font(.system(.body, design: .monospaced))
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            LabeledContent("Label") {
                TextField("Required", text: $option.label)
                    .multilineTextAlignment(.trailing)
            }
            Picker("Type", selection: $option.kind) {
                Text("Choices").tag("select")
                Text("Toggle").tag("boolean")
            }
            .pickerStyle(.menu)
            if option.kind == "boolean" {
                Toggle("On by Default", isOn: Binding(
                    get: { option.currentBooleanValue ?? false },
                    set: { option.currentBooleanValue = $0 }
                ))
            } else {
                ForEach($option.choices) { $choice in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            TextField("Value", text: $choice.value)
                                .font(.system(.body, design: .monospaced))
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            TextField("Label (optional)", text: $choice.label)
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                        Button {
                            let makeDefault = !choice.isDefault
                            for position in option.choices.indices {
                                option.choices[position].isDefault = makeDefault && option.choices[position].id == choice.id
                            }
                        } label: {
                            Image(systemName: choice.isDefault ? "checkmark.circle.fill" : "circle")
                                .font(.title3)
                                .foregroundStyle(choice.isDefault ? T3Colors.accent : T3Colors.textTertiary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(choice.isDefault ? "Default choice" : "Make default")
                    }
                    .swipeActions(edge: .trailing) {
                        Button("Delete", systemImage: "trash", role: .destructive) {
                            option.choices.removeAll { $0.id == choice.id }
                        }
                    }
                }
                Button("Add Choice", systemImage: "plus") { option.choices.append(NativeCustomModelChoice()) }
            }
            Button("Remove Option", role: .destructive, action: remove)
        } header: {
            Text(option.label.isEmpty ? "Option \(index + 1)" : option.label)
        } footer: {
            if option.kind != "boolean" {
                Text("The checked choice is the default. Swipe a choice to delete it.")
            }
        }
    }
}
