import SwiftUI

@MainActor
protocol FeatureProjectIconManaging: AnyObject {
    func setProjectIcon(projectID: String, icon: ProjectIconOverride?) async throws
}

struct ProjectIconPickerView: View {
    let project: FeatureProject
    let manager: any FeatureProjectIconManaging
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var selected: ProjectIconOverride?
    @State private var query = ""
    @State private var emojiInput = ""
    @State private var color = "blue"
    @State private var pending = false
    @State private var resetsFile = false
    @State private var errorMessage: String?

    init(project: FeatureProject, manager: any FeatureProjectIconManaging) {
        self.project = project
        self.manager = manager
        _selected = State(initialValue: project.projectIcon)
        _color = State(initialValue: project.projectIcon?.color ?? "blue")
    }

    private let columns = [GridItem(.adaptive(minimum: 44), spacing: 8)]
    private let emojis = ["💻", "🛠️", "🚀", "🤖", "✨", "⚡", "🌐", "📱", "🖥️", "⌨️", "⚙️", "🗄️", "☁️", "📦", "📚", "🧪", "🔒", "🎮", "🎵", "🎬", "🖼️", "🛍️", "🔥", "💡", "🧩", "📊", "🧠", "🦄", "🐙", "🌱"]
    private static let popular = ["folder-code", "code-2", "terminal", "globe-2", "server", "database", "bot", "sparkles", "smartphone", "monitor", "cloud-cog", "package", "book-open", "flask-conical", "shield-check", "rocket", "gamepad-2", "music", "image", "shopping-bag", "git-branch", "workflow", "wrench", "layers-3"]
    private var names: [String] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .replacingOccurrences(of: "\\s+", with: "-", options: .regularExpression)
        return term.isEmpty ? Self.popular : Array(NativeProjectIconCatalog.shared.names.filter { $0.contains(term) }.prefix(60))
    }

    private var hasChanges: Bool {
        selected != project.projectIcon || resetsFile
    }

    /// Already showing the automatic icon: nothing for Reset to undo.
    private var isAutomatic: Bool {
        selected == nil && (resetsFile || project.projectIcon == nil)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    preview
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                } footer: {
                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(T3Colors.danger)
                    }
                }
                Section("Color") {
                    ProjectIconColorChoices(selected: $color) { value in
                        if selected?.kind == "lucide" { selected?.color = value }
                    }
                    .t3GroupedRow()
                }
                Section("Icons") {
                    if names.isEmpty {
                        ContentUnavailableView.search(text: query)
                            .t3GroupedRow()
                    } else {
                        LazyVGrid(columns: columns, spacing: 8) {
                            ForEach(names, id: \.self) { name in
                                iconButton(ProjectIconOverride(kind: "lucide", name: name, color: color), label: name.replacingOccurrences(of: "-", with: " "))
                            }
                        }
                        .padding(.vertical, 4)
                        .t3GroupedRow()
                    }
                }
                Section("Emoji") {
                    HStack {
                        TextField("Any Emoji", text: $emojiInput)
                            .onChange(of: emojiInput) {
                                if let emoji = ProjectIconEmoji.first(in: emojiInput) { selected = .init(kind: "emoji", emoji: emoji) }
                            }
                        if let emoji = ProjectIconEmoji.first(in: emojiInput) { Text(emoji) }
                    }
                    .t3GroupedRow()
                    LazyVGrid(columns: columns, spacing: 8) {
                        ForEach(emojis, id: \.self) { emoji in iconButton(.init(kind: "emoji", emoji: emoji), label: emoji) }
                    }
                    .padding(.vertical, 4)
                    .t3GroupedRow()
                }
                Section {
                    Button("Use Automatic Icon") {
                        selected = nil
                        resetsFile = true
                    }
                    .disabled(isAutomatic)
                    .t3GroupedRow()
                } footer: {
                    Text("Removes the chosen icon, so the project shows its own favicon or a default glyph.")
                }
            }
            .t3GroupedListBackground()
            .disabled(pending)
            .searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Search Icons"
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .navigationTitle("Project Icon")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: "Save",
                    isEnabled: hasChanges,
                    isBusy: pending,
                    action: { Task { await save() } }
                ),
                hasChanges: hasChanges || pending
            )
        }
    }

    private var preview: some View {
        VStack(spacing: 8) {
            Group {
                if selected == nil, !resetsFile, project.faviconPath != nil {
                    ProjectFaviconBadge(environmentID: project.environmentID, workspaceRoot: project.path,
                        faviconPath: project.faviconPath, projectTitle: project.name, size: 64) {
                        Image(systemName: "folder")
                    }
                } else {
                    NativeProjectIcon(icon: selected ?? ProjectIconDefaults.select(title: project.name, workspaceRoot: project.path), size: 64)
                }
            }
            .accessibilityHidden(true)
            Text(project.name)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textPrimary)
            Text(selectionDescription)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(1)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    private var selectionDescription: String {
        guard let selected else {
            return !resetsFile && project.faviconPath != nil ? "Favicon" : "Automatic"
        }
        return selected.emoji ?? selected.name?.replacingOccurrences(of: "-", with: " ") ?? "Icon"
    }

    private func iconButton(_ icon: ProjectIconOverride, label: String) -> some View {
        let isSelected = selected == icon
        return Button { selected = icon } label: {
            NativeProjectIcon(icon: icon, size: 22).frame(maxWidth: .infinity, minHeight: 44)
                .background(isSelected ? T3Colors.textPrimary.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(isSelected ? T3Colors.textPrimary : .clear, lineWidth: 1))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel(label).accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func save() async {
        guard !pending else { return }
        pending = true
        errorMessage = nil
        defer { pending = false }
        do {
            try await manager.setProjectIcon(projectID: project.id, icon: selected)
            PlatformHapticEngine.shared.play(.success)
            dismiss()
        } catch {
            PlatformHapticEngine.shared.play(.error)
            errorMessage = error.localizedDescription
        }
    }
}

private struct ProjectIconColorChoices: View {
    @Binding var selected: String
    let onSelect: (String) -> Void
    @SwiftUI.Environment(\.colorScheme) private var colorScheme
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 44))]) {
            ForEach(NativeProjectIconPalette.names, id: \.self) { name in
                Button { selected = name; onSelect(name) } label: {
                    Circle().fill(NativeProjectIconPalette.color(name, dark: colorScheme == .dark))
                        .frame(width: 24, height: 24)
                        .overlay {
                            if selected == name {
                                Image(systemName: "checkmark")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(.white)
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel(name.capitalized)
                    .accessibilityAddTraits(selected == name ? .isSelected : [])
            }
        }
    }
}
