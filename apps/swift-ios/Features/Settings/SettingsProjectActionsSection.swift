import SwiftUI

/// A list of project actions as Form rows: tap one to edit it, swipe to delete
/// it after confirming, and add new ones from the last row. Used for the
/// machine's defaults and for a single project's own list.
struct SettingsProjectActionsSection: View {
    let scripts: [ProjectScript]
    /// The project the list belongs to, or nil for the machine's defaults.
    let projectName: String?
    let enabled: Bool
    /// Writes the whole list and reports whether it stuck.
    let onSave: ([ProjectScript]?) async -> Bool

    @State private var editor: ActionEditorRequest?
    @State private var deletionTarget: ProjectScript?

    var body: some View {
        Section {
            ForEach(scripts) { script in
                Button { editor = ActionEditorRequest(script: script) } label: {
                    row(script)
                }
                .swipeActions(edge: .trailing) {
                    Button("Delete", role: .destructive) { deletionTarget = script }
                }
                .confirmationDialog(
                    "Delete “\(script.name)”?",
                    isPresented: Binding(
                        get: { deletionTarget?.id == script.id },
                        set: { if !$0 { deletionTarget = nil } }
                    ),
                    titleVisibility: .visible
                ) {
                    Button("Delete Action", role: .destructive) {
                        Task { _ = await onSave(scripts.filter { $0.id != script.id }) }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text(deletionMessage(script))
                }
            }
            Button("Add Action…", systemImage: "plus") { editor = ActionEditorRequest(script: nil) }
                .sheet(item: $editor) { request in
                    SettingsProjectActionEditor(
                        script: request.script,
                        projectName: projectName,
                        onSave: { action in await onSave(ordered(inserting: action)) },
                        onDelete: request.script.map { script in
                            { await onSave(scripts.filter { $0.id != script.id }) }
                        }
                    )
                }
        } footer: {
            if scripts.isEmpty { Text("No actions yet.") }
        }
        .disabled(!enabled)
    }

    private func row(_ script: ProjectScript) -> some View {
        HStack(spacing: 12) {
            Image(systemName: ThreadDetailsWorkspace.scriptIcon(script.icon))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(script.name)
                    .foregroundStyle(T3Colors.textPrimary)
                Text(script.command)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(2)
                let lifecycle = [
                    script.runOnWorktreeCreate ? "Setup" : nil,
                    script.runOnWorktreeDelete == true ? "Teardown" : nil,
                ].compactMap { $0 }
                if !lifecycle.isEmpty {
                    Text(lifecycle.joined(separator: " · "))
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                }
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textTertiary)
                .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func deletionMessage(_ script: ProjectScript) -> String {
        if let projectName { return "“\(script.name)” will be removed from \(projectName)." }
        return "“\(script.name)” will be removed from this machine’s actions."
    }

    /// The list with `action` saved into it. Only one action may run on
    /// worktree creation and one on removal, so choosing either clears it from
    /// the others; an edited action keeps its place so shortcuts and muscle
    /// memory stay stable.
    private func ordered(inserting action: ProjectScript) -> [ProjectScript] {
        var next = scripts.filter { $0.id != action.id }.map { script in
            ProjectScript(
                id: script.id, name: script.name, command: script.command, icon: script.icon,
                runOnWorktreeCreate: action.runOnWorktreeCreate ? false : script.runOnWorktreeCreate,
                runOnWorktreeDelete: action.runOnWorktreeDelete == true ? false : script.runOnWorktreeDelete,
                previewUrl: script.previewUrl, autoOpenPreview: script.autoOpenPreview, singleRun: script.singleRun
            )
        }
        if let index = scripts.firstIndex(where: { $0.id == action.id }) {
            next.insert(action, at: min(index, next.count))
        } else {
            next.append(action)
        }
        return next
    }
}

private struct ActionEditorRequest: Identifiable {
    let id = UUID()
    let script: ProjectScript?
}

/// Add or edit one action. A sheet with cancel and confirm in its toolbar;
/// leaving with edits asks first.
private struct SettingsProjectActionEditor: View {
    private static let icons = ["play", "test", "lint", "configure", "build", "debug"]

    @SwiftUI.Environment(\.dismiss) private var dismiss
    let script: ProjectScript?
    let projectName: String?
    let onSave: (ProjectScript) async -> Bool
    let onDelete: (() async -> Bool)?

    @State private var name: String
    @State private var command: String
    @State private var icon: String
    @State private var setup: Bool
    @State private var teardown: Bool
    @State private var previewURL: String
    @State private var autoOpenPreview: Bool
    @State private var saving = false
    @State private var failure: String?
    @State private var confirmingDelete = false

    init(
        script: ProjectScript?,
        projectName: String?,
        onSave: @escaping (ProjectScript) async -> Bool,
        onDelete: (() async -> Bool)?
    ) {
        self.script = script
        self.projectName = projectName
        self.onSave = onSave
        self.onDelete = onDelete
        _name = State(initialValue: script?.name ?? "")
        _command = State(initialValue: script?.command ?? "")
        _icon = State(initialValue: script?.icon ?? "play")
        _setup = State(initialValue: script?.runOnWorktreeCreate ?? false)
        _teardown = State(initialValue: script?.runOnWorktreeDelete ?? false)
        _previewURL = State(initialValue: script?.previewUrl ?? "")
        _autoOpenPreview = State(initialValue: script?.autoOpenPreview ?? false)
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedCommand: String { command.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedURL: String { previewURL.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isValid: Bool { !trimmedName.isEmpty && !trimmedCommand.isEmpty }

    private var draft: ProjectScript {
        ProjectScript(
            id: script?.id ?? UUID().uuidString.lowercased(),
            name: trimmedName,
            command: trimmedCommand,
            icon: icon,
            runOnWorktreeCreate: setup,
            runOnWorktreeDelete: teardown,
            previewUrl: trimmedURL.isEmpty ? nil : trimmedURL,
            autoOpenPreview: !trimmedURL.isEmpty && autoOpenPreview,
            singleRun: script?.singleRun
        )
    }

    private var hasChanges: Bool {
        guard let script else { return !trimmedName.isEmpty || !trimmedCommand.isEmpty || !trimmedURL.isEmpty }
        return draft != script
    }

    var body: some View {
        NavigationStack {
            SettingsForm {
                Section {
                    TextField("Name", text: $name)
                    TextField("Command", text: $command, axis: .vertical)
                        .font(.system(.body, design: .monospaced))
                        .lineLimit(2...8)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Picker("Icon", selection: $icon) {
                        ForEach(Self.icons, id: \.self) { value in
                            Label(value.capitalized, systemImage: ThreadDetailsWorkspace.scriptIcon(value)).tag(value)
                        }
                    }
                    .pickerStyle(.menu)
                } footer: {
                    if !isValid, hasChanges { Text("Give the action a name and a command.") }
                }

                Section {
                    Toggle("Run on Create", isOn: $setup)
                    Toggle("Run Before Removal", isOn: $teardown)
                } header: {
                    Text("Worktrees")
                } footer: {
                    Text("Commands run in the checkout or worktree. Only one setup and one teardown action can be selected.")
                }

                Section("Preview") {
                    TextField("Preview URL (optional)", text: $previewURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Toggle("Open Automatically on Desktop", isOn: $autoOpenPreview)
                        .disabled(trimmedURL.isEmpty)
                }

                if onDelete != nil {
                    Section {
                        Button("Delete Action", role: .destructive) { confirmingDelete = true }
                            .foregroundStyle(T3Colors.danger)
                            .confirmationDialog(
                                "Delete “\(script?.name ?? "")”?",
                                isPresented: $confirmingDelete,
                                titleVisibility: .visible
                            ) {
                                Button("Delete Action", role: .destructive) { delete() }
                                Button("Cancel", role: .cancel) {}
                            } message: {
                                Text(projectName.map { "It will be removed from \($0)." } ?? "It will be removed from this machine’s actions.")
                            }
                    }
                }
            }
            .disabled(saving)
            .navigationTitle(script == nil ? "Add Action" : "Edit Action")
            .navigationBarTitleDisplayMode(.inline)
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: "Save",
                    isEnabled: isValid && hasChanges,
                    isBusy: saving,
                    action: save
                ),
                hasChanges: hasChanges || saving
            )
            .alert(
                "Couldn't Save Action",
                isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
            ) {
                Button("OK") { failure = nil }
            } message: {
                Text(failure ?? "")
            }
        }
    }

    private func save() {
        guard isValid, !saving else { return }
        saving = true
        Task { @MainActor in
            let saved = await onSave(draft)
            saving = false
            if saved {
                PlatformHapticEngine.shared.play(.success)
                dismiss()
            } else {
                failure = "Check the connection and try again."
            }
        }
    }

    private func delete() {
        guard let onDelete, !saving else { return }
        saving = true
        Task { @MainActor in
            let deleted = await onDelete()
            saving = false
            if deleted { dismiss() } else { failure = "The action couldn't be deleted. Check the connection and try again." }
        }
    }
}
