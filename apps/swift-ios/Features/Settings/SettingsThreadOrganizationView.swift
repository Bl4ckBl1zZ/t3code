import SwiftUI

/// Preferences a server shares with every connected client: how threads
/// settle, whether they resume after a restart, and how generated Git text
/// reads. Each change is written as it is made and shown at once; a failed
/// write puts the control back and says why.
struct SettingsThreadOrganizationView: View {
    @Bindable var model: FeatureRootModel
    @State private var environmentID: String
    @State private var page = ServerSettingsPageState()
    @State private var mismatches: [FeatureSharedSettingsMismatch] = []
    @State private var loadError: String?
    @State private var writeError: String?
    @State private var applyingToAll = false

    /// `environmentID` opens the page on that server instead of the active one.
    init(model: FeatureRootModel, environmentID: String? = nil) {
        self.model = model
        _environmentID = State(initialValue: environmentID ?? "")
    }

    private var manager: any FeatureServerSettingsManaging {
        (model.client as? any FeatureServerSettingsManaging) ?? EmptyFeatureServerSettingsManager.shared
    }

    private var supported: Bool { page.capabilities?.threadAutoSettlement == true }
    private var restartSupported: Bool { page.capabilities?.threadRestartContinuation == true }
    private var settings: ServerSettingsSnapshot? { page.settings }

    // Each value reads the write still in flight first, then the server's answer.

    private var settleOnMerge: Bool {
        page.pending.sidebarAutoSettleOnMerge
            ?? settings?.sidebarAutoSettleOnMerge
            ?? ServerSettingsSnapshot.defaultSidebarAutoSettleOnMerge
    }

    private var inactiveDays: Double? {
        if let pending = page.pending.sidebarAutoSettleAfterDays { return pending }
        return settings?.sidebarAutoSettleAfterDays
    }

    private var continueAfterRestarts: Bool {
        page.pending.continueThreadsAfterServerUpdate ?? settings?.continueThreadsAfterServerUpdate ?? false
    }

    private var startFromOrigin: Bool {
        page.pending.newWorktreesStartFromOrigin ?? settings?.newWorktreesStartFromOrigin ?? true
    }

    private var writingMode: String {
        page.pending.sourceControlWritingStyle?.mode
            ?? settings?.sourceControlWritingStyle?.mode
            ?? "repo_conventions"
    }

    private var writingInstructions: String {
        page.pending.sourceControlWritingStyle?.customInstructions
            ?? settings?.sourceControlWritingStyle?.customInstructions
            ?? ""
    }

    private var followsTemplates: Bool {
        page.pending.sourceControlWritingStyle?.followChangeRequestTemplates
            ?? settings?.sourceControlWritingStyle?.followChangeRequestTemplates
            ?? true
    }

    private var generationModel: FeatureSelection? {
        (page.pending.textGenerationModelSelection ?? settings?.textGenerationModelSelection)
            .map(FeatureSelection.init(serverSelection:))
    }

    var body: some View {
        SettingsForm {
            if page.config == nil {
                if let loadError {
                    SettingsRetrySection(message: loadError) { Task { await load() } }
                } else {
                    Section { SettingsPlaceholderRows(count: 4) }
                }
            } else {
                if !mismatches.isEmpty { mismatchSection }
                settlementSection
                restartSection
                gitSection
            }
        }
        .settingsServerScope(
            title: "Shared Preferences",
            environments: model.snapshot.environments,
            selection: $environmentID
        )
        .onAppear {
            if environmentID.isEmpty {
                environmentID = model.snapshot.environments.first(where: \.isActive)?.id
                    ?? model.snapshot.environments.first?.id ?? ""
            }
        }
        .task(id: environmentID) { await load() }
        .refreshable { await load() }
    }

