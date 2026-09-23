import SwiftUI
import UIKit

/// A provider account's configuration, or a new account. An edit sheet: edits
/// stay local until the confirm button sends them, and leaving with edits asks
/// first. Presented by Agents; owns its NavigationStack.
struct SettingsProviderAccountView: View {
    let manager: any FeatureServerSettingsManaging
    let environmentID: String
    let instanceID: String?
    let driver: String?
    let supported: Bool
    var serverName: String? = nil
    let onSaved: () async -> Void
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var draft: NativeProviderAccountDraft?
    @State private var loading = true
    @State private var pending = false
    @State private var loadError: String?
    @State private var saveError: String?
    @State private var updateError: String?
    @State private var confirmRemoval = false
    @State private var installedProvider: ServerProviderSnapshot?
    @State private var updatingProvider = false
    @State private var checkingUpdate = false
    private let definitions = NativeProviderSettingsDefinition.catalog
    private var definition: NativeProviderSettingsDefinition? { definitions.first { $0.driver == draft?.driver } }

    private static let swatches = ["#4F7AFF", "#8B5CF6", "#EC4899", "#EF4444", "#F59E0B", "#10B981"]

    var body: some View {
        NavigationStack {
            SettingsForm {
                if let loadError, draft == nil {
                    SettingsRetrySection(message: loadError) { Task { await load() } }
                } else if loading, draft == nil {
                    Section { SettingsPlaceholderRows(count: 4) }
                } else if let draft {
                    if draft.isNew {
                        Section {
                            Picker("Provider", selection: Binding(get: { draft.driver }, set: { self.draft = NativeProviderAccountDraft(driver: $0) })) {
                                ForEach(definitions) { item in Text(item.label).tag(item.driver) }
                            }
                            .pickerStyle(.menu)
                        } footer: {
                            if !supported { Text("Update this server to add provider accounts.") }
                        }
                    }
                    if let definition {
                        Group {
                            identitySection(draft, definition: definition)
                            colorSection(draft)
                        }
                        .disabled(updatingProvider || !supported)
                        if !draft.isNew { setupSection(draft) }
                        configurationSection(draft, definition: definition).disabled(updatingProvider || !supported)
                        environmentSection(draft, definition: definition).disabled(updatingProvider || !supported)
                        if draft.canRemove {
                            Section {
                                Button("Remove Account", role: .destructive) { confirmRemoval = true }
                                    .disabled(updatingProvider || !supported)
                                    .confirmationDialog("Remove this provider account?", isPresented: $confirmRemoval, titleVisibility: .visible) {
                                        Button("Remove Account", role: .destructive) { Task { await remove() } }
                                        Button("Cancel", role: .cancel) {}
                                    } message: {
                                        Text("You can add it again using the same account ID. Stored environment credentials for this account will be removed.")
                                    }
                            } footer: {
                                Text("Existing conversations remain, but this account will no longer be available for new runs.")
                            }
                        }
                    } else {
                        Section {} footer: {
                            Text("This provider's settings are not supported by this version of the app. Its existing configuration is preserved.")
                        }
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .disabled(pending)
            .navigationTitle(instanceID == nil ? "New Account" : (definition?.label ?? "Account"))
            .navigationBarTitleDisplayMode(.inline)
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: instanceID == nil ? "Add" : "Save",
                    isEnabled: canSave,
                    isBusy: pending,
                    action: { Task { await save() } }
                ),
                hasChanges: hasChanges || pending
            )
            .task { await load() }
            .task(id: environmentID) { await observeProviderUpdates() }
            .alert(
                "Couldn't Save Account",
                isPresented: Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })
            ) {
                Button("OK") { saveError = nil }
            } message: {
                Text(saveError ?? "")
            }
        }
    }

    private var hasChanges: Bool {
        guard let draft else { return false }
        if draft.isNew {
            return !draft.instanceID.isEmpty || draft.envelope != NativeProviderAccountDraft(driver: draft.driver).envelope
        }
        return draft.envelope != draft.original
    }

    private var canSave: Bool {
        guard let draft, definition != nil else { return false }
        return supported && !loading && !pending && !updatingProvider
            && draft.validationIssue == nil
            && (draft.isNew || hasChanges)
    }

    // MARK: - Sections

    private func identitySection(_ value: NativeProviderAccountDraft, definition: NativeProviderSettingsDefinition) -> some View {
        Section {
            if value.isNew {
                LabeledContent("Account ID") {
                    TextField("codex_personal", text: Binding(get: { draft?.instanceID ?? "" }, set: { draft?.instanceID = $0 }))
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            } else {
                LabeledContent("Account ID") {
                    Label(value.instanceID, systemImage: "lock.fill")
                        .labelStyle(.titleAndIcon)
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }
            LabeledContent("Display Name") {
                TextField(definition.label, text: Binding(get: { draft?.name ?? "" }, set: { draft?.name = $0 }))
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            Toggle("Enabled", isOn: Binding(get: { draft?.enabled ?? false }, set: { draft?.enabled = $0 }))
            if let provider = installedProvider, !value.isNew {
                LabeledContent("Status", value: SettingsAgentStatus.label(for: provider))
            }
        } header: {
            if let badge = definition.badgeLabel { Text(badge) }
        } footer: {
            SettingsFooter(
                text: supported
                    ? "Settings apply to this paired server. Paths refer to files on that server."
                    : "Update this server to edit provider accounts.",
                error: value.isNew && !value.instanceID.isEmpty ? value.instanceIDIssue : nil
            )
        }
    }

    private func colorSection(_ value: NativeProviderAccountDraft) -> some View {
        Section {
            HStack(spacing: 10) {
                swatch(nil, isSelected: value.accent.isEmpty)
                ForEach(Self.swatches, id: \.self) { hex in
                    swatch(hex, isSelected: value.accent.lowercased() == hex.lowercased())
                }
                Spacer(minLength: 0)
                ColorPicker(
                    "Custom Color",
                    selection: Binding(
                        get: { Self.color(value.accent) ?? T3Colors.accent },
                        set: { draft?.accent = Self.hex($0) }
                    ),
                    supportsOpacity: false
                )
                .labelsHidden()
            }
            .padding(.vertical, 4)
        } header: {
            Text("Account Color")
        } footer: {
            SettingsFooter(
                text: value.accent.isEmpty ? "Uses the provider's color." : nil,
                error: value.accentIssue
            )
        }
    }

    private func swatch(_ hex: String?, isSelected: Bool) -> some View {
        Button {
            draft?.accent = hex ?? ""
            PlatformHapticEngine.shared.playSelection()
        } label: {
            ZStack {
                if let hex, let color = Self.color(hex) {
                    Circle().fill(color)
                } else {
                    Image(systemName: "circle.slash")
                        .font(.title3)
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }
            .frame(width: 26, height: 26)
            .padding(4)
            .overlay {
                if isSelected {
                    Circle().stroke(T3Colors.textPrimary, lineWidth: 2)
                }
            }
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(hex.map { "Account color \($0)" } ?? "Default color")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    @ViewBuilder
    private func setupSection(_ value: NativeProviderAccountDraft) -> some View {
        let isDirty = value.envelope != value.original
        if value.driver == "hermes", let workManager = manager as? any FeatureWorkManaging {
            Section {
                NavigationLink {
                    SettingsHermesSetupView(manager: workManager, environmentID: environmentID, instanceID: value.instanceID)
                } label: {
                    Text("Set Up Hermes")
                }
                .disabled(!supported || isDirty)
            } footer: {
                Text(isDirty ? "Save your changes before setting up Hermes." : "Hermes runs on this server.")
            }
        } else if value.driver == "antigravity" {
            Section {
                NavigationLink {
                    SettingsAntigravitySetupView(
                        manager: manager,
                        environmentID: environmentID,
                        instanceID: value.instanceID,
                        authMethod: value.config["authMethod"]?.stringValue ?? "oauth-personal",
                        binaryPath: value.config["binaryPath"]?.stringValue ?? "",
                        serverName: serverName
                    )
                } label: {
                    Text("Install and Sign In")
                }
                .disabled(!supported || isDirty)
            } footer: {
                Text(isDirty ? "Save your changes before installing or signing in." : "Setup runs on this server.")
            }
        } else {
            providerUpdateSection(isDirty: isDirty)
        }
    }

    @ViewBuilder
    private func providerUpdateSection(isDirty: Bool) -> some View {
        Section {
            if let provider = installedProvider {
                if provider.enabled, let compatibility = provider.compatibilityAdvisory,
                   let title = compatibility.title {
                    VStack(alignment: .leading, spacing: 2) {
                        Label(title, systemImage: "exclamationmark.triangle.fill")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(compatibility.isIncompatible ? T3Colors.warning : T3Colors.textSecondary)
                        Text(compatibility.detail)
                            .font(.footnote)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                    .accessibilityElement(children: .combine)
                }
                LabeledContent("Version", value: provider.version ?? "Unknown")
                    .contextMenu {
                        if let command = provider.versionAdvisory?.updateCommand,
                           provider.compatibilityAdvisory?.latestIsIncompatible != true {
                            Button("Copy Update Command", systemImage: "doc.on.doc") {
                                UIPasteboard.general.string = command
                            }
                        }
                    }
                if let latest = provider.versionAdvisory?.latestVersion, latest != provider.version {
                    LabeledContent(
                        "Latest",
                        value: provider.compatibilityAdvisory?.latestIsIncompatible == true ? "\(latest) · Unsupported" : latest
                    )
                }
                if let version = provider.installableRecommendedVersion {
                    Button { Task { await performProviderUpdate(targetVersion: version) } } label: {
                        HStack {
                            Text("Install \(version)")
                            if updatingProvider || provider.updateState?.isActive == true {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(updatingProvider || checkingUpdate || provider.updateState?.isActive == true || isDirty)
                    .accessibilityIdentifier("provider-install-recommended")
                }
                if provider.offersLatestUpdate, provider.installableRecommendedVersion == nil {
                    Button { Task { await performProviderUpdate() } } label: {
                        HStack {
                            Text(provider.versionAdvisory?.latestVersion.map { "Update to \($0)" } ?? "Update")
                            if updatingProvider || provider.updateState?.isActive == true {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(updatingProvider || checkingUpdate || provider.updateState?.isActive == true || isDirty)
                    .accessibilityIdentifier("provider-update")
                }
                if let state = provider.updateState, state.status != "idle", let output = state.output, !output.isEmpty {
                    DisclosureGroup("Output") {
                        Text(output)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
            }
            Button { Task { await refreshProviderUpdate() } } label: {
                HStack {
                    Text("Check for Updates")
                    if checkingUpdate {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(updatingProvider || checkingUpdate)
        } header: {
            Text("Installed Provider")
        } footer: {
            SettingsFooter(text: updateFooter(isDirty: isDirty), error: updateError ?? failedUpdateMessage)
        }
    }

    private func updateFooter(isDirty: Bool) -> String {
        if isDirty { return "Save your changes before updating." }
        if installedProvider?.compatibilityAdvisory?.latestIsIncompatible == true,
           installedProvider?.versionAdvisory?.status == "behind_latest" {
            return "The latest version isn’t supported by this server’s T3 Code release, so it isn’t offered."
        }
        if installedProvider?.versionAdvisory?.status == "behind_latest",
           installedProvider?.versionAdvisory?.offersUpdate != true {
            return "Update this provider using its original installer on the paired server. The command is in the Version row's menu."
        }
        if let state = installedProvider?.updateState, state.status != "idle", state.status != "failed" {
            return state.message ?? state.status.capitalized
        }
        return "Updates run on this server using the provider's own installer."
    }

    private var failedUpdateMessage: String? {
        guard let state = installedProvider?.updateState, state.status == "failed" else { return nil }
        return state.message ?? "The update failed."
    }

    @ViewBuilder
    private func configurationSection(_ value: NativeProviderAccountDraft, definition: NativeProviderSettingsDefinition) -> some View {
        if !definition.fields.isEmpty {
            Section("Connection") {
                ForEach(definition.fields) { field in
                    VStack(alignment: .leading, spacing: 4) {
                        fieldControl(field, value: value)
                        if let description = field.description {
                            Text(description)
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                    }
                }
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
    }

    @ViewBuilder
    private func fieldControl(_ field: NativeProviderSettingsDefinition.Field, value: NativeProviderAccountDraft) -> some View {
        let text = Binding(get: { draft?.config[field.key]?.stringValue ?? "" }, set: { draft?.setField(field, value: .string($0)) })
        switch field.control {
        case "switch":
            Toggle(field.label, isOn: Binding(
                get: { value.config[field.key] == .bool(true) || (value.config[field.key] == nil && field.defaultBooleanValue == true) },
                set: { draft?.setField(field, value: .bool($0)) }
            ))
        case "select" where field.options != nil:
            let choices = field.options ?? []
            Picker(field.label, selection: Binding(
                get: { draft?.config[field.key]?.stringValue ?? choices.first?.value ?? "" },
                set: { draft?.setField(field, value: .string($0)) }
            )) {
                ForEach(choices, id: \.value) { choice in Text(choice.label).tag(choice.value) }
            }
            .pickerStyle(.menu)
        case "password":
            LabeledContent(field.label) {
                SecureField(field.placeholder ?? "Required", text: text)
                    .textContentType(.password)
                    .multilineTextAlignment(.trailing)
            }
        case "textarea":
            Text(field.label)
            TextField(field.placeholder ?? "", text: text, axis: .vertical)
                .lineLimit(3...8)
                .font(.system(.body, design: .monospaced))
        default:
            LabeledContent(field.label) {
                TextField(field.placeholder ?? "", text: text)
                    .multilineTextAlignment(.trailing)
            }
        }
    }

    private func environmentSection(_ value: NativeProviderAccountDraft, definition: NativeProviderSettingsDefinition) -> some View {
        Section {
            ForEach(Array(value.environment.enumerated()), id: \.offset) { index, row in
                NavigationLink {
                    ProviderVariableEditor(draft: $draft, index: index)
                } label: {
                    variableLabel(row)
                }
                .swipeActions(edge: .trailing) {
                    Button("Delete", systemImage: "trash", role: .destructive) {
                        draft?.environment.remove(at: index)
                    }
                }
            }
            ForEach(definition.environmentFields.filter { field in !value.environment.contains { $0["name"]?.stringValue == field.name } }) { field in
                Button("Add \(field.label)", systemImage: "plus") {
                    draft?.addVariable(name: field.name, sensitive: field.sensitive == true)
                }
            }
            Button("Add Variable", systemImage: "plus") { draft?.addVariable() }
        } header: {
            Text("Environment Variables")
        } footer: {
            SettingsFooter(
                text: "Sensitive values are stored securely on the server. Replace a saved secret before renaming it.",
                error: value.environmentIssue
            )
        }
    }

    private func variableLabel(_ row: JSONValue) -> some View {
        let name = row["name"]?.stringValue ?? ""
        let sensitive = row["sensitive"] == .bool(true)
        let redacted = row["valueRedacted"] == .bool(true)
        let rawValue = row["value"]?.stringValue ?? ""
        return LabeledContent {
            if redacted {
                Label("Saved Secret", systemImage: "lock.fill")
            } else if sensitive {
                Text(rawValue.isEmpty ? "Empty" : "Hidden")
            } else {
                Text(rawValue.isEmpty ? "Empty" : rawValue).lineLimit(1)
            }
        } label: {
            Text(name.isEmpty ? "Unnamed" : name)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(name.isEmpty ? T3Colors.textTertiary : T3Colors.textPrimary)
        }
    }

    // MARK: - Colors

    private static func color(_ hex: String) -> Color? {
        let trimmed = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil,
              let value = UInt32(trimmed.dropFirst(), radix: 16) else { return nil }
        return Color(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
    }

    private static func hex(_ color: Color) -> String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        func byte(_ value: CGFloat) -> Int { Int((min(1, max(0, value)) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", byte(red), byte(green), byte(blue))
    }

    // MARK: - Requests

    private func observeProviderUpdates() async {
        guard let instanceID else { return }
        do {
            let events = try await manager.providerUpdateEvents(environmentID: environmentID)
            for try await providers in events {
                guard !Task.isCancelled else { return }
                installedProvider = providers.first { $0.instanceId == instanceID }
            }
        } catch {
            if !Task.isCancelled { updateError = error.localizedDescription }
        }
    }

    private func refreshProviderUpdate() async {
        guard let instanceID, !checkingUpdate, !updatingProvider else { return }
        checkingUpdate = true
        updateError = nil
        defer { checkingUpdate = false }
        do {
            let providers = try await manager.refreshProviderUpdates(environmentID: environmentID)
            guard !Task.isCancelled else { return }
            installedProvider = providers.first { $0.instanceId == instanceID }
        } catch {
            PlatformHapticEngine.shared.play(.error)
            updateError = error.localizedDescription
        }
    }

    /// Updates to the latest version, or installs the policy's recommended
    /// version when `targetVersion` is set.
    private func performProviderUpdate(targetVersion: String? = nil) async {
        guard let instanceID, let driver, let provider = installedProvider, !updatingProvider, !checkingUpdate,
              targetVersion.map({ $0 == provider.installableRecommendedVersion }) ?? provider.offersLatestUpdate,
              provider.updateState?.isActive != true, draft?.envelope == draft?.original else { return }
        updatingProvider = true
        updateError = nil
        defer { updatingProvider = false }
        do {
            let providers = try await manager.updateProvider(
                environmentID: environmentID,
                driver: driver,
                instanceID: instanceID,
                targetVersion: targetVersion
            )
            guard !Task.isCancelled else { return }
            installedProvider = providers.first { $0.instanceId == instanceID }
            PlatformHapticEngine.shared.play(.success)
            await onSaved()
        } catch {
            PlatformHapticEngine.shared.play(.error)
            updateError = error.localizedDescription
        }
    }

    private func load() async {
        loading = true
        loadError = nil
        defer { loading = false }
        guard let instanceID, let driver else {
            if let first = definitions.first { draft = NativeProviderAccountDraft(driver: first.driver) }
            else { loadError = "Provider forms could not be loaded." }
            return
        }
        do {
            let config = try await manager.providerModelConfiguration(environmentID: environmentID)
            guard !Task.isCancelled else { return }
            guard let settings = config.settings else {
                loadError = "This server did not send its settings. Update it and try again."
                return
            }
            if installedProvider == nil { installedProvider = config.providers.first { $0.instanceId == instanceID } }
            let original = try NativeProviderAccountDraft.resolve(instanceID: instanceID, driver: driver,
                instances: settings.providerInstances, legacy: settings.providerDefinitions, definition: definitions.first { $0.driver == driver })
            draft = NativeProviderAccountDraft(driver: driver, instanceID: instanceID, original: original)
        } catch { loadError = error.localizedDescription }
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
            PlatformHapticEngine.shared.play(.success)
            await onSaved()
            dismiss()
        } catch {
            PlatformHapticEngine.shared.play(.error)
            saveError = error.localizedDescription
        }
    }

    private func remove() async {
        guard supported, !pending, let draft, draft.canRemove else { return }
        pending = true
        defer { pending = false }
        do {
            let snapshot = try await manager.providerModelConfiguration(environmentID: environmentID)
            guard let settings = snapshot.settings else { throw ProviderAccountEditError.invalid("Server settings are unavailable.") }
            guard settings.providerInstances[draft.instanceID] == draft.original.map(JSONValue.object) else {
                throw ProviderAccountEditError.invalid("This account changed on another device. Close it and open it again before removing it.")
            }
            var instances = settings.providerInstances
            instances.removeValue(forKey: draft.instanceID)
            try await manager.updateServerSettings(environmentID: environmentID, patch: ServerSettingsPatchInput(providerInstances: instances))
            await onSaved()
            dismiss()
        } catch {
            PlatformHapticEngine.shared.play(.error)
            saveError = error.localizedDescription
        }
    }
}

/// One environment variable of an account draft. Edits land in the draft
/// directly; the account sheet's confirm button is what sends them.
private struct ProviderVariableEditor: View {
    @Binding var draft: NativeProviderAccountDraft?
    let index: Int

    private var row: JSONValue? {
        guard let draft, draft.environment.indices.contains(index) else { return nil }
        return draft.environment[index]
    }

    var body: some View {
        SettingsForm {
            if let row {
                let redacted = row["valueRedacted"] == .bool(true)
                let sensitive = row["sensitive"] == .bool(true)
                Section {
                    LabeledContent("Name") {
                        TextField("VARIABLE_NAME", text: binding("name"))
                            .font(.system(.body, design: .monospaced))
                            .multilineTextAlignment(.trailing)
                            .disabled(redacted)
                    }
                    if sensitive {
                        LabeledContent("Value") {
                            SecureField(redacted ? "Saved Secret" : "Value", text: binding("value", hideRedacted: true))
                                .multilineTextAlignment(.trailing)
                        }
                    } else {
                        LabeledContent("Value") {
                            TextField("Value", text: binding("value", hideRedacted: true))
                                .multilineTextAlignment(.trailing)
                        }
                    }
                    Toggle("Sensitive", isOn: Binding(
                        get: { row["sensitive"] == .bool(true) },
                        set: { draft?.updateVariable(index, key: "sensitive", value: .bool($0)) }
                    ))
                    .disabled(redacted)
                } footer: {
                    if redacted {
                        Text("A saved secret keeps its name and sensitivity. Enter a replacement value to change them.")
                    }
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                if redacted {
                    Section {
                        Button("Clear Saved Secret", role: .destructive) {
                            draft?.updateVariable(index, key: "value", value: .string(""))
                        }
                    }
                }
            } else {
                ContentUnavailableView("Variable Removed", systemImage: "trash")
            }
        }
        .navigationTitle(row?["name"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Variable")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func binding(_ key: String, hideRedacted: Bool = false) -> Binding<String> {
        Binding(
            get: {
                guard let row else { return "" }
                if hideRedacted, row["valueRedacted"] == .bool(true) { return "" }
                return row[key]?.stringValue ?? ""
            },
            set: { draft?.updateVariable(index, key: key, value: .string($0)) }
        )
    }
}
