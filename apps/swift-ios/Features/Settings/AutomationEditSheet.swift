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
        case timeOfDay
        case interval
    }

    private let model: FeatureRootModel
    private let manager: any FeatureScheduledTaskManaging
    private let environmentID: String
    private let task: FeatureScheduledTask?
    private let onSaved: () -> Void
    private let onCancel: () -> Void

    @State private var draft: AutomationDraft
    @State private var config: ServerConfigSnapshot?
    @State private var isSaving = false
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
        self.environmentID = environmentID
        self.task = task
        self.onSaved = onSaved
        self.onCancel = onCancel
        _draft = State(initialValue: task.map(AutomationDraft.init(task:)) ?? AutomationDraft())
        _hasChosenModel = State(initialValue: task != nil)
    }

    private var isEditing: Bool { task != nil }

    public var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    if let failureMessage {
                        SettingsErrorBanner(message: failureMessage)
                    }

                    titleField
                    promptField
                    scheduleSection
                    projectSection
                    modelSection
                    threadSection
                    enabledSection
                }
                .padding(.vertical, 18)
            }
            .scrollDismissesKeyboard(.interactively)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(T3Colors.background)
            .navigationTitle(isEditing ? "Edit Automation" : "New Automation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        Task { await save() }
                    }
                    .fontWeight(.semibold)
                    .disabled(!canSave)
                }
            }
            .task { await loadCatalog() }
            .onChange(of: draft.projectID) { _, _ in
                resolveDefaultModel()
            }
        }
        .presentationDragIndicator(.visible)
    }

    private var canSave: Bool {
        !isSaving && draft.isComplete
    }

    // MARK: - Fields

    private var titleField: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsFieldLabel("Title")
            TextField("Automation title", text: $draft.title)
                .submitLabel(.next)
                .focused($focusedField, equals: .title)
                .settingsInputField()
                .accessibilityLabel("Automation title")
                .onSubmit { focusedField = .prompt }
        }
    }

    private var promptField: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsFieldLabel("Prompt")
            TextField("What should run on each fire?", text: $draft.prompt, axis: .vertical)
                .lineLimit(4...)
                .focused($focusedField, equals: .prompt)
                .settingsInputField(minHeight: 96)
                .accessibilityLabel("Automation prompt")
        }
    }

    private var scheduleSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsFieldLabel("Schedule")

            Picker("Schedule", selection: $draft.scheduleMode) {
                Text("Fixed time").tag(AutomationDraft.ScheduleMode.fixed)
                Text("Interval").tag(AutomationDraft.ScheduleMode.interval)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, SettingsMetrics.rowPadding)

            switch draft.scheduleMode {
            case .fixed: fixedTimeEditor
            case .interval: intervalEditor
            }
        }
    }

    private var fixedTimeEditor: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text("Time")
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textPrimary)
                Spacer(minLength: 12)
                TextField("09:00", text: $draft.timeOfDay)
                    .multilineTextAlignment(.trailing)
                    .keyboardType(.numbersAndPunctuation)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .timeOfDay)
                    .frame(width: 88)
                    // Invalid entries stay in the field and read red rather than
                    // being rewritten, so a half-typed "9:" is not clobbered.
                    .foregroundStyle(draft.isTimeOfDayValid ? T3Colors.textPrimary : T3Colors.danger)
                    .accessibilityLabel("Time of day, 24 hour HH:MM")
            }
            .padding(.horizontal, SettingsMetrics.rowPadding)
            .frame(minHeight: 52)

            SettingsRowDivider(isInsetForIcon: false)

            weekdayPicker
        }
    }

    private var weekdayPicker: some View {
        HStack(spacing: 6) {
            ForEach(ScheduledTaskWeekday.pickerOrder, id: \.rawValue) { weekday in
                let isOn = draft.weekdays.contains(weekday)
                Button {
                    draft.toggle(weekday)
                } label: {
                    Text(weekday.initials)
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(
                            isOn ? T3Colors.primaryActionForeground : T3Colors.textSecondary
                        )
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                        .background(isOn ? T3Colors.primaryAction : T3Colors.subtle, in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(weekday.accessibilityName)
                .accessibilityAddTraits(isOn ? [.isButton, .isSelected] : .isButton)
            }
        }
        .padding(.horizontal, SettingsMetrics.rowPadding)
        .padding(.vertical, 12)
    }

    private var intervalEditor: some View {
        HStack(spacing: 12) {
            Text("Every")
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textPrimary)
            Spacer(minLength: 12)
            TextField("15", text: $draft.intervalMinutes)
                .multilineTextAlignment(.trailing)
                .keyboardType(.numberPad)
                .focused($focusedField, equals: .interval)
                .frame(width: 64)
                .foregroundStyle(draft.isIntervalValid ? T3Colors.textPrimary : T3Colors.danger)
                .accessibilityLabel("Interval in minutes")
            Text("minutes")
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .padding(.horizontal, SettingsMetrics.rowPadding)
        .frame(minHeight: 52)
    }

    @ViewBuilder
    private var projectSection: some View {
        if isEditing {
            // The project decides where a run checks out, so moving one would
            // change what the automation does rather than just where it runs.
            SettingsSection(title: "Project") {
                SettingsValueRow(title: "Project", value: selectedProject?.name ?? draft.projectID)
            }
        } else {
            SettingsSection(
                title: "Project",
                footer: """
                    Each run starts a fresh thread in a new worktree using the project's default \
                    model.
                    """
            ) {
                if environmentProjects.isEmpty {
                    Text("No projects on this environment yet.")
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textSecondary)
                        .padding(.horizontal, SettingsMetrics.rowPadding)
                        .frame(minHeight: 52, alignment: .leading)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(environmentProjects.enumerated()), id: \.element.id) {
                            index, project in
                            if index > 0 {
                                SettingsRowDivider(isInsetForIcon: false)
                            }
                            selectionRow(
                                title: project.name,
                                isSelected: draft.projectID == wireID(project)
                            ) {
                                draft.projectID = wireID(project)
                                // A project change invalidates any thread bound
                                // from the previous one.
                                draft.threadID = nil
                            }
                        }
                    }
                }
            }
        }
    }

    private var modelSection: some View {
        SettingsSection(title: "Model") {
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
                SettingsValueNavigationRow(
                    title: "Model",
                    systemImage: "cpu",
                    value: selectedModelLabel
                )
            }
            .accessibilityLabel("Model, \(selectedModelLabel)")
        }
    }

    @ViewBuilder
    private var threadSection: some View {
        SettingsSection(
            title: "Thread",
            footer: "Bind an existing thread to keep every run in one conversation."
        ) {
            Menu {
                Button {
                    draft.threadID = nil
                } label: {
                    threadLabel("New thread each run", isSelected: draft.threadID == nil)
                }
                ForEach(projectThreads) { thread in
                    Button {
                        draft.threadID = threadWireID(thread)
                    } label: {
                        threadLabel(
                            thread.title,
                            isSelected: draft.threadID == threadWireID(thread)
                        )
                    }
                }
            } label: {
                SettingsValueNavigationRow(
                    title: "Posts into",
                    systemImage: "bubble.left.and.bubble.right",
                    value: boundThreadLabel
                )
            }
            .accessibilityLabel("Thread binding, \(boundThreadLabel)")
        }
    }

    private var enabledSection: some View {
        SettingsSection(title: "Status") {
            SettingsToggleRow(
                title: "Enabled",
                systemImage: "power",
                isOn: $draft.isEnabled
            )
        }
    }

    private func selectionRow(
        title: String,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text(title)
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 12)
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.accent)
                }
            }
            .padding(.horizontal, SettingsMetrics.rowPadding)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    @ViewBuilder
    private func modelButton(_ action: ModelMenuAction) -> some View {
        if let option = modelsByMenuID[action.id] {
            Button {
                draft.modelSelection = option.selection
                hasChosenModel = true
            } label: {
                if action.isSelected {
                    Label(action.title, systemImage: "checkmark")
                } else {
                    Text(action.title)
                }
            }
        }
    }

    private func threadLabel(_ title: String, isSelected: Bool) -> some View {
        Group {
            if isSelected {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }

    // MARK: - Derived state

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

    private var boundThreadLabel: String {
        guard let threadID = draft.threadID else { return "New thread each run" }
        return projectThreads.first { threadWireID($0) == threadID }?.title ?? threadID
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

    private var selectedModelLabel: String {
        guard let selection = draft.modelSelection else { return "Choose a model" }
        return modelOptions.first {
            $0.selection.instanceId == selection.instanceId
                && $0.selection.model == selection.model
        }?.label ?? selection.model
    }

    // MARK: - Requests

    @MainActor
    private func loadCatalog() async {
        config = try? await manager.scheduledTaskModelCatalog(environmentID: environmentID)
        resolveDefaultModel()
    }

    /// A new automation has to carry a model, and the project's default is the
    /// one its threads already use. Falls back to the catalog default, then to
    /// whatever the catalog lists first.
    private func resolveDefaultModel() {
        guard !hasChosenModel else { return }
        if let projectDefault = selectedProject?.defaultSelection,
           let usable = ModelOptions.selectable(ModelSelection(projectDefault), in: config) {
            draft.modelSelection = usable
            return
        }
        let options = ModelOptions.build(config: config, fallbackSelection: nil)
        draft.modelSelection = (options.first(where: \.isDefault) ?? options.first)?.selection
    }

    @MainActor
    private func save() async {
        guard let input = draft.upsert(editing: task) else {
            failureMessage = "Connect and authenticate a provider on this environment first."
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await manager.upsertScheduledTask(environmentID: environmentID, input: input)
            onSaved()
        } catch {
            failureMessage = error.localizedDescription
        }
    }
}

private extension ModelSelection {
    /// Bridges the feature-layer selection a project carries into the wire shape
    /// a scheduled task stores.
    init(_ selection: FeatureSelection) {
        self.init(
            instanceId: selection.providerID,
            model: selection.modelID,
            options: selection.options.isEmpty
                ? nil
                : selection.options.map {
                    OptionSelection(id: $0.id, value: $0.value.jsonValue)
                }
        )
    }
}

private extension FeatureModelOptionValue {
    var jsonValue: JSONValue {
        switch self {
        case let .string(value): .string(value)
        case let .boolean(value): .bool(value)
        }
    }
}