    private var mismatchSection: some View {
        Section {
            HStack(spacing: 12) {
                Label(
                    "Different on " + mismatches.map(\.name).joined(separator: ", "),
                    systemImage: "exclamationmark.triangle.fill"
                )
                .foregroundStyle(T3Colors.warning)
                Spacer(minLength: 8)
                if applyingToAll {
                    ProgressView()
                } else {
                    Button("Apply to All") { Task { await applyToAll() } }
                        .buttonStyle(.bordered)
                        .tint(T3Colors.accent)
                        .disabled(page.isWriting)
                }
            }
        } footer: {
            Text("Apply this machine’s shared preferences to every connected machine.")
        }
    }

    private var settlementSection: some View {
        Section {
            Toggle("Settle Merged Pull Requests", isOn: Binding(
                get: { settleOnMerge },
                set: { save(.init(sidebarAutoSettleOnMerge: $0)) }
            ))
            Toggle("Settle Inactive Threads", isOn: Binding(
                get: { inactiveDays != nil },
                set: { save(.init(sidebarAutoSettleAfterDays: .some($0 ? ServerSettingsSnapshot.defaultSidebarAutoSettleAfterDays : nil))) }
            ))
            if let inactiveDays {
                Stepper(
                    "After \(inactiveDays.formatted()) \(inactiveDays == 1 ? "Day" : "Days")",
                    value: Binding(
                        get: { inactiveDays },
                        set: { save(.init(sidebarAutoSettleAfterDays: .some($0))) }
                    ),
                    in: 1...90,
                    step: 1
                )
            }
        } header: {
            Text("Automatic Settlement")
        } footer: {
            SettingsFooter(
                text: supported
                    ? "Moves finished or quiet threads to Settled, even when no app is open. Running work, blocking requests and open linked pull requests stay active. You can reopen a settled thread at any time."
                    : "Connect a current server to configure automatic settlement.",
                error: writeError
            )
        }
        .disabled(!supported)
    }

    private var restartSection: some View {
        Section {
            Toggle("Continue After Restarts", isOn: Binding(
                get: { continueAfterRestarts },
                set: { save(.init(continueThreadsAfterServerUpdate: $0), isRestart: true) }
            ))
        } header: {
            Text("Restart Recovery")
        } footer: {
            Text(restartSupported
                ? "Resumes interrupted threads when this machine starts T3 again, including after updates. Saved provider sessions are required. Terminal commands may still be interrupted."
                : "Connect an updated server to configure restart recovery.")
        }
        .disabled(!restartSupported)
    }

    private var gitSection: some View {
        Section {
            Toggle("Start New Worktrees from Origin", isOn: Binding(
                get: { startFromOrigin },
                set: { save(.init(newWorktreesStartFromOrigin: $0)) }
            ))
            ProviderModelPicker(
                providers: (model.snapshot.providersByEnvironment?[environmentID] ?? []).filter { provider in
                    page.config?.providers.first(where: { $0.instanceId == provider.id })?.supportsTextGeneration != false
                },
                selection: Binding(get: { generationModel }, set: { selection in
                    if let selection {
                        save(.init(textGenerationModelSelection: ModelSelection(featureSelection: selection)))
                    }
                }),
                materializesDefaultSelection: false,
                setupContext: ProviderSetupContext(client: model.client, environmentID: environmentID)
            )
            Picker("Writing Style", selection: Binding(
                get: { writingMode },
                set: { save(.init(sourceControlWritingStyle: .init(mode: $0))) }
            )) {
                Text("Repository Conventions").tag("repo_conventions")
                Text("Conventional Commits").tag("conventional_commits")
                Text("Custom Instructions").tag("custom")
            }
            .pickerStyle(.menu)
            if writingMode == "custom" {
                NavigationLink {
                    SettingsWritingInstructionsView(initial: writingInstructions) { instructions in
                        save(.init(sourceControlWritingStyle: .init(customInstructions: instructions)))
                    }
                } label: {
                    LabeledContent("Instructions") {
                        Text(writingInstructions.isEmpty ? "None" : writingInstructions)
                            .lineLimit(1)
                    }
                }
            }
            Toggle("Follow Pull Request Templates", isOn: Binding(
                get: { followsTemplates },
                set: { save(.init(sourceControlWritingStyle: .init(followChangeRequestTemplates: $0))) }
            ))
        } header: {
            Text("Git and Generated Text")
        } footer: {
            Text("The model here writes thread titles, commit messages and pull requests.")
        }
        .disabled(!supported)
    }

