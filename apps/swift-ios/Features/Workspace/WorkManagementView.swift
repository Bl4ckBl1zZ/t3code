import SwiftUI

/// Management stays inside Work and uses the same environment connection as
/// chat. The root picks the environment, connection and assistant; each area
/// of Hermes is its own pushed page.
struct WorkManagementView: View {
    let model: FeatureRootModel
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var environmentID = ""
    @State private var connections: [HermesWorkConnection] = []
    @State private var connectionID = ""
    @State private var profile = "default"
    @State private var profiles: [HermesWorkProfile] = []
    @State private var failure: String?
    @State private var loadingConnections = false

    private var manager: (any FeatureWorkManaging)? { model.client as? any FeatureWorkManaging }
    private var scope: WorkScope {
        WorkScope(environmentID: environmentID, connectionID: connectionID, profile: profile)
    }

    var body: some View {
        Form {
            Section {
                Picker("Environment", selection: $environmentID) {
                    ForEach(model.snapshot.environments) { Text($0.name).tag($0.id) }
                }
                if !connections.isEmpty {
                    Picker("Connection", selection: $connectionID) {
                        ForEach(connections) { connection in
                            Text(connection.displayName + (connection.configured ? "" : " (Setup Required)"))
                                .tag(connection.id)
                        }
                    }
                    Picker("Assistant", selection: $profile) {
                        if profiles.isEmpty { Text("Default").tag("default") }
                        ForEach(profiles) { Text($0.name).tag($0.name) }
                    }
                }
            } footer: {
                Text("Scheduled tasks run through Hermes on the selected environment, even when T3 is closed. The hosting machine and Hermes background service must remain available.")
            }
            .t3GroupedRow()

            if let failure {
                Section {
                    WorkErrorRow(message: failure) {
                        Task { await loadConnections() }
                    }
                    .t3GroupedRow()
                }
            }

            if loadingConnections {
                Section {
                    ForEach(0..<4, id: \.self) { _ in WorkPlaceholderRow() }
                }
                .t3GroupedRow()
            } else if let manager, !connectionID.isEmpty {
                ForEach(WorkSection.groups) { group in
                    Section(group.title) {
                        ForEach(group.sections) { section in
                            NavigationLink {
                                WorkSectionView(section: section, manager: manager, scope: scope, closeWork: dismiss)
                            } label: {
                                Label {
                                    Text(section.title)
                                } icon: {
                                    T3SettingsTile(section.symbol, tint: section.tint)
                                }
                            }
                        }
                    }
                    .t3GroupedRow()
                }
                Section {
                    NavigationLink {
                        WorkGroupsView(manager: manager, environmentID: environmentID, connectionID: connectionID, profile: profile, profiles: profiles)
                    } label: {
                        Label {
                            Text("Assistant Groups")
                        } icon: {
                            T3SettingsTile("person.3.fill", tint: .indigo)
                        }
                    }
                }
                .t3GroupedRow()
            } else if failure == nil, !environmentID.isEmpty {
                Section {
                    ContentUnavailableView(
                        WorkspaceSwitcher.hermesUnavailableTitle.capitalized,
                        systemImage: "tray",
                        description: Text("Set up Hermes on this environment to manage its assistants, schedules and outputs.")
                    )
                }
                .t3GroupedRow()
            }

            if let manager, !environmentID.isEmpty {
                Section {
                    NavigationLink {
                        SettingsHermesSetupView(manager: manager, environmentID: environmentID, instanceID: connectionID.isEmpty ? "hermes" : connectionID)
                    } label: {
                        Label {
                            Text("Set Up Hermes")
                        } icon: {
                            T3SettingsTile("wrench.and.screwdriver.fill", tint: .gray)
                        }
                    }
                }
                .t3GroupedRow()
            }
        }
        .t3GroupedListBackground()
        .navigationTitle("Work Settings")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .task {
            if environmentID.isEmpty { environmentID = model.snapshot.environments.first?.id ?? "" }
        }
        .task(id: environmentID) { await loadConnections() }
        .task(id: "\(environmentID)|\(connectionID)") { await loadProfiles() }
        .refreshable { await loadConnections() }
    }

    private func loadConnections() async {
        guard !environmentID.isEmpty else { return }
        connections = []; connectionID = ""; profiles = []; failure = nil
        guard let manager else { failure = "This client does not support Work management."; return }
        loadingConnections = true
        defer { if !Task.isCancelled { loadingConnections = false } }
        do {
            let loaded = try await manager.workConnections(environmentID: environmentID)
            guard !Task.isCancelled else { return }
            connections = loaded.connections
            connectionID = connections.first(where: \.configured)?.id ?? connections.first?.id ?? ""
        } catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }

