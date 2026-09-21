import SwiftUI

/// CLIProxyAPI hubs whose accounts report subscription limits on one server.
/// Pushed from Usage → Limits.
struct SettingsQuotaHubsView: View {
    @Bindable var model: FeatureRootModel
    @State private var environmentID = ""
    @State private var sources: [String: UsageLimitSourceConfig] = [:]
    /// `nil` until the server answers.
    @State private var supported: Bool?
    @State private var loadedID: String?
    @State private var loadError: String?
    @State private var busyIDs: Set<String> = []
    @State private var editor: QuotaHubEditorRequest?
    @State private var removalTarget: String?
    @State private var failure: String?

    private var manager: any FeatureServerSettingsManaging {
        (model.client as? any FeatureServerSettingsManaging) ?? EmptyFeatureServerSettingsManager.shared
    }

    private var serverName: String {
        model.snapshot.environments.first { $0.id == environmentID }?.name ?? "this server"
    }

    var body: some View {
        content
            .settingsServerScope(
                title: "Quota Hubs",
                environments: model.snapshot.environments,
                selection: $environmentID,
                isEnabled: busyIDs.isEmpty
            )
            .toolbar {
                if supported == true {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Add Hub", systemImage: "plus") { editor = QuotaHubEditorRequest(id: nil, source: nil) }
                    }
                }
            }
            .onAppear {
                if environmentID.isEmpty {
                    environmentID = model.snapshot.environments.first(where: \.isActive)?.id
                        ?? model.snapshot.environments.first?.id ?? ""
                }
            }
            .task(id: environmentID) { await load() }
            .sheet(item: $editor) { request in
                QuotaHubEditor(request: request, serverName: serverName) { id, source in
                    try await write(id: id, source: source)
                }
                .presentationDetents([.medium, .large])
            }
            .alert(
                "Couldn't Update Hub",
                isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
            ) {
                Button("OK") { failure = nil }
            } message: {
                Text(failure ?? "")
            }
    }

    @ViewBuilder
    private var content: some View {
        switch supported {
        case nil:
            SettingsForm {
                if let loadError {
                    SettingsRetrySection(message: loadError) { Task { await load() } }
                } else {
                    Section { SettingsPlaceholderRows(count: 2) }
                }
            }
        case false?:
            ContentUnavailableView(
                "Quota Hubs Unavailable",
                systemImage: "network",
                description: Text("Connect an environment with quota-hub support to manage sources.")
            )
            .background(T3Colors.background)
        case true?:
            if sources.isEmpty {
                ContentUnavailableView {
                    Label("No Quota Hubs", systemImage: "network")
                } description: {
                    Text("Show subscription limits from CLIProxyAPI accounts. Hub accounts never run tasks.")
                } actions: {
                    Button("Add Hub") { editor = QuotaHubEditorRequest(id: nil, source: nil) }
                        .t3ProminentButtonStyle()
                }
                .background(T3Colors.background)
            } else {
                SettingsForm {
                    Section {
                        ForEach(sources.keys.sorted(), id: \.self) { id in
                            if let source = sources[id] { hubRow(id: id, source: source) }
                        }
                    } footer: {
                        Text("Shows subscription limits from CLIProxyAPI accounts. Keys stay in \(serverName)’s secret store. Hub accounts never run tasks.")
                    }
                }
                .refreshable { await load() }
            }
        }
    }

    private func hubRow(id: String, source: UsageLimitSourceConfig) -> some View {
        HStack(spacing: 12) {
            Button { editor = QuotaHubEditorRequest(id: id, source: source) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(source.label ?? Self.host(source.url))
                        .foregroundStyle(T3Colors.textPrimary)
                    Text(source.enabled ? Self.host(source.url) : "Off")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Edit this hub")
            if busyIDs.contains(id) {
                ProgressView()
            } else {
                Toggle("Enabled", isOn: Binding(
                    get: { source.enabled },
                    set: { enabled in
                        var changed = source
                        changed.enabled = enabled
                        update(id: id, source: changed)
                    }
                ))
                .labelsHidden()
            }
        }
        .swipeActions(edge: .trailing) {
            Button("Remove", role: .destructive) { removalTarget = id }
        }
        .confirmationDialog(
            "Remove \(source.label ?? Self.host(source.url))?",
            isPresented: Binding(get: { removalTarget == id }, set: { if !$0 { removalTarget = nil } }),
            titleVisibility: .visible
        ) {
            Button("Remove Hub", role: .destructive) { update(id: id, source: nil) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its management key is deleted from \(serverName). Its accounts stop appearing in Limits.")
        }
    }

    static func host(_ url: String) -> String {
        URLComponents(string: url)?.host ?? url
    }

    private func load() async {
        let requested = environmentID
        guard !requested.isEmpty else { return }
        if loadedID != requested {
            // Another server's hubs must not show under this one's name.
            supported = nil
            sources = [:]
        }
        loadError = nil
        do {
            let config = try await manager.providerModelConfiguration(environmentID: requested)
            guard !Task.isCancelled, requested == environmentID else { return }
            sources = config.settings?.usageLimitSources ?? [:]
            supported = config.environment?.capabilities.usageLimitSources == true
            loadedID = requested
        } catch {
            guard !Task.isCancelled, requested == environmentID else { return }
            loadError = error.localizedDescription
        }
    }

    private func write(id: String, source: UsageLimitSourceConfig?) async throws {
        try await manager.updateServerSettings(environmentID: environmentID, patch: .init(usageLimitSources: [id: source]))
        await load()
    }

    /// A toggle or a removal, from the list: the row shows a spinner while it
    /// lands and the list reloads from the server's answer.
    private func update(id: String, source: UsageLimitSourceConfig?) {
        guard !busyIDs.contains(id) else { return }
        busyIDs.insert(id)
        Task { @MainActor in
            do {
                try await write(id: id, source: source)
            } catch {
                PlatformHapticEngine.shared.play(.error)
                failure = error.localizedDescription
            }
            busyIDs.remove(id)
        }
    }
}

private struct QuotaHubEditorRequest: Identifiable {
    let id: String?
    let source: UsageLimitSourceConfig?
}

/// Add or edit one hub. Confirm stays disabled until the draft is valid, and a
/// failed save keeps the draft.
private struct QuotaHubEditor: View {
    let request: QuotaHubEditorRequest
    let serverName: String
    let save: (String, UsageLimitSourceConfig) async throws -> Void

    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var url: String
    @State private var label: String
    @State private var key = ""
    @State private var saving = false
    @State private var failure: String?

    init(
        request: QuotaHubEditorRequest,
        serverName: String,
        save: @escaping (String, UsageLimitSourceConfig) async throws -> Void
    ) {
        self.request = request
        self.serverName = serverName
        self.save = save
        _url = State(initialValue: request.source?.url ?? "")
        _label = State(initialValue: request.source?.label ?? "")
    }

    private var isNew: Bool { request.id == nil }
    private var trimmedURL: String { url.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedKey: String { key.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var urlIsValid: Bool {
        guard let parsed = URLComponents(string: trimmedURL) else { return false }
        return ["http", "https"].contains(parsed.scheme?.lowercased() ?? "")
            && parsed.host?.isEmpty == false && parsed.user == nil && parsed.password == nil
    }

    private var isValid: Bool { urlIsValid && (!isNew || !trimmedKey.isEmpty) }

    private var hasChanges: Bool {
        trimmedURL != (request.source?.url ?? "")
            || label.trimmingCharacters(in: .whitespacesAndNewlines) != (request.source?.label ?? "")
            || !trimmedKey.isEmpty
    }

    var body: some View {
        NavigationStack {
            SettingsForm {
                Section {
                    TextField("URL", text: $url, prompt: Text("https://"))
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Label", text: $label, prompt: Text("Optional"))
                    SecureField("Key", text: $key, prompt: Text(isNew ? "Required" : "Unchanged"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    if !trimmedURL.isEmpty, !urlIsValid {
                        Text("Enter an HTTP or HTTPS hub URL without embedded credentials.")
                            .foregroundStyle(T3Colors.danger)
                    } else {
                        Text("The management key stays in \(serverName)’s secret store.")
                    }
                }
            }
            .disabled(saving)
            .navigationTitle(isNew ? "Add Hub" : "Edit Hub")
            .navigationBarTitleDisplayMode(.inline)
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(title: "Save", isEnabled: isValid && hasChanges, isBusy: saving, action: commit),
                hasChanges: hasChanges || saving
            )
            .alert(
                "Couldn't Save Hub",
                isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
            ) {
                Button("OK") { failure = nil }
            } message: {
                Text(failure ?? "")
            }
        }
    }

    private func commit() {
        guard isValid, !saving else { return }
        let name = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let source = UsageLimitSourceConfig(
            label: name.isEmpty ? nil : name,
            url: trimmedURL,
            managementKey: trimmedKey.isEmpty ? (request.source?.managementKey ?? "") : trimmedKey,
            enabled: request.source?.enabled ?? true
        )
        let id = request.id ?? "cliproxy-\(UUID().uuidString.lowercased())"
        saving = true
        Task { @MainActor in
            do {
                try await save(id, source)
                saving = false
                PlatformHapticEngine.shared.play(.success)
                dismiss()
            } catch {
                saving = false
                PlatformHapticEngine.shared.play(.error)
                failure = error.localizedDescription
            }
        }
    }
}