    // MARK: - Requests

    private func load() async {
        let requestedID = environmentID
        guard !requestedID.isEmpty else { return }
        if page.environmentID != requestedID {
            mismatches = []
            writeError = nil
        }
        page.beginLoad(environmentID: requestedID)
        defer { if requestedID == environmentID { page.endLoad() } }
        do {
            let result = try await manager.providerModelConfiguration(environmentID: requestedID)
            guard !Task.isCancelled, requestedID == environmentID else { return }
            page.finishLoad(result)
            loadError = nil
            let differences = try await manager.sharedSettingsMismatches(environmentID: requestedID)
            guard !Task.isCancelled, requestedID == environmentID else { return }
            mismatches = differences
        } catch {
            if !Task.isCancelled, requestedID == environmentID { loadError = error.localizedDescription }
        }
    }

    /// Shows the change at once and writes it. The capability is checked again
    /// against a fresh config, because a sparse patch sent to a server that has
    /// since reconnected on an older version would be silently dropped.
    private func save(_ patch: ServerSettingsPatchInput, isRestart: Bool = false) {
        guard isRestart ? restartSupported : supported else { return }
        let requestedID = environmentID
        page.beginWrite(patch)
        writeError = nil
        Task { @MainActor in
            var failure: String?
            do {
                let current = try await manager.providerModelConfiguration(environmentID: requestedID)
                let available = isRestart
                    ? current.environment?.capabilities.threadRestartContinuation
                    : current.environment?.capabilities.threadAutoSettlement
                guard available == true else {
                    throw FeatureCapabilityUnavailable(isRestart ? "Restart recovery" : "Automatic settlement")
                }
                try await manager.updateServerSettings(environmentID: requestedID, patch: patch)
            } catch {
                failure = "Couldn't save. \(error.localizedDescription)"
            }
            guard requestedID == environmentID else { return }
            if let failure {
                writeError = failure
                PlatformHapticEngine.shared.play(.error)
            }
            if page.finishWrite(succeeded: failure == nil) { await load() }
        }
    }

    private func applyToAll() async {
        guard !applyingToAll else { return }
        let requestedID = environmentID
        applyingToAll = true
        defer { applyingToAll = false }
        do {
            try await manager.applySharedSettings(environmentID: requestedID)
            guard requestedID == environmentID, !Task.isCancelled else { return }
            PlatformHapticEngine.shared.play(.success)
            await load()
        } catch {
            if requestedID == environmentID, !Task.isCancelled {
                writeError = "Couldn't apply. \(error.localizedDescription)"
            }
        }
    }
}

/// Free-text instructions for generated Git text, on a page of their own so
/// the field has room. Saved when the reader goes back, and only if changed.
private struct SettingsWritingInstructionsView: View {
    let initial: String
    let save: (String) -> Void
    @State private var text: String

    init(initial: String, save: @escaping (String) -> Void) {
        self.initial = initial
        self.save = save
        _text = State(initialValue: initial)
    }

    var body: some View {
        SettingsForm {
            Section {
                TextField("For example: imperative mood, no emoji", text: $text, axis: .vertical)
                    .lineLimit(6...16)
            } footer: {
                Text("Used for commit messages and pull requests when Writing Style is Custom Instructions. Saved when you go back.")
            }
        }
        .navigationTitle("Instructions")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed != initial.trimmingCharacters(in: .whitespacesAndNewlines) { save(trimmed) }
        }
    }
}