    /// The assistant picker's choices; a saved assistant that no longer exists
    /// falls back to the default one.
    private func loadProfiles() async {
        guard let manager, !environmentID.isEmpty, !connectionID.isEmpty else { return }
        do {
            let result = try await manager.workQuery(environmentID: environmentID, input: .object([
                "providerInstanceId": .string(connectionID), "profile": .string(profile), "section": .string("profiles"),
            ]))
            guard !Task.isCancelled else { return }
            profiles = result.profiles
            if !profiles.isEmpty && !profiles.contains(where: { $0.name == profile }) {
                profile = profiles.first(where: \.isDefault)?.name ?? profiles[0].name
            }
        } catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }
}

/// Which environment, connection and assistant a Work page talks to.
private struct WorkScope: Hashable {
    let environmentID: String
    let connectionID: String
    let profile: String

    var input: [String: JSONValue] { ["providerInstanceId": .string(connectionID), "profile": .string(profile)] }
}

/// One area of Hermes management, reached from the Work Settings root.
private enum WorkSection: String, CaseIterable, Identifiable {
    case sessions, schedules, runs, artifacts
    case profiles, instructions, memory, skills
    case automation, status, channels, files

    var id: String { rawValue }

    struct Grouping: Identifiable {
        let title: String
        let sections: [WorkSection]
        var id: String { title }
    }

    static let groups = [
        Grouping(title: "Activity", sections: [.sessions, .schedules, .runs, .artifacts]),
        Grouping(title: "Assistant", sections: [.profiles, .instructions, .memory, .skills]),
        Grouping(title: "Environment", sections: [.automation, .status, .channels, .files]),
    ]

    var title: String {
        switch self {
        case .sessions: "Conversations"
        case .schedules: "Scheduled Tasks"
        case .runs: "Run History"
        case .artifacts: "Generated Outputs"
        case .profiles: "Assistants"
        case .instructions: "Instructions"
        case .memory: "Memory"
        case .skills: "Skills"
        case .automation: "Automation"
        case .status: "Background Service"
        case .channels: "Messaging"
        case .files: "Files"
        }
    }

    var symbol: String {
        switch self {
        case .sessions: "bubble.left.and.bubble.right.fill"
        case .schedules: "calendar.badge.clock"
        case .runs: "clock.arrow.circlepath"
        case .artifacts: "photo.on.rectangle"
        case .profiles: "person.2.fill"
        case .instructions: "text.alignleft"
        case .memory: "brain"
        case .skills: "wand.and.stars"
        case .automation: "gearshape.2.fill"
        case .status: "server.rack"
        case .channels: "message.fill"
        case .files: "folder.fill"
        }
    }

    var tint: T3SettingsTile.Tint {
        switch self {
        case .sessions: .blue
        case .schedules: .orange
        case .runs: .gray
        case .artifacts: .yellow
        case .profiles: .indigo
        case .instructions: .teal
        case .memory: .pink
        case .skills: .purple
        case .automation: .gray
        case .status: .green
        case .channels: .green
        case .files: .blue
        }
    }

    /// The query section this page reads.
    var querySection: String { rawValue }
}

private struct WorkSectionView: View {
    let section: WorkSection
    let manager: any FeatureWorkManaging
    let scope: WorkScope
    /// Dismisses Work Settings itself, for when a conversation opens.
    let closeWork: DismissAction

    @State private var result: HermesWorkQueryResult?
    @State private var failure: String?
    @State private var loading = false
    @State private var busy = false
    @State private var editor: WorkEditor?
    @State private var detail: WorkDetail?
    @State private var pendingRemoval: WorkRemoval?
    @State private var scheduleRuns: WorkRunList?
    @State private var artifacts: [HermesWorkArtifact] = []
    @State private var artifactsNextOffset: Double?
    @State private var isBrowsingFolder = false

