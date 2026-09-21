import SwiftUI

// Ported from apps/mobile/src/features/settings/automations/AutomationEditSheet.tsx.
//
// The form edits only what it renders. Launch settings an agent or the web
// client may have configured — the workspace strategy, runtime mode, and
// interaction mode — are carried through verbatim by `AutomationDraft.upsert`,
// so editing a schedule on a phone can never quietly reset them.

public struct AutomationEditSheet: View {
    private enum Field: Hashable {
        case title
        case prompt
    }

    private static let intervalPresets = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]

    private let model: FeatureRootModel
    private let manager: any FeatureScheduledTaskManaging
    private let initialEnvironmentID: String
    private let task: FeatureScheduledTask?
    private let onSaved: () -> Void
    private let onCancel: () -> Void
    private let initialDraft: AutomationDraft

    /// A new automation can move to another server before it is saved; an
    /// existing one lives where it was created.
    @State private var environmentID: String
    @State private var draft: AutomationDraft
    @State private var config: ServerConfigSnapshot?
    @State private var isLoadingCatalog = true
    @State private var isSaving = false
    @State private var isRunning = false
    @State private var isConfirmingDelete = false
    @State private var failureMessage: String?
    /// Once the reader picks a model, changing project must not silently
    /// replace it with that project's default.
    @State private var hasChosenModel = false
    @FocusState private var focusedField: Field?

    public init(
        model: FeatureRootModel,
        manager: any FeatureScheduledTaskManaging,
        environmentID: String,
        task: FeatureScheduledTask?,
        onSaved: @escaping () -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.model = model
        self.manager = manager
        self.initialEnvironmentID = environmentID
        self.task = task
        self.onSaved = onSaved
        self.onCancel = onCancel
        let draft = task.map(AutomationDraft.init(task:)) ?? AutomationDraft()
        initialDraft = draft
        _environmentID = State(initialValue: environmentID)
        _draft = State(initialValue: draft)
        _hasChosenModel = State(initialValue: task != nil)
    }

    private var isEditing: Bool { task != nil }

    public var body: some View {
        NavigationStack {
            SettingsForm {
                Section {
                    TextField("Title", text: $draft.title)
                        .submitLabel(.next)
                        .focused($focusedField, equals: .title)
                        .onSubmit { focusedField = .prompt }
                    TextField("Prompt", text: $draft.prompt, axis: .vertical)
                        .lineLimit(4...10)
                        .focused($focusedField, equals: .prompt)
                } footer: {
                    Text("Sent to the agent each time the automation runs.")
                }
                scheduleSection
                placementSection
                modelSection
                Section {
                    Toggle("Enabled", isOn: $draft.isEnabled)
                }
                if let task {
                    Section {
                        Button {
                            Task { await runNow(task) }
                        } label: {
                            HStack {
                                Text("Run Now")
                                if isRunning {
                                    Spacer()
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(isRunning || task.isRunning)
                    } footer: {
                        Text("Runs the saved version once, outside its schedule.")
                    }
                    Section {
                        Button("Delete Automation", role: .destructive) { isConfirmingDelete = true }
                            .confirmationDialog(
                                "Delete automation?",
                                isPresented: $isConfirmingDelete,
                                titleVisibility: .visible
                            ) {
                                Button("Delete Automation", role: .destructive) {
                                    Task { await delete(task) }
                                }
                                Button("Cancel", role: .cancel) {}
                            } message: {
                                Text("“\(task.title)” and its schedule will be removed. Threads it already created stay.")
                            }
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(isEditing ? "Edit Automation" : "New Automation")
            .navigationBarTitleDisplayMode(.inline)
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: "Save",
                    isEnabled: !isSaving && draft.isComplete,
                    isBusy: isSaving,
                    action: { Task { await save() } }
                ),
                hasChanges: hasChanges,
                onDismiss: onCancel
            )
            .task(id: environmentID) { await loadCatalog() }
            .onChange(of: environmentID) { _, _ in
                // The previous server's project, thread and model do not exist here.
                draft.clearEnvironmentScopedFields()
                hasChosenModel = false
                config = nil
            }
            .onChange(of: draft.projectID) { _, _ in
                // A project change invalidates any thread bound from the previous one.
                draft.threadID = nil
                resolveDefaultModel()
            }
            .alert(
                "Couldn't Save Automation",
                isPresented: Binding(get: { failureMessage != nil }, set: { if !$0 { failureMessage = nil } })
            ) {
                Button("OK") { failureMessage = nil }
            } message: {
                Text(failureMessage ?? "")
            }
        }
    }

    /// A default model the catalog fills in is not an edit, so it alone does
    /// not make Cancel ask before discarding.
    private var hasChanges: Bool {
        var compared = draft
        if !hasChosenModel { compared.modelSelection = initialDraft.modelSelection }
        return compared != initialDraft || environmentID != initialEnvironmentID
    }

    // MARK: - Schedule

    private var scheduleSection: some View {
        Section {
            Picker("Schedule", selection: $draft.scheduleMode) {
                Text("Time of Day").tag(AutomationDraft.ScheduleMode.fixed)
                Text("Interval").tag(AutomationDraft.ScheduleMode.interval)
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            switch draft.scheduleMode {
            case .fixed:
                DatePicker(
                    "Time",
                    selection: Binding(
                        get: { draft.timeOfDayDate() },
                        set: { draft.setTimeOfDay($0) }
                    ),
                    displayedComponents: .hourAndMinute
                )
                NavigationLink {
                    AutomationRepeatView(weekdays: $draft.weekdays)
                } label: {
                    LabeledContent("Repeat", value: ScheduledTaskWeekday.repeatSummary(draft.weekdays))
                }
            case .interval:
                Picker("Every", selection: intervalBinding) {
                    ForEach(intervalChoices, id: \.self) { minutes in
                        Text(Self.intervalLabel(minutes)).tag(minutes)
                    }
                }
                .pickerStyle(.menu)
            }
        } header: {
            Text("Schedule")
        } footer: {
            if draft.scheduleMode == .fixed, draft.weekdays.isEmpty {
                Text("Choose at least one day in Repeat.").foregroundStyle(T3Colors.danger)
            } else if draft.scheduleMode == .fixed {
                Text("Runs on this server's clock.")
            }
        }
    }

    private var intervalBinding: Binding<Int> {
        Binding(
            get: { ScheduledTaskLabels.parseIntervalMinutes(draft.intervalMinutes) ?? 15 },
            set: { draft.intervalMinutes = String($0) }
        )
    }

    /// The presets plus an interval set elsewhere, so editing never rounds it.
    private var intervalChoices: [Int] {
        let current = intervalBinding.wrappedValue
        return Self.intervalPresets.contains(current)
            ? Self.intervalPresets
            : (Self.intervalPresets + [current]).sorted()
    }

    private static func intervalLabel(_ minutes: Int) -> String {
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .full
        formatter.allowedUnits = minutes % 1440 == 0 ? [.day] : minutes % 60 == 0 ? [.hour] : [.hour, .minute]
        return formatter.string(from: TimeInterval(minutes * 60)) ?? "\(minutes) min"
    }

    // MARK: - Server, project, thread

    private var placementSection: some View {
        Section {
            serverRow
            projectRow
            Picker("Posts Into", selection: $draft.threadID) {
                Text("New Thread Each Run").tag(String?.none)
                if let threadID = draft.threadID, !projectThreads.contains(where: { threadWireID($0) == threadID }) {
                    Text(threadID).tag(String?.some(threadID))
                }
                ForEach(projectThreads) { thread in
                    Text(thread.title).tag(String?.some(threadWireID(thread)))
                }
            }
            .pickerStyle(.menu)
            .disabled(selectedProject == nil)
        } header: {
            Text("Runs In")
        } footer: {
            if !isEditing, environmentProjects.isEmpty {
                Text("Add a project on \(environmentName) to schedule automations there.")
                    .foregroundStyle(T3Colors.warning)
            } else if !isEditing, draft.projectID.isEmpty {
                Text("Choose the project each run works in.").foregroundStyle(T3Colors.warning)
            } else {
                Text(draft.threadID == nil
                    ? "Each run starts a fresh thread in a new worktree."
                    : "Every run posts into the same conversation.")
            }
        }
    }

    @ViewBuilder
    private var serverRow: some View {
        let environments = AutomationEnvironmentChoice.ordered(model.snapshot.environments)
        if !isEditing, environments.count > 1 {
            Picker("Server", selection: $environmentID) {
                ForEach(environments) { environment in
                    Label(environment.name, systemImage: environment.machineSymbol).tag(environment.id)
                }
            }
            .pickerStyle(.menu)
        } else {
            LabeledContent("Server", value: environmentName)
        }
    }

    @ViewBuilder
    private var projectRow: some View {
        if isEditing {
            // The project decides where a run checks out, so moving one would
            // change what the automation does rather than just where it runs.
            LabeledContent("Project", value: selectedProject?.name ?? draft.projectID)
        } else if environmentProjects.isEmpty {
            LabeledContent("Project", value: "None on This Server")
        } else {
            Picker("Project", selection: $draft.projectID) {
                if draft.projectID.isEmpty {
                    Text("Choose").tag("")
                }
                ForEach(environmentProjects) { project in
                    Text(project.name).tag(wireID(project))
                }
            }
            .pickerStyle(.menu)
        }
    }

    // MARK: - Model

    private var modelSection: some View {
        Section {
            if isLoadingCatalog, modelOptions.isEmpty {
                LabeledContent("Model") { ProgressView() }
            } else {
                Menu {
                    ForEach(
                        ModelOptions.menuActions(for: modelGroups, selected: draft.modelSelection)
                    ) { action in
                        if action.subactions.isEmpty {
                            modelButton(action)
                        } else {
                            Menu(action.title) {
                                ForEach(action.subactions) { modelButton($0) }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 8) {
                        Text("Model").foregroundStyle(T3Colors.textPrimary)
                        Spacer(minLength: 12)
                        Text(selectedModelLabel)
                            .foregroundStyle(T3Colors.textSecondary)
                            .lineLimit(1)
                        Image(systemName: "chevron.up.chevron.down")
                            .imageScale(.small)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                    .contentShape(Rectangle())
                }
                .disabled(modelOptions.isEmpty)
                .accessibilityLabel("Model, \(selectedModelLabel)")
            }
            if !isLoadingCatalog, modelOptions.isEmpty,
               let setup = ProviderSetupContext(client: model.client, environmentID: environmentID) {
                NavigationLink("Set Up Agents") { ProviderSetupView(context: setup, instanceID: nil) }
            }

            // Effort, fast mode, and whatever else the chosen model publishes.
            if let selected = selectedModelOption {
                ForEach(
                    Array((selected.capabilities?.optionDescriptors ?? []).enumerated()),
                    id: \.offset
                ) { _, descriptor in
                    optionRow(descriptor, on: selected.selection)
                }
            }
        } header: {
            Text("Model")
        } footer: {
            if !isLoadingCatalog, modelOptions.isEmpty {
                Text("No models on this server. Connect and sign in to a provider there first.")
            }
        }
    }

    @ViewBuilder
    private func optionRow(
        _ descriptor: ServerProviderOptionDescriptor,
        on selection: ModelSelection
    ) -> some View {
        switch descriptor {
        case let .select(select):
            // Prompt-injected values apply to a single turn and are never saved.
            let choices = select.options.filter {
                select.promptInjectedValues?.contains($0.id) != true
            }
            if !choices.isEmpty {
                let current = selection.options?.first { $0.id == select.id }?.value.stringValue
                Picker(
                    select.label,
                    selection: Binding(
                        get: { current.flatMap { value in choices.contains { $0.id == value } ? value : nil } ?? "" },
                        set: { value in
                            guard !value.isEmpty else { return }
                            hasChosenModel = true
                            draft.modelSelection = ModelOptions.setting(.string(value), forOption: select.id, on: selection)
                        }
                    )
                ) {
                    if current.map({ value in !choices.contains { $0.id == value } }) ?? true {
                        Text("Default").tag("")
                    }
                    ForEach(choices) { choice in
                        Text(choice.label).tag(choice.id)
                    }
                }
                .pickerStyle(.menu)
            }
        case let .boolean(boolean):
            Toggle(
                boolean.label,
                isOn: Binding(
                    get: {
                        if case let .bool(value)? = selection.options?
                            .first(where: { $0.id == boolean.id })?.value {
                            return value
                        }
                        return boolean.currentValue ?? false
                    },
                    set: { value in
                        hasChosenModel = true
                        draft.modelSelection = ModelOptions.setting(.bool(value), forOption: boolean.id, on: selection)
                    }
                )
            )
        }
    }

    @ViewBuilder
    private func modelButton(_ action: ModelMenuAction) -> some View {
        if let option = modelsByMenuID[action.id] {
            Button {
                draft.modelSelection = option.selection
                hasChosenModel = true
                PlatformHapticEngine.shared.playSelection()
            } label: {
                if action.isSelected {
                    Label(action.title, systemImage: "checkmark")
                } else {
                    Text(action.title)
                }
            }
        }
    }

    // MARK: - Derived state

    private var environmentName: String {
        model.snapshot.environments.first { $0.id == environmentID }?.name ?? "Unknown Server"
    }

    /// An automation starts threads, so it offers the same projects the new-task
    /// sheet does — the server's T3 Work checkout is not one of them.
    private var environmentProjects: [FeatureProject] {
        let serverConfigs = model.client.workspaceServerConfigs()
        return model.snapshot.projects.filter { project in
            project.environmentID == environmentID
                && !MobileWorkspaceRouting.isWorkBackingProject(
                    environmentID: project.environmentID,
                    workspaceRoot: project.path,
                    serverConfigs: serverConfigs
                )
        }
    }

    private func wireID(_ project: FeatureProject) -> String {
        project.wireID ?? project.id
    }

    private func threadWireID(_ thread: FeatureThread) -> String {
        thread.wireID ?? thread.id
    }

    private var selectedProject: FeatureProject? {
        environmentProjects.first { wireID($0) == draft.projectID }
    }

    private var projectThreads: [FeatureThread] {
        guard let selectedProject else { return [] }
        return model.snapshot.threads
            .filter { $0.projectID == selectedProject.id && !$0.isArchived }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    private var modelOptions: [ModelOption] {
        // The draft's own selection is the fallback so a model the catalog no
        // longer lists still appears — and stays selectable — in the picker.
        ModelOptions.build(config: config, fallbackSelection: draft.modelSelection)
    }

    private var modelGroups: [ModelProviderGroup] {
        ModelOptions.grouped(modelOptions)
    }

    private var modelsByMenuID: [String: ModelOption] {
        Dictionary(
            modelOptions.map { ("model:\($0.key)", $0) },
            uniquingKeysWith: { first, _ in first }
        )
    }

    /// The catalog entry for the draft's model. Its `selection` is the draft's
    /// own, normalized against the model's live option descriptors.
    private var selectedModelOption: ModelOption? {
        guard let selection = draft.modelSelection else { return nil }
        return modelOptions.first {
            $0.selection.instanceId == selection.instanceId
                && $0.selection.model == selection.model
        }
    }

    private var selectedModelLabel: String {
        guard let selection = draft.modelSelection else { return "Choose" }
        return selectedModelOption?.label ?? selection.model
    }

    // MARK: - Requests

    @MainActor
    private func loadCatalog() async {
        isLoadingCatalog = true
        let requested = environmentID
        let loaded = try? await manager.scheduledTaskModelCatalog(environmentID: requested)
        guard !Task.isCancelled, requested == environmentID else { return }
        config = loaded
        isLoadingCatalog = false
        resolveDefaultModel()
    }

    /// A new automation has to carry a model, and the project's default is the
    /// one its threads already use. Falls back to the catalog default, then to
    /// whatever the catalog lists first.
    private func resolveDefaultModel() {
        guard !hasChosenModel else { return }
        if let projectDefault = selectedProject?.defaultSelection,
           let usable = ModelOptions.selectable(ModelSelection(featureSelection: projectDefault), in: config) {
            draft.modelSelection = usable
            return
        }
        let options = ModelOptions.build(config: config, fallbackSelection: nil)
        draft.modelSelection = (options.first(where: \.isDefault) ?? options.first)?.selection
    }

    @MainActor
    private func save() async {
        guard let input = draft.upsert(editing: task) else {
            PlatformHapticEngine.shared.play(.error)
            failureMessage = "Choose a model first. If none are listed, connect and sign in to a provider on \(environmentName)."
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await manager.upsertScheduledTask(environmentID: environmentID, input: input)
            PlatformHapticEngine.shared.play(.success)
            onSaved()
        } catch {
            PlatformHapticEngine.shared.play(.error)
            failureMessage = error.localizedDescription
        }
    }

    @MainActor
    private func runNow(_ task: FeatureScheduledTask) async {
        isRunning = true
        defer { isRunning = false }
        do {
            _ = try await manager.runScheduledTaskNow(environmentID: environmentID, id: task.id)
            PlatformHapticEngine.shared.play(.success)
            T3HUD.show("Running Now", systemImage: "play.circle.fill")
        } catch {
            PlatformHapticEngine.shared.play(.error)
            failureMessage = error.localizedDescription
        }
    }

    @MainActor
    private func delete(_ task: FeatureScheduledTask) async {
        do {
            try await manager.deleteScheduledTask(environmentID: environmentID, id: task.id)
            onSaved()
        } catch {
            PlatformHapticEngine.shared.play(.error)
            failureMessage = error.localizedDescription
        }
    }
}

/// The days a time-of-day automation fires, laid out like Repeat in Clock.
private struct AutomationRepeatView: View {
    @Binding var weekdays: Set<ScheduledTaskWeekday>

    var body: some View {
        SettingsForm {
            Section {
                ForEach(ScheduledTaskWeekday.ordered(), id: \.self) { weekday in
                    Button {
                        if weekdays.contains(weekday) {
                            weekdays.remove(weekday)
                        } else {
                            weekdays.insert(weekday)
                        }
                        PlatformHapticEngine.shared.playSelection()
                    } label: {
                        HStack {
                            Text("Every \(weekday.name())").foregroundStyle(T3Colors.textPrimary)
                            Spacer()
                            if weekdays.contains(weekday) {
                                Image(systemName: "checkmark")
                                    .fontWeight(.semibold)
                                    .foregroundStyle(T3Colors.accent)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .accessibilityAddTraits(weekdays.contains(weekday) ? .isSelected : [])
                }
            } footer: {
                if weekdays.isEmpty {
                    Text("Choose at least one day.").foregroundStyle(T3Colors.danger)
                }
            }
        }
        .navigationTitle("Repeat")
        .navigationBarTitleDisplayMode(.inline)
    }
}
