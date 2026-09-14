import SwiftUI

/// Management stays inside Work and uses the same environment connection as chat.
struct WorkManagementView: View {
    let model: FeatureRootModel
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var environmentID = ""
    @State private var connections: [HermesWorkConnection] = []
    @State private var connectionID = ""
    @State private var profile = "default"
    @State private var profiles: [HermesWorkProfile] = []
    @State private var section = "schedules"
    @State private var result: HermesWorkQueryResult?
    @State private var failure: String?
    @State private var loading = false
    @State private var busy = false
    @State private var editor: WorkEditor?
    @State private var detail: WorkDetail?
    @State private var pendingRemoval: WorkRemoval?
    @State private var runs: [HermesWorkRun]?

    private var manager: (any FeatureWorkManaging)? { model.client as? any FeatureWorkManaging }
    private var selection: String { "\(environmentID)|\(connectionID)|\(profile)|\(section)" }
    private let sections = [("sessions", "Conversations"), ("automation", "Automation settings"), ("status", "Background service"), ("schedules", "Scheduled tasks"), ("runs", "All runs"), ("profiles", "Assistants"), ("instructions", "Instructions"), ("memory", "Memory"), ("skills", "Skills"), ("channels", "Messaging"), ("artifacts", "Generated outputs"), ("files", "Files")]