    var body: some View {
        List {
            if let failure {
                Section {
                    WorkErrorRow(message: failure) { Task { await reload() } }
                }
                .t3GroupedRow()
            }
            if let result {
                if !result.diagnostics.isEmpty {
                    Section {
                        ForEach(result.diagnostics, id: \.self) { diagnostic in
                            Label(diagnostic, systemImage: "info.circle")
                                .font(.footnote)
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                    }
                    .t3GroupedRow()
                }
                content(result)
            } else if loading {
                Section {
                    ForEach(0..<4, id: \.self) { _ in WorkPlaceholderRow() }
                }
                .t3GroupedRow()
            }
        }
        .listStyle(.insetGrouped)
        .t3GroupedListBackground()
        .overlay { if let result { emptyState(result) } }
        .navigationTitle(section.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if busy {
                    ProgressView()
                        .accessibilityLabel("Updating")
                } else if let action = toolbarAction {
                    Button(action.title, systemImage: action.systemImage, action: action.perform)
                        .disabled(result == nil)
                }
            }
        }
        .t3NavigationChrome()
        .task { await reload() }
        .refreshable { await reload() }
        .disabled(busy)
        .sheet(item: $editor) { target in
            NavigationStack {
                WorkEditorSheet(editor: target) { fields in
                    var command = target.command
                    for (key, value) in fields { command[key] = target.booleanFields.contains(key) ? .bool(value == "true") : .string(value) }
                    if target.type == "channel.save" {
                        command = target.command
                        command["values"] = .object(fields.filter { !$0.value.isEmpty }.mapValues(JSONValue.string))
                    }
                    try await mutate(command)
                }
            }
        }
        .sheet(item: $scheduleRuns) { list in
            NavigationStack {
                List(list.runs) { run in
                    NavigationLink {
                        WorkRunOutputView(manager: manager, scope: scope, run: run)
                    } label: {
                        WorkRunRow(run: run)
                    }
                    .t3GroupedRow()
                }
                .t3GroupedListBackground()
                .overlay {
                    if list.runs.isEmpty {
                        ContentUnavailableView("No Runs Yet", systemImage: "clock", description: Text("Runs of this task show up here."))
                    }
                }
                .navigationTitle(list.title)
                .navigationBarTitleDisplayMode(.inline)
                .t3NavigationChrome()
                .t3SheetToolbar(.close)
            }
        }
        .sheet(item: $detail) { target in
            NavigationStack {
                ScrollView {
                    Text(target.content)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                }
                .background(T3Colors.background)
                .navigationTitle(target.title)
                .navigationBarTitleDisplayMode(.inline)
                .t3NavigationChrome()
                .t3SheetToolbar(.close)
            }
        }
        .confirmationDialog(
            pendingRemoval?.title ?? "Remove",
            isPresented: Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }),
            titleVisibility: .visible
        ) {
            if let removal = pendingRemoval {
                Button("Remove", role: .destructive) { perform(removal.command); pendingRemoval = nil }
            }
        } message: {
            Text("This changes the Hermes setup on the selected environment.")
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func content(_ data: HermesWorkQueryResult) -> some View {
        switch section {
        case .sessions:
            Section {
                ForEach(data.sessions ?? []) { session in
                    Button { openConversation(session.id) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(session.title)
                                    .font(.headline)
                                    .foregroundStyle(T3Colors.textPrimary)
                                Spacer(minLength: 8)
                                if session.active {
                                    Text("Running")
                                        .font(.caption)
                                        .foregroundStyle(T3Colors.statusRunning)
                                }
                            }
                            if !session.preview.isEmpty {
                                Text(session.preview)
                                    .font(.subheadline)
                                    .foregroundStyle(T3Colors.textSecondary)
                                    .lineLimit(2)
                            }
                        }
                    }
                }
            }
            .t3GroupedRow()
        case .schedules:
            if !data.schedules.isEmpty {
                Section {
                    ForEach(data.schedules) { job in
                        Button { editor = scheduleEditor(job) } label: { WorkScheduleRow(job: job) }
                            .contextMenu { scheduleActions(job) }
                            .swipeActions(edge: .trailing) {
                                Button { pendingRemoval = removal(for: job) } label: {
                                    Label("Remove", systemImage: "trash")
                                }
                                .tint(.red)
                                Button { togglePaused(job) } label: {
                                    Label(job.paused ? "Resume" : "Pause", systemImage: job.paused ? "play" : "pause")
                                }
                                .tint(.orange)
                            }
                            .swipeActions(edge: .leading) {
                                Button { runNow(job) } label: {
                                    Label("Run Now", systemImage: "play.circle")
                                }
                                .tint(.blue)
                            }
                    }
                } footer: {
                    Text("Schedules use the assistant’s configured timezone. Pausing a schedule affects future runs; it does not stop active work.")
                }
                .t3GroupedRow()
            }
        case .runs:
            Section {
                ForEach(data.runs) { run in
                    NavigationLink {
                        WorkRunOutputView(manager: manager, scope: scope, run: run)
                    } label: {
                        WorkRunRow(run: run)
                    }
                }
            }
            .t3GroupedRow()
        case .artifacts:
            Section {
                ForEach(artifacts) { artifact in
                    NavigationLink {
                        WorkArtifactPreview(
                            manager: manager,
                            environmentID: scope.environmentID,
                            connectionID: scope.connectionID,
                            profile: scope.profile,
                            artifact: artifact
                        ) { openConversation(artifact.sessionId) }
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(artifact.label)
                                    .foregroundStyle(T3Colors.textPrimary)
                                Text("\(artifact.sessionTitle) · \(Date(timeIntervalSince1970: artifact.timestamp / 1000).formatted(date: .abbreviated, time: .shortened))")
                                    .font(.caption)
                                    .foregroundStyle(T3Colors.textSecondary)
                            }
                        } icon: {
                            Image(systemName: artifact.kind == "image" ? "photo" : artifact.kind == "link" ? "link" : "doc")
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                    }
                }
                if let offset = artifactsNextOffset {
                    Button("Load More Outputs") { Task { await loadMoreArtifacts(offset: offset) } }
                }
            }
            .t3GroupedRow()
        case .profiles:
            Section {
                ForEach(data.profiles) { assistant in
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(assistant.name).font(.headline)
                                if assistant.isDefault {
                                    Text("Default")
                                        .font(.caption)
                                        .foregroundStyle(T3Colors.textSecondary)
                                }
                            }
                            if !assistant.description.isEmpty {
                                Text(assistant.description)
                                    .font(.subheadline)
                                    .foregroundStyle(T3Colors.textSecondary)
                            }
                            if !assistant.model.isEmpty {
                                Text(assistant.model)
                                    .font(.caption)
                                    .foregroundStyle(T3Colors.textTertiary)
                            }
                        }
                        Spacer(minLength: 8)
                        Menu {
                            assistantActions(assistant)
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .imageScale(.large)
                                .frame(minWidth: T3Metrics.minimumTapTarget, minHeight: T3Metrics.minimumTapTarget)
                        }
                        .accessibilityLabel("Actions for \(assistant.name)")
                    }
                    .contextMenu { assistantActions(assistant) }
                    .swipeActions(edge: .trailing) {
                        if !assistant.isDefault {
                            Button { pendingRemoval = removal(for: assistant) } label: {
                                Label("Remove", systemImage: "trash")
                            }
                            .tint(.red)
                        }
                    }
                }
            }
            .t3GroupedRow()
        case .instructions:
            if let content = data.content, !content.isEmpty {
                Section {
                    Text(content).textSelection(.enabled)
                }
                .t3GroupedRow()
            }
        case .memory:
            Section {
                ForEach(["MEMORY.md", "USER.md"], id: \.self) { file in
                    Button {
                        Task { await editContent(section: "memory", path: file, type: "memory.save", extra: ["file": .string(file)], title: file == "MEMORY.md" ? "Assistant Memory" : "About You") }
                    } label: {
                        Label(file == "MEMORY.md" ? "Assistant Memory" : "About You", systemImage: "doc.text")
                            .foregroundStyle(T3Colors.textPrimary)
                    }
                }
            }
            .t3GroupedRow()
            if let content = data.content, !content.isEmpty {
                Section("Preview") {
                    Text(content).font(.footnote).textSelection(.enabled)
                }
                .t3GroupedRow()
            }
        case .skills:
            Section {
                ForEach(data.skills) { skill in
                    Toggle(isOn: Binding(
                        get: { skill.enabled },
                        set: { perform(["type": .string("skill.toggle"), "name": .string(skill.name), "enabled": .bool($0)]) }
                    )) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(skill.name)
                            if !skill.description.isEmpty {
                                Text(skill.description)
                                    .font(.caption)
                                    .foregroundStyle(T3Colors.textSecondary)
                            }
                        }
                    }
                    .contextMenu {
                        Button("Edit Skill", systemImage: "pencil") { editSkill(skill) }
                    }
                    .swipeActions(edge: .trailing) {
                        Button { editSkill(skill) } label: { Label("Edit", systemImage: "pencil") }
                            .tint(.blue)
                    }
                }
            } footer: {
                if !data.skills.isEmpty {
                    Text("Swipe or touch and hold a skill to edit its instructions.")
                }
            }
            .t3GroupedRow()
        case .automation:
            if let automation = data.automation {
                Section {
                    LabeledContent("Timezone", value: automation.timezone.isEmpty ? "Environment Default" : automation.timezone)
                    LabeledContent("Assistant Scheduling", value: automation.allowAgentScheduling ? "Allowed" : "Off")
                } footer: {
                    Text("When allowed, scheduled assistants can create, edit, and remove tasks in the same schedule list you manage here. The timezone applies to this assistant’s schedules.")
                }
                .t3GroupedRow()
            }
        case .status:
            Section {
                LabeledContent("Status", value: data.gatewayRunning.map { $0 ? "Running" : "Stopped" } ?? "Unavailable")
                if let state = data.gatewayState {
                    LabeledContent("State", value: state)
                }
            }
            .t3GroupedRow()
            if let running = data.gatewayRunning {
                Section {
                    Button(running ? "Stop Background Service" : "Start Background Service") {
                        perform(["type": .string(running ? "gateway.stop" : "gateway.start")])
                    }
                } footer: {
                    Text("The background service runs scheduled tasks and messaging while T3 is closed.")
                }
                .t3GroupedRow()
            }
        case .channels:
            ForEach(data.channels) { channel in
                Section {
                    Toggle("Enabled", isOn: Binding(
                        get: { channel.enabled },
                        set: { perform(["type": .string("channel.save"), "id": .string(channel.id), "enabled": .bool($0), "values": .object([:])]) }
                    ))
                    Button(channel.configured ? "Configure…" : "Set Up…") {
                        editor = WorkEditor(
                            title: channel.name,
                            type: "channel.save",
                            extra: ["id": .string(channel.id), "enabled": .bool(channel.enabled)],
                            fields: channel.fields.map { WorkEditorField($0.name, $0.label + ($0.configured ? " (configured)" : ""), secret: $0.secret) }
                        )
                    }
                } header: {
                    Text(channel.name)
                } footer: {
                    Text(channel.configured ? channel.description : "Setup required. \(channel.description)")
                }
                .t3GroupedRow()
            }
        case .files:
            Section {
                if isBrowsingFolder {
                    Button("All Files", systemImage: "arrow.uturn.backward") { Task { await reload() } }
                }
                ForEach(data.files) { file in
                    Button { Task { await openFile(file) } } label: {
                        HStack {
                            Label(file.name, systemImage: file.directory ? "folder" : "doc")
                                .foregroundStyle(T3Colors.textPrimary)
                            Spacer(minLength: 8)
                            if file.directory {
                                Image(systemName: "chevron.right")
                                    .imageScale(.small)
                                    .foregroundStyle(T3Colors.textTertiary)
                            }
                        }
                    }
                }
            }
            .t3GroupedRow()
        }
    }

    /// The page's empty state: what is missing and, where there is one, the
    /// action that adds it.
    @ViewBuilder
    private func emptyState(_ data: HermesWorkQueryResult) -> some View {
        switch section {
        case .sessions where (data.sessions ?? []).isEmpty:
            emptyView("No Conversations", systemImage: section.symbol, description: "Conversations with this assistant show up here.")
        case .schedules where data.schedules.isEmpty:
            emptyView("No Scheduled Tasks", systemImage: section.symbol, description: "Scheduled tasks run on their own, even when T3 is closed.")
        case .runs where data.runs.isEmpty:
            emptyView("No Runs Yet", systemImage: section.symbol, description: "Runs of scheduled tasks show up here.")
        case .artifacts where artifacts.isEmpty:
            emptyView("No Generated Outputs", systemImage: section.symbol, description: "Files, images and links your assistants produce show up here.")
        case .profiles where data.profiles.isEmpty:
            emptyView("No Assistants", systemImage: section.symbol, description: "Assistants each have their own model, instructions and memory.")
        case .instructions where (data.content ?? "").isEmpty:
            emptyView("No Instructions", systemImage: section.symbol, description: "Instructions tell this assistant how to work.")
        case .skills where data.skills.isEmpty:
            emptyView("No Skills", systemImage: section.symbol, description: "Skills teach this assistant reusable procedures.")
        case .channels where data.channels.isEmpty:
            emptyView("No Messaging Channels", systemImage: section.symbol, description: "This Hermes version reports no messaging channels.")
        case .files where data.files.isEmpty:
            emptyView("No Files", systemImage: section.symbol, description: "Hermes reported no files here.")
        default:
            EmptyView()
        }
    }

    private func emptyView(_ title: String, systemImage: String, description: String) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(description)
        } actions: {
            if let action = toolbarAction {
                Button(action.title, action: action.perform)
                    .t3ProminentButtonStyle()
            }
        }
    }

    private struct ToolbarAction {
        let title: String
        let systemImage: String
        let perform: () -> Void
    }

    /// The page's one add or edit action, in the toolbar and in its empty state.
    private var toolbarAction: ToolbarAction? {
        switch section {
        case .sessions:
            ToolbarAction(title: "New Conversation", systemImage: "plus") { openConversation() }
        case .schedules:
            ToolbarAction(title: "New Scheduled Task", systemImage: "plus") { editor = scheduleEditor(nil) }
        case .profiles:
            ToolbarAction(title: "New Assistant", systemImage: "plus") {
                editor = WorkEditor(title: "New Assistant", type: "profile.create", fields: [.init("name", "Name"), .init("description", "Description"), .init("model", "Model"), .init("provider", "Model provider")])
            }
        case .skills:
            ToolbarAction(title: "New Skill", systemImage: "plus") {
                editor = WorkEditor(title: "New Skill", type: "skill.create", fields: [.init("name", "Name"), .init("content", "Instructions", multiline: true)])
            }
        case .instructions:
            ToolbarAction(title: "Edit Instructions", systemImage: "square.and.pencil") {
                editor = WorkEditor(title: "Instructions", type: "instructions.save", fields: [.init("content", "Instructions", result?.content ?? "", multiline: true)])
            }
        case .automation:
            result?.automation.map { automation in
                ToolbarAction(title: "Edit Automation", systemImage: "square.and.pencil") {
                    editor = WorkEditor(title: "Automation Settings", type: "automation.save", fields: [.init("timezone", "Timezone (blank uses environment default)", automation.timezone), .init("allowAgentScheduling", "Allow scheduled assistants to manage schedules", automation.allowAgentScheduling ? "true" : "false")], booleanFields: ["allowAgentScheduling"])
                }
            }
        case .runs, .artifacts, .memory, .status, .channels, .files:
            nil
        }
    }

    @ViewBuilder
    private func scheduleActions(_ job: HermesWorkSchedule) -> some View {
        Button("Edit", systemImage: "pencil") { editor = scheduleEditor(job) }
        Button(job.paused ? "Resume" : "Pause", systemImage: job.paused ? "play" : "pause") { togglePaused(job) }
        Button("Run Now", systemImage: "play.circle") { runNow(job) }
        Button("Run History", systemImage: "clock.arrow.circlepath") { Task { await showRuns(job) } }
        Divider()
        Button("Remove", systemImage: "trash", role: .destructive) { pendingRemoval = removal(for: job) }
    }

    @ViewBuilder
    private func assistantActions(_ assistant: HermesWorkProfile) -> some View {
        Button("Rename", systemImage: "pencil") {
            editor = WorkEditor(title: "Rename Assistant", type: "profile.rename", extra: ["name": .string(assistant.name)], fields: [.init("newName", "Name", assistant.name)])
        }
        Button("Edit Description", systemImage: "text.alignleft") {
            editor = WorkEditor(title: "Assistant Description", type: "profile.describe", extra: ["name": .string(assistant.name)], fields: [.init("description", "Description", assistant.description, multiline: true)])
        }
        Button("Change Model", systemImage: "cpu") {
            editor = WorkEditor(title: "Assistant Model", type: "profile.model", extra: ["name": .string(assistant.name)], fields: [.init("model", "Model", assistant.model), .init("provider", "Provider")])
        }
        if !assistant.isDefault {
            Divider()
            Button("Remove", systemImage: "trash", role: .destructive) { pendingRemoval = removal(for: assistant) }
        }
    }

    private func removal(for job: HermesWorkSchedule) -> WorkRemoval {
        WorkRemoval(title: "Remove “\(job.name)”?", command: ["type": .string("schedule.remove"), "id": .string(job.id)])
    }

    private func removal(for assistant: HermesWorkProfile) -> WorkRemoval {
        WorkRemoval(title: "Remove “\(assistant.name)”?", command: ["type": .string("profile.remove"), "name": .string(assistant.name)])
    }

    private func togglePaused(_ job: HermesWorkSchedule) {
        perform(["type": .string(job.paused ? "schedule.resume" : "schedule.pause"), "id": .string(job.id)])
    }

    private func runNow(_ job: HermesWorkSchedule) {
        perform(["type": .string("schedule.run"), "id": .string(job.id)])
    }

    private func editSkill(_ skill: HermesWorkSkill) {
        Task { await editContent(section: "skill", id: skill.name, type: "skill.save", extra: ["name": .string(skill.name)], title: skill.name) }
    }

    // MARK: - Loading and commands

    private func query(_ section: String, id: String? = nil, path: String? = nil, offset: Double? = nil) async throws -> HermesWorkQueryResult {
        var input = scope.input; input["section"] = .string(section)
        if let id { input["id"] = .string(id) }; if let path { input["path"] = .string(path) }; if let offset { input["offset"] = .number(offset) }
        return try await manager.workQuery(environmentID: scope.environmentID, input: .object(input))
    }

    private func reload() async {
        loading = true; failure = nil
        defer { if !Task.isCancelled { loading = false } }
        do {
            let loaded = try await query(section.querySection)
            guard !Task.isCancelled else { return }
            result = loaded
            isBrowsingFolder = false
            if section == .artifacts {
                artifacts = loaded.artifacts ?? []
                artifactsNextOffset = loaded.artifactsNextOffset
            }
        } catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }

    private func loadMoreArtifacts(offset: Double) async {
        do {
            let page = try await query("artifacts", offset: offset)
            artifacts += page.artifacts ?? []
            artifactsNextOffset = page.artifactsNextOffset
        } catch { failure = error.localizedDescription }
    }

    private func mutate(_ command: [String: JSONValue]) async throws {
        var input = scope.input; input["command"] = .object(command)
        _ = try await manager.workMutate(environmentID: scope.environmentID, input: .object(input))
        await reload()
    }

    private func perform(_ command: [String: JSONValue]) {
        busy = true
        Task {
            defer { busy = false }
            do {
                try await mutate(command)
            } catch {
                PlatformHapticEngine.shared.play(.error)
                failure = error.localizedDescription
            }
        }
    }

    private func openConversation(_ sessionID: String? = nil) {
        busy = true
        Task {
            defer { busy = false }
            do {
                var command: [String: JSONValue] = ["type": .string("conversation.open")]
                if let sessionID { command["sessionId"] = .string(sessionID) }
                var input = scope.input; input["command"] = .object(command)
                let response = try await manager.workMutate(environmentID: scope.environmentID, input: .object(input))
                guard let threadID = response.threadId else { throw FeatureCapabilityUnavailable("Opening this conversation") }
                closeWork()
                NotificationCenter.default.post(name: .platformRouteReceived, object: nil, userInfo: ["route": PlatformRoute.thread(environmentID: scope.environmentID, threadID: threadID)])
            } catch { failure = error.localizedDescription }
        }
    }

    private func scheduleEditor(_ job: HermesWorkSchedule?) -> WorkEditor {
        WorkEditor(title: job == nil ? "New Scheduled Task" : "Edit Scheduled Task", type: job == nil ? "schedule.create" : "schedule.update", extra: job.map { ["id": .string($0.id)] } ?? [:], fields: [
            .init("name", "Name", job?.name ?? ""), .init("prompt", "Instructions", job?.prompt ?? "", multiline: true),
            .init("schedule", "Schedule (for example, every 1h)", job?.schedule ?? "every 1h"),
            .init("deliver", "Delivery destination", job?.deliver ?? "local"), .init("model", "Model", job?.model ?? ""),
            .init("continuity", "Carry previous results into the next run", job?.continuity == true ? "true" : "false")
        ], booleanFields: ["continuity"])
    }

    private func editContent(section: String, id: String? = nil, path: String? = nil, type: String, extra: [String: JSONValue], title: String) async {
        do {
            let data = try await query(section, id: id, path: path)
            if type == "memory.save", !data.diagnostics.isEmpty { failure = data.diagnostics.joined(separator: "\n"); return }
            editor = WorkEditor(title: title, type: type, extra: type == "memory.save" ? extra.merging(["expectedContent": .string(data.content ?? "")]) { _, new in new } : extra, fields: [.init("content", title, data.content ?? "", multiline: true)])
        } catch { failure = error.localizedDescription }
    }

    private func showRuns(_ job: HermesWorkSchedule) async {
        do {
            let data = try await query("runs", id: job.id)
            scheduleRuns = WorkRunList(title: job.name, runs: data.runs)
        } catch { failure = error.localizedDescription }
    }

    private func openFile(_ file: HermesWorkFile) async {
        do {
            let data = try await query(file.directory ? "files" : "file", path: file.path)
            if file.directory {
                result = data
                isBrowsingFolder = true
            } else {
                detail = WorkDetail(title: file.name, content: ([data.content ?? "No preview available."] + data.diagnostics).joined(separator: "\n\n"))
            }
        } catch { failure = error.localizedDescription }
    }
}

