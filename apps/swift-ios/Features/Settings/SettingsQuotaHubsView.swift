import SwiftUI

struct SettingsQuotaHubsView: View {
    @Bindable var model: FeatureRootModel
    @State private var environmentID = ""
    @State private var sources: [String: UsageLimitSourceConfig] = [:]
    @State private var supported = false
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var editingID: String?
    @State private var adding = false
    @State private var url = ""
    @State private var label = ""
    @State private var key = ""

    private var manager: any FeatureServerSettingsManaging {
        (model.client as? any FeatureServerSettingsManaging) ?? EmptyFeatureServerSettingsManager.shared
    }
    private var editing: Bool { adding || editingID != nil }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Picker("Environment", selection: $environmentID) {
                    ForEach(model.snapshot.environments) { Text($0.name).tag($0.id) }
                }.disabled(busy || editing)
                SettingsFootnote("Show subscription limits from CLIProxyAPI accounts. Keys stay in this environment’s secret store. Hub accounts do not run tasks.")
                if let errorMessage { SettingsErrorBanner(message: errorMessage) }
                if busy { ProgressView().frame(maxWidth: .infinity) }
                if supported {
                    SettingsSection(title: "Quota hubs") {
                        ForEach(sources.keys.sorted(), id: \.self) { id in
                            if let source = sources[id] {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(source.label ?? source.url).font(T3Typography.threadBody)
                                    HStack {
                                        Button("Edit") { editingID = id; url = source.url; label = source.label ?? ""; key = "" }
                                        Spacer()
                                        Button(source.enabled ? "Disable" : "Enable") {
                                            var changed = source; changed.enabled.toggle()
                                            Task { await save(id: id, source: changed) }
                                        }
                                        Button("Remove", role: .destructive) { Task { await save(id: id, source: nil) } }
                                    }.font(T3Typography.supporting)
                                }.padding(12).disabled(busy || editing)
                            }
                        }
                        Button("Add hub") { adding = true; url = ""; label = ""; key = "" }
                            .padding(12).disabled(busy || editing)
                    }
                    if editing {
                        SettingsSection(title: editingID == nil ? "Add hub" : "Edit hub") {
                            VStack(alignment: .leading, spacing: 12) {
                                TextField("Hub URL", text: $url).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                                TextField("Label (optional)", text: $label)
                                SecureField(editingID == nil ? "Management key" : "Management key (blank keeps current)", text: $key)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                                HStack {
                                    Button("Cancel") { clearDraft() }
                                    Spacer()
                                    Button("Save hub") { Task { await saveDraft() } }
                                }
                            }.padding(12).disabled(busy)
                        }
                    }
                } else if !busy { SettingsFootnote("Connect an environment with quota-hub support to manage sources.") }
            }.padding(SettingsMetrics.cardInset)
        }
        .background(T3Colors.background)
        .navigationTitle("Quota hubs").navigationBarTitleDisplayMode(.inline)
        .onAppear { if environmentID.isEmpty { environmentID = model.snapshot.environments.first?.id ?? "" } }
        .task(id: environmentID) { await load() }
    }

    private func clearDraft() { adding = false; editingID = nil; url = ""; label = ""; key = "" }
    private func load() async {
        let requested = environmentID
        guard !requested.isEmpty else { return }
        busy = true; sources = [:]; supported = false; errorMessage = nil
        do {
            let config = try await manager.providerModelConfiguration(environmentID: requested)
            guard !Task.isCancelled, requested == environmentID else { return }
            sources = config.settings?.usageLimitSources ?? [:]
            supported = config.environment?.capabilities.usageLimitSources == true
        } catch { if !Task.isCancelled, requested == environmentID { errorMessage = error.localizedDescription } }
        if requested == environmentID { busy = false }
    }
    private func saveDraft() async {
        let address = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = URLComponents(string: address), ["http", "https"].contains(parsed.scheme?.lowercased() ?? ""),
              parsed.host?.isEmpty == false, parsed.user == nil, parsed.password == nil else {
            errorMessage = "Enter an HTTP or HTTPS hub URL without embedded credentials."; return
        }
        let secret = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !secret.isEmpty || editingID != nil else { errorMessage = "Enter a management key."; return }
        let name = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let old = editingID.flatMap { sources[$0] }
        await save(id: editingID ?? "cliproxy-\(UUID().uuidString.lowercased())",
            source: .init(label: name.isEmpty ? nil : name, url: address, managementKey: secret.isEmpty ? (old?.managementKey ?? "") : secret, enabled: old?.enabled ?? true))
    }
    private func save(id: String, source: UsageLimitSourceConfig?) async {
        guard !busy else { return }
        busy = true; errorMessage = nil
        do {
            try await manager.updateServerSettings(environmentID: environmentID,
                patch: .init(usageLimitSources: [id: source]))
            clearDraft()
            await load()
        } catch { errorMessage = error.localizedDescription }
        busy = false
    }
}