    var body: some View {
        Form {
            Section {
                Picker("Environment", selection: $environmentID) {
                    ForEach(model.snapshot.environments) { Text($0.name).tag($0.id) }
                }
                Picker("Connection", selection: $connectionID) {
                    Text("Choose a connection").tag("")
                    ForEach(connections) { Text($0.displayName + ($0.configured ? "" : " — setup required")).tag($0.id) }
                }
                Picker("Assistant", selection: $profile) {
                    if profiles.isEmpty { Text("Default").tag("default") }
                    ForEach(profiles) { Text($0.name).tag($0.name) }
                }
                Picker("Show", selection: $section) {
                    ForEach(sections, id: \.0) { Text($0.1).tag($0.0) }
                }
            }
            if let failure { Section { Text(failure).foregroundStyle(.red); Button("Retry") { Task { await loadConnections(); await reload() } } } }
            if loading { ProgressView("Loading Work…") }
            if connections.isEmpty && !loading && failure == nil {
                Text("Connect Hermes in this environment’s provider settings to manage Work.")
            }
            if let manager, !environmentID.isEmpty {
                Section {
                    NavigationLink("Set up Hermes") {
                        SettingsHermesSetupView(manager: manager, environmentID: environmentID, instanceID: connectionID.isEmpty ? "hermes" : connectionID)
                    }
                }
            }
            if let manager, !connectionID.isEmpty {
                Section {
                    NavigationLink("Assistant groups") {
                        WorkGroupsView(manager: manager, environmentID: environmentID, connectionID: connectionID, profile: profile, profiles: profiles)
                    }
                }
            }
            if let result {
                ForEach(result.diagnostics, id: \.self) { Text($0).foregroundStyle(.secondary) }
                content(result)
            }
            Section {
                Text("Scheduled tasks run through Hermes on the selected environment, even when T3 is closed. The hosting machine and Hermes background service must remain available.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Work settings")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if environmentID.isEmpty { environmentID = model.snapshot.environments.first?.id ?? "" }
        }
        .task(id: environmentID) { await loadConnections() }
        .task(id: selection) { await reload() }
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
        .sheet(isPresented: Binding(get: { runs != nil }, set: { if !$0 { runs = nil } })) {
            NavigationStack {
                List(runs ?? []) { run in
                    NavigationLink {
                        WorkRunOutputView(manager: manager, environmentID: environmentID, connectionID: connectionID, profile: profile, run: run)
                    } label: {
                        VStack(alignment: .leading) {
                            HStack { Text(run.title); if run.readAt == nil { Text("New").font(.caption).foregroundStyle(.secondary) } }
                            Text(run.status ?? (run.active ? "Running" : (run.endedAt == nil ? "Outcome unknown" : "Ended"))).font(.caption)
                            if let delivery = run.deliveryStatus { Text("Delivery: \(delivery)").font(.caption) }
                            if let startedAt = run.startedAt { Text(Date(timeIntervalSince1970: startedAt).formatted()).font(.caption) }
                        }
                    }
                }
                .overlay { if runs?.isEmpty == true { ContentUnavailableView("No runs reported", systemImage: "clock") } }
                .navigationTitle("Run history")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { runs = nil } } }
            }
        }
        .sheet(item: $detail) { target in
            NavigationStack {
                ScrollView { Text(target.content).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding() }
                    .navigationTitle(target.title)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { detail = nil } } }
            }
        }
        .confirmationDialog(pendingRemoval?.title ?? "Remove", isPresented: Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } })) {
            if let removal = pendingRemoval {
                Button("Remove", role: .destructive) { perform(removal.command); pendingRemoval = nil }
            }
        } message: { Text("This changes the Hermes setup on the selected environment.") }
    }

    @ViewBuilder private func content(_ data: HermesWorkQueryResult) -> some View {
        switch section {
        case "automation":
            Section("Automation settings") {
                if let automation = data.automation {
                    Text(automation.timezone.isEmpty ? "Timezone: environment default" : "Timezone: \(automation.timezone)")
                    Text(automation.allowAgentScheduling ? "Scheduled assistants can manage schedules" : "Assistant-managed scheduling is disabled")
                    Text("When enabled, scheduled assistants can create, edit, and remove tasks in the same schedule list you manage here. The timezone applies to this assistant’s schedules.").font(.caption).foregroundStyle(.secondary)
                    Button("Edit automation settings") {
                        editor = WorkEditor(title: "Automation settings", type: "automation.save", fields: [.init("timezone", "Timezone (blank uses environment default)", automation.timezone), .init("allowAgentScheduling", "Allow scheduled assistants to manage schedules", automation.allowAgentScheduling ? "true" : "false")], booleanFields: ["allowAgentScheduling"])
                    }
                }
            }
        case "sessions":
            Section("Conversations") {
                Button("New conversation", systemImage: "plus") { openConversation() }
                ForEach(data.sessions ?? []) { session in
                    Button { openConversation(session.id) } label: {
                        VStack(alignment: .leading) {
                            Text(session.title).font(.headline)
                            Text(session.preview).lineLimit(2).font(.caption)
                            if session.active { Text("Running").font(.caption) }
                        }
                    }
                }
            }
        case "status":
            Section("Background service") {
                Text(data.gatewayRunning.map { $0 ? "Running" : "Stopped" } ?? "Status unavailable")
                if let state = data.gatewayState { Text(state).font(.caption) }
                if let running = data.gatewayRunning {
                    Button(running ? "Stop background service" : "Start background service") {
                        perform(["type": .string(running ? "gateway.stop" : "gateway.start")])
                    }
                }
            }
        case "runs":
            Section("Run history") {
                Button("Open run history") { runs = data.runs }
                Text("\(data.runs.count) runs reported").font(.caption)
            }
        case "schedules":
            Section("Scheduled tasks") {
                Text("Schedules use the assistant’s configured timezone. Pausing a schedule affects future runs; it does not stop active work.").font(.caption).foregroundStyle(.secondary)
                Button("New scheduled task", systemImage: "plus") { editor = scheduleEditor(nil) }
                if data.schedules.isEmpty { Text("No scheduled tasks").foregroundStyle(.secondary) }
                ForEach(data.schedules) { job in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(job.name).font(.headline)
                        Text(job.prompt).lineLimit(3)
                        Text("\(job.schedule) · \(job.paused ? "Paused" : "Enabled")").font(.caption)
                        if let next = job.nextRunAt { Text("Next: \(next)").font(.caption) }
                        if let status = job.lastStatus { Text("Last result: \(status)").font(.caption) }
                        if let error = job.lastDeliveryError { Text("Delivery: \(error)").foregroundStyle(.red).font(.caption) }
                        if let error = job.lastError { Text(error).foregroundStyle(.red).font(.caption) }
                        Menu("Manage") {
                            Button("Edit") { editor = scheduleEditor(job) }
                            Button(job.paused ? "Resume" : "Pause") { perform(["type": .string(job.paused ? "schedule.resume" : "schedule.pause"), "id": .string(job.id)]) }
                            Button("Run now") { perform(["type": .string("schedule.run"), "id": .string(job.id)]) }
                            Button("Run history") { Task { await showRuns(job) } }
                            Button("Remove", role: .destructive) { pendingRemoval = WorkRemoval(title: "Remove \(job.name)?", command: ["type": .string("schedule.remove"), "id": .string(job.id)]) }
                        }
                    }.padding(.vertical, 4)
                }
            }
        case "profiles":
            Section("Assistants") {
                Button("New assistant", systemImage: "plus") {
                    editor = WorkEditor(title: "New assistant", type: "profile.create", fields: [.init("name", "Name"), .init("description", "Description"), .init("model", "Model"), .init("provider", "Model provider")])
                }
                ForEach(data.profiles) { assistant in
                    VStack(alignment: .leading) {
                        Text(assistant.name).font(.headline)
                        Text(assistant.description)
                        Text(assistant.model).font(.caption).foregroundStyle(.secondary)
                        Menu("Manage") {
                            Button("Rename") { editor = WorkEditor(title: "Rename assistant", type: "profile.rename", extra: ["name": .string(assistant.name)], fields: [.init("newName", "Name", assistant.name)]) }
                            Button("Edit description") { editor = WorkEditor(title: "Assistant description", type: "profile.describe", extra: ["name": .string(assistant.name)], fields: [.init("description", "Description", assistant.description, multiline: true)]) }
                            Button("Change model") { editor = WorkEditor(title: "Assistant model", type: "profile.model", extra: ["name": .string(assistant.name)], fields: [.init("model", "Model", assistant.model), .init("provider", "Provider")]) }
                            if !assistant.isDefault { Button("Remove", role: .destructive) { pendingRemoval = WorkRemoval(title: "Remove \(assistant.name)?", command: ["type": .string("profile.remove"), "name": .string(assistant.name)]) } }
                        }
                    }
                }
            }
        case "instructions":
            Section("Instructions") {
                Text(data.content ?? "No instructions")
                Button("Edit instructions") { editor = WorkEditor(title: "Instructions", type: "instructions.save", fields: [.init("content", "Instructions", data.content ?? "", multiline: true)]) }
            }
        case "memory":
            Section("Memory") {
                ForEach(["MEMORY.md", "USER.md"], id: \.self) { file in
                    Button(file == "MEMORY.md" ? "Assistant memory" : "About you") { Task { await editContent(section: "memory", path: file, type: "memory.save", extra: ["file": .string(file)], title: file) } }
                }
                if let content = data.content { Text(content).font(.footnote) }
            }
        case "skills":
            Section("Skills") {
                Button("New skill", systemImage: "plus") { editor = WorkEditor(title: "New skill", type: "skill.create", fields: [.init("name", "Name"), .init("content", "Instructions", multiline: true)]) }
                ForEach(data.skills) { skill in
                    VStack(alignment: .leading) {
                        Text(skill.name).font(.headline)
                        Text(skill.description).font(.caption)
                        HStack {
                            Button(skill.enabled ? "Disable" : "Enable") { perform(["type": .string("skill.toggle"), "name": .string(skill.name), "enabled": .bool(!skill.enabled)]) }
                            Button("Edit") { Task { await editContent(section: "skill", id: skill.name, type: "skill.save", extra: ["name": .string(skill.name)], title: skill.name) } }
                        }.buttonStyle(.borderless)
                    }
                }
            }
        case "channels":
            Section("Messaging") {
                ForEach(data.channels) { channel in
                    VStack(alignment: .leading) {
                        Text(channel.name).font(.headline)
                        Text(channel.description).font(.caption)
                        Text(channel.configured ? "Configured" : "Setup required").font(.caption)
                        Button(channel.enabled ? "Disable" : "Enable") { perform(["type": .string("channel.save"), "id": .string(channel.id), "enabled": .bool(!channel.enabled), "values": .object([:])]) }
                        Button("Configure") { editor = WorkEditor(title: channel.name, type: "channel.save", extra: ["id": .string(channel.id), "enabled": .bool(channel.enabled)], fields: channel.fields.map { WorkEditorField($0.name, $0.label + ($0.configured ? " (configured)" : ""), secret: $0.secret) }) }
                    }.buttonStyle(.borderless)
                }
            }
        case "artifacts":
            Section("Generated outputs") {
                if (data.artifacts ?? []).isEmpty { Text("No generated outputs on this page").foregroundStyle(.secondary) }
                ForEach(data.artifacts ?? []) { artifact in
                    if let manager {
                        NavigationLink {
                            WorkArtifactPreview(manager: manager, environmentID: environmentID, connectionID: connectionID, profile: profile, artifact: artifact) { openConversation(artifact.sessionId) }
                        } label: {
                            VStack(alignment: .leading) {
                                Label(artifact.label, systemImage: artifact.kind == "image" ? "photo" : artifact.kind == "link" ? "link" : "doc")
                                Text(artifact.sessionTitle).font(.caption).foregroundStyle(.secondary)
                                Text(Date(timeIntervalSince1970: artifact.timestamp / 1000).formatted()).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if let offset = data.artifactsNextOffset {
                    Button("Next page") {
                        Task { do { result = try await query("artifacts", offset: offset) } catch { failure = error.localizedDescription } }
                    }
                }
            }
        case "files":
            Section("Files") {
                if data.files.isEmpty { Text("No files reported").foregroundStyle(.secondary) }
                ForEach(data.files) { file in
                    Button(file.name, systemImage: file.directory ? "folder" : "doc") { Task { await openFile(file) } }
                }
                Button("Back to files") { Task { await reload() } }
            }
        default: EmptyView()
        }
    }

    private func scope() -> [String: JSONValue] { ["providerInstanceId": .string(connectionID), "profile": .string(profile)] }
    private func query(_ section: String, id: String? = nil, path: String? = nil, offset: Double? = nil) async throws -> HermesWorkQueryResult {
        guard let manager else { throw FeatureCapabilityUnavailable("Work management") }
        var input = scope(); input["section"] = .string(section)
        if let id { input["id"] = .string(id) }; if let path { input["path"] = .string(path) }; if let offset { input["offset"] = .number(offset) }
        return try await manager.workQuery(environmentID: environmentID, input: .object(input))
    }
    private func loadConnections() async {
        guard !environmentID.isEmpty else { return }
        connections = []; connectionID = ""; profiles = []; result = nil; failure = nil
        guard let manager else { failure = "This client does not support Work management."; return }
        do {
            let loaded = try await manager.workConnections(environmentID: environmentID)
            guard !Task.isCancelled else { return }
            connections = loaded.connections
            connectionID = connections.first(where: \.configured)?.id ?? connections.first?.id ?? ""
        } catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }
    private func reload() async {
        result = nil
        guard !environmentID.isEmpty, !connectionID.isEmpty else { loading = false; return }
        loading = true; failure = nil
        defer { if !Task.isCancelled { loading = false } }
        do {
            let assistants = try await query("profiles")
            guard !Task.isCancelled else { return }
            profiles = assistants.profiles
            if !profiles.isEmpty && !profiles.contains(where: { $0.name == profile }) { profile = profiles.first(where: \.isDefault)?.name ?? profiles[0].name; return }
            let loaded = section == "profiles" ? assistants : try await query(section)
            guard !Task.isCancelled else { return }
            result = loaded
        } catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }
    private func mutate(_ command: [String: JSONValue]) async throws {
        guard let manager else { throw FeatureCapabilityUnavailable("Work management") }
        var input = scope(); input["command"] = .object(command)
        _ = try await manager.workMutate(environmentID: environmentID, input: .object(input))
        await reload()
    }
    private func perform(_ command: [String: JSONValue]) {
        busy = true
        Task { defer { busy = false }; do { try await mutate(command) } catch { failure = error.localizedDescription } }
    }
    private func openConversation(_ sessionID: String? = nil) {
        busy = true
        Task {
            defer { busy = false }
            do {
                guard let manager else { throw FeatureCapabilityUnavailable("Work conversations") }
                var command: [String: JSONValue] = ["type": .string("conversation.open")]
                if let sessionID { command["sessionId"] = .string(sessionID) }
                var input = scope(); input["command"] = .object(command)
                let response = try await manager.workMutate(environmentID: environmentID, input: .object(input))
                guard let threadID = response.threadId else { throw FeatureCapabilityUnavailable("Opening this conversation") }
                dismiss()
                NotificationCenter.default.post(name: .platformRouteReceived, object: nil, userInfo: ["route": PlatformRoute.thread(environmentID: environmentID, threadID: threadID)])
            } catch { failure = error.localizedDescription }
        }
    }
    private func scheduleEditor(_ job: HermesWorkSchedule?) -> WorkEditor {
        WorkEditor(title: job == nil ? "New scheduled task" : "Edit scheduled task", type: job == nil ? "schedule.create" : "schedule.update", extra: job.map { ["id": .string($0.id)] } ?? [:], fields: [
            .init("name", "Name", job?.name ?? ""), .init("prompt", "Instructions", job?.prompt ?? "", multiline: true),
            .init("schedule", "Schedule (for example, every 1h)", job?.schedule ?? "every 1h"),
            .init("deliver", "Delivery destination", job?.deliver ?? "local"), .init("model", "Model", job?.model ?? ""),
            .init("continuity", "Carry previous results into the next run", job?.continuity == true ? "true" : "false")
        ], booleanFields: ["continuity"])
    }
    private func editContent(section: String, id: String? = nil, path: String? = nil, type: String, extra: [String: JSONValue], title: String) async {
        do { let data = try await query(section, id: id, path: path); if type == "memory.save", !data.diagnostics.isEmpty { failure = data.diagnostics.joined(separator: "\n"); return }; editor = WorkEditor(title: title, type: type, extra: type == "memory.save" ? extra.merging(["expectedContent": .string(data.content ?? "")]) { _, new in new } : extra, fields: [.init("content", title, data.content ?? "", multiline: true)]) }
        catch { failure = error.localizedDescription }
    }
    private func showRuns(_ job: HermesWorkSchedule) async {
        do {
            let data = try await query("runs", id: job.id)
            runs = data.runs
        } catch { failure = error.localizedDescription }
    }
    private func openFile(_ file: HermesWorkFile) async {
        do { let data = try await query(file.directory ? "files" : "file", path: file.path); if file.directory { result = data } else { detail = WorkDetail(title: file.name, content: ([data.content ?? "No preview available."] + data.diagnostics).joined(separator: "\n\n")) } }
        catch { failure = error.localizedDescription }
    }
}

private struct WorkDetail: Identifiable { let id = UUID(); let title: String; let content: String }
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
private struct WorkEditorSheet: View {
    let editor: WorkEditor
    let save: ([String: String]) async throws -> Void
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var values: [String: String] = [:]
    @State private var saving = false
    @State private var failure: String?
    var body: some View {
        Form {
            ForEach(editor.fields) { field in
                Section(field.label) {
                    let binding = Binding(get: { values[field.id] ?? field.value }, set: { values[field.id] = $0 })
                    if editor.booleanFields.contains(field.id) { Toggle(field.label, isOn: Binding(get: { binding.wrappedValue == "true" }, set: { binding.wrappedValue = $0 ? "true" : "false" })) }
                    else if field.secret { SecureField(field.label, text: binding) }
                    else if field.multiline { TextEditor(text: binding).frame(minHeight: 160) }
                    else { TextField(field.label, text: binding).textInputAutocapitalization(.never) }
                }
            }
            if let failure { Text(failure).foregroundStyle(.red) }
        }
        .navigationTitle(editor.title)
        .interactiveDismissDisabled(saving)
        .disabled(saving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Saving…" : "Save") {
                    saving = true
                    Task {
                        defer { saving = false }
                        do { try await save(Dictionary(uniqueKeysWithValues: editor.fields.map { ($0.id, values[$0.id] ?? $0.value) })); dismiss() }
                        catch { failure = error.localizedDescription }
                    }
                }.disabled(saving)
            }
        }
    }
}

private struct WorkRunOutputView: View {
    let manager: (any FeatureWorkManaging)?
    let environmentID: String
    let connectionID: String
    let profile: String
    let run: HermesWorkRun
    @State private var output: String?
    @State private var failure: String?
    var body: some View {
        ScrollView {
            if let failure { Text(failure).foregroundStyle(.red).padding() }
            else if let output { Text(output).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding() }
            else { ProgressView("Loading result…") }
        }
        .navigationTitle(run.title)
        .task {
            do {
                guard let manager else { throw FeatureCapabilityUnavailable("Work results") }
                let data = try await manager.workQuery(environmentID: environmentID, input: .object(["providerInstanceId": .string(connectionID), "profile": .string(profile), "section": .string("run"), "id": .string(run.id)]))
                output = ([data.content ?? run.content ?? "No output reported."] + data.diagnostics).joined(separator: "\n\n")
            } catch { failure = error.localizedDescription }
        }
    }
}