// MARK: - Rows

private struct WorkScheduleRow: View {
    let job: HermesWorkSchedule

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(job.name)
                    .font(.headline)
                    .foregroundStyle(T3Colors.textPrimary)
                Spacer(minLength: 8)
                Text(job.statusLabel)
                    .font(.caption)
                    .foregroundStyle(statusColor)
            }
            Text(job.prompt)
                .font(.subheadline)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(2)
            Text([job.scheduleDisplay ?? job.schedule, job.nextRunAt.map { "Next \($0)" }].compactMap { $0 }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(T3Colors.textTertiary)
            if let status = job.lastStatus {
                Text("Last result: \(status)")
                    .font(.caption)
                    .foregroundStyle(T3Colors.textTertiary)
            }
            if let error = job.lastDeliveryError {
                Text("Delivery: \(error)")
                    .font(.caption)
                    .foregroundStyle(T3Colors.danger)
            }
            if let error = job.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(T3Colors.danger)
            }
        }
        .padding(.vertical, 2)
    }

    private var statusColor: Color {
        switch job.statusLabel {
        case "Failed": T3Colors.danger
        case "Paused": T3Colors.warning
        case "Enabled": T3Colors.success
        default: T3Colors.textSecondary
        }
    }
}

private struct WorkRunRow: View {
    let run: HermesWorkRun

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if run.readAt == nil {
                    Circle()
                        .fill(T3Colors.accent)
                        .frame(width: 7, height: 7)
                        .accessibilityLabel("New")
                }
                Text(run.title)
                    .foregroundStyle(T3Colors.textPrimary)
            }
            Text([status, run.startedAt.map { Date(timeIntervalSince1970: $0).formatted(date: .abbreviated, time: .shortened) }].compactMap { $0 }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var status: String {
        run.status ?? (run.active ? "Running" : (run.endedAt == nil ? "Outcome unknown" : "Ended"))
    }
}

