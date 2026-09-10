import SwiftUI

struct SettingsProjectActionsSection: View {
    let title: String
    let scripts: [ProjectScript]
    let enabled: Bool
    let inherited: Bool
    let canReset: Bool
    var resetTitle = "Use machine defaults"
    let onSave: ([ProjectScript]?) async -> Bool
    @State private var editor: ActionEditorRequest?

    var body: some View {
        ThreadDetailsSection(title: title) {
            if scripts.isEmpty { Text("No actions configured.").foregroundStyle(T3Colors.textSecondary).padding(14) }
            ForEach(scripts) { script in
                Button { editor = ActionEditorRequest(script: script) } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(script.name).font(T3Typography.supportingStrong)
                            Text(script.command).font(.system(.caption, design: .monospaced)).foregroundStyle(T3Colors.textSecondary).lineLimit(2)
                            if script.runOnWorktreeCreate || script.runOnWorktreeDelete == true {
                                Text([script.runOnWorktreeCreate ? "Setup" : nil, script.runOnWorktreeDelete == true ? "Teardown" : nil].compactMap { $0 }.joined(separator: " · "))
                                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textTertiary)
                            }
                        }
                        Spacer()
                        Image(systemName: "pencil").foregroundStyle(T3Colors.textSecondary)
                    }.contentShape(Rectangle()).padding(14)
                }.buttonStyle(.plain)
            }
            HStack {
                Button("Add action", systemImage: "plus") { editor = ActionEditorRequest(script: nil) }
                Spacer()
                if canReset { Button(resetTitle) { Task { await onSave(nil) } } }
            }.padding(14)
            if inherited { Text("Inherits this machine’s actions. Editing creates a project override.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(14) }
        }
        .disabled(!enabled)
        .sheet(item: $editor) { request in
            SettingsProjectActionEditor(script: request.script, onSave: { action in
                let next = scripts.filter { $0.id != action.id }.map { script in
                    ProjectScript(id: script.id, name: script.name, command: script.command, icon: script.icon,
                        runOnWorktreeCreate: action.runOnWorktreeCreate ? false : script.runOnWorktreeCreate,
                        runOnWorktreeDelete: action.runOnWorktreeDelete == true ? false : script.runOnWorktreeDelete,
                        previewUrl: script.previewUrl, autoOpenPreview: script.autoOpenPreview, singleRun: script.singleRun)
                }
                // Keep an edited action in place so shortcuts and muscle memory remain stable.
                var ordered = next
                if let index = scripts.firstIndex(where: { $0.id == action.id }) { ordered.insert(action, at: min(index, ordered.count)) }
                else { ordered.append(action) }
                return await onSave(ordered)
            }, onDelete: request.script.map { script in { await onSave(scripts.filter { $0.id != script.id }) } })
        }
    }
}

private struct ActionEditorRequest: Identifiable {
    let id = UUID()
    let script: ProjectScript?
}

private struct SettingsProjectActionEditor: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let script: ProjectScript?
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
    @State private var errorMessage: String?

    init(script: ProjectScript?, onSave: @escaping (ProjectScript) async -> Bool, onDelete: (() async -> Bool)?) {
        self.script = script; self.onSave = onSave; self.onDelete = onDelete
        _name = State(initialValue: script?.name ?? "")
        _command = State(initialValue: script?.command ?? "")
        _icon = State(initialValue: script?.icon ?? "play")
        _setup = State(initialValue: script?.runOnWorktreeCreate ?? false)
        _teardown = State(initialValue: script?.runOnWorktreeDelete ?? false)
        _previewURL = State(initialValue: script?.previewUrl ?? "")
        _autoOpenPreview = State(initialValue: script?.autoOpenPreview ?? false)
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    if let errorMessage { SettingsErrorBanner(message: errorMessage) }
                    ThreadDetailsSection(title: "Action") {
                        TextField("Name", text: $name).padding(14)
                        TextEditor(text: $command).font(.system(.body, design: .monospaced)).frame(minHeight: 100).padding(10).accessibilityLabel("Command")
                        Picker("Icon", selection: $icon) {
                            ForEach(["play", "test", "lint", "configure", "build", "debug"], id: \.self) { Text($0.capitalized).tag($0) }
                        }.padding(14)
                    }
                    ThreadDetailsSection(title: "Workspace lifecycle") {
                        Toggle("Run when a worktree is created", isOn: $setup).padding(14)
                        Toggle("Run before a worktree is removed", isOn: $teardown).padding(14)
                        Text("Commands run in the checkout or worktree. Only one setup and one teardown action can be selected.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(14)
                    }
                    ThreadDetailsSection(title: "Preview") {
                        TextField("Preview URL (optional)", text: $previewURL).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL).padding(14)
                        Toggle("Open preview automatically on desktop", isOn: $autoOpenPreview).padding(14).disabled(previewURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    if let onDelete {
                        Button("Delete action", role: .destructive) { Task { saving = true; let success = await onDelete(); saving = false; if success { dismiss() } else { errorMessage = "Could not delete the action. Check the connection and try again." } } }
                    }
                }.padding(18).disabled(saving)
            }
            .background(T3Colors.background)
            .navigationTitle(script == nil ? "Add action" : "Edit action")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(saving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            saving = true
                            let url = previewURL.trimmingCharacters(in: .whitespacesAndNewlines)
                            let success = await onSave(ProjectScript(id: script?.id ?? UUID().uuidString.lowercased(), name: name.trimmingCharacters(in: .whitespacesAndNewlines), command: command.trimmingCharacters(in: .whitespacesAndNewlines), icon: icon, runOnWorktreeCreate: setup, runOnWorktreeDelete: teardown, previewUrl: url.isEmpty ? nil : url, autoOpenPreview: !url.isEmpty && autoOpenPreview, singleRun: script?.singleRun))
                            saving = false
                            if success { dismiss() } else { errorMessage = "Could not save the action. Check the connection and try again." }
                        }
                    }.disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
