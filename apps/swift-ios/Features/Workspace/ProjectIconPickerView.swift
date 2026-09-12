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

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let errorMessage { SettingsErrorBanner(message: errorMessage) }
                    HStack(spacing: 14) {
                        if selected == nil, !resetsFile, project.faviconPath != nil {
                            ProjectFaviconBadge(environmentID: project.environmentID, workspaceRoot: project.path,
                                faviconPath: project.faviconPath, projectTitle: project.name, size: 32) {
                                Image(systemName: "folder")
                            }
                        } else {
                            NativeProjectIcon(icon: selected ?? ProjectIconDefaults.select(title: project.name, workspaceRoot: project.path), size: 32)
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            Text(project.name).font(T3Typography.supportingStrong)
                            Text(selected == nil ? (!resetsFile ? project.faviconPath ?? "Automatic" : "Automatic") : selected?.emoji ?? selected?.name ?? "Icon")
                                .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                        }
                        Spacer()
                        Button("Reset") { selected = nil; resetsFile = true }.frame(minHeight: 44)
                    }
                    SettingsSection(title: "Color") {
                        ProjectIconColorChoices(selected: $color) { value in
                            if selected?.kind == "lucide" { selected?.color = value }
                        }.padding(12)
                    }
                    SettingsSection(title: "Icons") {
                        TextField("Search icons", text: $query).textInputAutocapitalization(.never)
                            .autocorrectionDisabled().padding(12)
                        LazyVGrid(columns: columns, spacing: 8) {
                            ForEach(names, id: \.self) { name in
                                iconButton(ProjectIconOverride(kind: "lucide", name: name, color: color), label: name.replacingOccurrences(of: "-", with: " "))
                            }
                        }.padding(12)
                        if names.isEmpty { Text("No icons found.").foregroundStyle(T3Colors.textSecondary).padding(12) }
                    }
                    SettingsSection(title: "Emoji") {
                        HStack {
                            TextField("Enter an emoji", text: $emojiInput).onChange(of: emojiInput) {
                                if let emoji = ProjectIconEmoji.first(in: emojiInput) { selected = .init(kind: "emoji", emoji: emoji) }
                            }
                            if let emoji = ProjectIconEmoji.first(in: emojiInput) { Text(emoji) }
                        }.padding(12)
                        LazyVGrid(columns: columns, spacing: 8) {
                            ForEach(emojis, id: \.self) { emoji in iconButton(.init(kind: "emoji", emoji: emoji), label: emoji) }
                        }.padding(12)
                    }
                }.padding(18).disabled(pending)
            }
            .background(T3Colors.background)
            .navigationTitle("Project icon").navigationBarTitleDisplayMode(.inline).t3NavigationChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }.disabled(pending || (selected == project.projectIcon && !resetsFile))
                }
            }.interactiveDismissDisabled(pending)
        }
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
        defer { pending = false }
        do { try await manager.setProjectIcon(projectID: project.id, icon: selected); dismiss() }
        catch { errorMessage = error.localizedDescription }
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
                        .overlay { if selected == name { Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(.white) } }
                        .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel(name.capitalized)
                    .accessibilityAddTraits(selected == name ? .isSelected : [])
            }
        }
    }
}