/// A failure at the top of a Work page, with the retry that clears it.
private struct WorkErrorRow: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(T3Colors.danger)
                .accessibilityHidden(true)
            Text(message)
                .foregroundStyle(T3Colors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Retry", action: retry)
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .frame(minHeight: T3Metrics.minimumTapTarget)
    }
}

/// A static stand-in row while a Work page loads.
private struct WorkPlaceholderRow: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Scheduled task name")
            Text("Every day at 9:00")
                .font(.caption)
        }
        .redacted(reason: .placeholder)
        .accessibilityHidden(true)
    }
}

private struct WorkDetail: Identifiable { let id = UUID(); let title: String; let content: String }
private struct WorkRunList: Identifiable { let id = UUID(); let title: String; let runs: [HermesWorkRun] }
private struct WorkRemoval { let title: String; let command: [String: JSONValue] }
private struct WorkEditorField: Identifiable {
    let id: String; let label: String; let value: String; let multiline: Bool; let secret: Bool
    init(_ id: String, _ label: String, _ value: String = "", multiline: Bool = false, secret: Bool = false) { self.id = id; self.label = label; self.value = value; self.multiline = multiline; self.secret = secret }
}
private struct WorkEditor: Identifiable {
    let id = UUID(); let title: String; let type: String; let fields: [WorkEditorField]; let extra: [String: JSONValue]; let booleanFields: Set<String>
    var command: [String: JSONValue] { extra.merging(["type": .string(type)]) { _, new in new } }
    init(title: String, type: String, extra: [String: JSONValue] = [:], fields: [WorkEditorField], booleanFields: Set<String> = []) { self.title = title; self.type = type; self.extra = extra; self.fields = fields; self.booleanFields = booleanFields }
}

/// Short fields share one section, each labelled above its value; long text
/// gets a section of its own.
private struct WorkEditorSheet: View {
    let editor: WorkEditor
    let save: ([String: String]) async throws -> Void
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var values: [String: String] = [:]
    @State private var saving = false
    @State private var failure: String?

    private var shortFields: [WorkEditorField] { editor.fields.filter { !$0.multiline } }
    private var longFields: [WorkEditorField] { editor.fields.filter(\.multiline) }

    var body: some View {
        Form {
            if !shortFields.isEmpty {
                Section {
                    ForEach(shortFields) { field in
                        let binding = binding(for: field)
                        if editor.booleanFields.contains(field.id) {
                            Toggle(field.label, isOn: Binding(get: { binding.wrappedValue == "true" }, set: { binding.wrappedValue = $0 ? "true" : "false" }))
                        } else {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(field.label)
                                    .font(.caption)
                                    .foregroundStyle(T3Colors.textSecondary)
                                if field.secret {
                                    SecureField(field.label, text: binding)
                                } else {
                                    TextField(field.label, text: binding)
                                        .textInputAutocapitalization(.never)
                                }
                            }
                        }
                    }
                }
                .t3GroupedRow()
            }
            ForEach(longFields) { field in
                Section(field.label) {
                    TextEditor(text: binding(for: field))
                        .frame(minHeight: 160)
                }
                .t3GroupedRow()
            }
        }
        .t3GroupedListBackground()
        .safeAreaInset(edge: .top) {
            if let failure {
                Label(failure, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(T3Colors.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
            }
        }
        .navigationTitle(editor.title)
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .disabled(saving)
        .t3SheetToolbar(
            .cancel,
            confirm: T3SheetConfirmation(title: "Save", isBusy: saving, action: commit),
            hasChanges: !values.isEmpty || saving
        )
    }

    private func binding(for field: WorkEditorField) -> Binding<String> {
        Binding(get: { values[field.id] ?? field.value }, set: { values[field.id] = $0 })
    }

    private func commit() {
        saving = true
        failure = nil
        Task {
            defer { saving = false }
            do {
                try await save(Dictionary(uniqueKeysWithValues: editor.fields.map { ($0.id, values[$0.id] ?? $0.value) }))
                PlatformHapticEngine.shared.play(.success)
                dismiss()
            } catch {
                PlatformHapticEngine.shared.play(.error)
                failure = error.localizedDescription
            }
        }
    }
}

private struct WorkRunOutputView: View {
    let manager: any FeatureWorkManaging
    let scope: WorkScope
    let run: HermesWorkRun
    @State private var output: String?
    @State private var failure: String?

    var body: some View {
        Group {
            if let failure {
                ContentUnavailableView {
                    Label("Couldn't Load Result", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                } actions: {
                    Button("Retry") { Task { await load() } }
                        .t3SecondaryButtonStyle()
                }
            } else if let output {
                ScrollView {
                    Text(output)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                }
            } else {
                ProgressView("Loading Result…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(T3Colors.background)
        .navigationTitle(run.title)
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .task { await load() }
    }

    private func load() async {
        failure = nil
        do {
            let data = try await manager.workQuery(environmentID: scope.environmentID, input: .object(scope.input.merging(["section": .string("run"), "id": .string(run.id)]) { _, new in new }))
            output = ([data.content ?? run.content ?? "No output reported."] + data.diagnostics).joined(separator: "\n\n")
        } catch { failure = error.localizedDescription }
    }
}
