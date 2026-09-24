import SwiftUI

public struct NewThreadView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    let submit: (NewTaskRequest) async -> FeatureThread?
    let onCreated: (FeatureThread) -> Void
    let onCreateProject: @MainActor () -> Void
    private let draftStore: FeatureComposerDraftStore
    private let projectMemoryStore: NewTaskProjectMemoryStore
    private let initialProjectID: String?
    private let draftID: String?

    @ScaledMetric(relativeTo: .title2) private var projectIconSize: CGFloat = 20
    @AppStorage(NativeLoadBalancingPreferences.enabledKey) private var loadBalancingEnabled = false
    @AppStorage(NativeLoadBalancingPreferences.weightsKey) private var loadBalancingWeightsJSON = "{}"
    @State private var routing: FeatureComposerRoutingDraft?
    @State private var balancing = false
    @State private var balancingMessage: String?
    @State private var balancingAttempt = 0
    @State private var projectID = ""
    @State private var prompt = ""
    @State private var selection: FeatureSelection?
    @State private var selectionIsExplicit = false
    @State private var preferredSelection: FeatureSelection?
    @State private var projectMemory: NewTaskProjectMemory
    @State private var attachments: [FeatureDraftAttachment] = []
    /// The mode the thread is created in. Not persisted with the draft: it is a
    /// choice about the turn being written now, and a stale Plan from a draft
    /// reopened days later would be a surprise, not a restoration.
    @State private var interactionMode: FeatureInteractionMode = .standard
    @State private var workspaceMode: FeatureWorkspaceMode = .local
    @State private var workspaceSelectionIsExplicit = false
    @State private var branches: [FeatureWorkspaceBranch] = []
    @State private var selectedBranch: FeatureWorkspaceBranch?
    @State private var startFromOrigin = true
    @State private var branchesLoading = false
    @State private var branchLoadFailed = false
    @State private var showingBranchPicker = false
    @State private var isSubmitting = false
    @State private var submissionFailed = false
    @State private var restoredDraftProjectID: String?
    @State private var draftRestoreContext: NewTaskDraftRestoreContext?
    @State private var isSwappingDraft = false
    @State private var draftSaveTask: Task<Void, Never>?
    @State private var immediateDraftSaveTasks: [String: Task<Void, Never>] = [:]
    @State private var submittedSuccessfully = false
    /// The draft was deleted on the way out, so leaving must not save it again.
    @State private var discardedDraft = false
    @State private var confirmsLeaving = false
    @State private var didFocusPrompt = false
    @FocusState private var promptFocused: Bool
    private let voice = VoiceComposerCoordinator.shared

    public init(
        model: FeatureRootModel,
        submit: @escaping (NewTaskRequest) async -> FeatureThread?,
        onCreated: @escaping (FeatureThread) -> Void,
        onCreateProject: @escaping @MainActor () -> Void = {},
        initialProjectID: String? = nil,
        draftID: String? = nil,
        draftStore: FeatureComposerDraftStore = .shared,
        projectMemoryStore: NewTaskProjectMemoryStore = .shared
    ) {
        self.model = model
        self.submit = submit
        self.onCreated = onCreated
        self.onCreateProject = onCreateProject
        self.initialProjectID = initialProjectID
        self.draftID = draftID
        self.draftStore = draftStore
        self.projectMemoryStore = projectMemoryStore
        _projectMemory = State(initialValue: projectMemoryStore.memory())
    }

    public var body: some View {
        NavigationStack {
            content
                .navigationTitle("New Task")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        ComposeCancelButton(action: requestLeave)
                            .disabled(isSubmitting)
                    }
                }
                .t3NavigationChrome()
        }
        // A task draft is kept, so leaving with words in it asks the Mail
        // question: keep the draft for later, or delete it.
        .interactiveDismissDisabled(isSubmitting || hasUnsavedWork)
        .confirmationDialog(
            voice.state.isBusy ? "Your recording is still being transcribed." : "Keep this task as a draft?",
            isPresented: $confirmsLeaving,
            titleVisibility: .visible
        ) {
            Button("Delete Draft", role: .destructive, action: deleteDraftAndClose)
            Button("Save Draft") { dismiss() }
            Button("Keep Editing", role: .cancel) {}
        }
        .onAppear {
            if projectID.isEmpty {
                // A caller-supplied project is an explicit destination and wins;
                // otherwise reopen on the project this sheet was last used for.
                let initialID = creationProjects.first(where: { $0.id == initialProjectID })?.id
                    ?? projectMemory.preferredProjectID(in: creationProjects)
                    ?? creationProjects.first?.id
                    ?? ""
                selectInitialProject(initialID)
            }
        }
        .onChange(of: projectID) { prepareProjectIfNeeded(projectID) }
        .onChange(of: creationProjectIDs) { _, ids in
            guard !ids.contains(projectID) else { return }
            if routing?.projectID != nil, selectedProject != nil { return }
            persistCurrentDraftImmediately()
            selectInitialProject(
                projectMemory.preferredProjectID(in: creationProjects) ?? ids.first ?? ""
            )
        }
        .onChange(of: prompt) { scheduleDraftSave() }
        .onChange(of: selection) { scheduleDraftSave() }
        .onChange(of: attachments) { scheduleDraftSave() }
        .onChange(of: workspaceMode) { scheduleDraftSave() }
        .onChange(of: selectedBranch) { scheduleDraftSave() }
        .onChange(of: startFromOrigin) { scheduleDraftSave() }
        .onChange(of: routing) { scheduleDraftSave() }
        .task(id: "\(executionProject?.id ?? ""):\(selection?.providerID ?? "")") {
            guard let project = executionProject, let instanceID = selection?.providerID,
                  creationProviders.first(where: { $0.id == instanceID })?.driver == "antigravity" else { return }
            try? await model.client.refreshProviderWorkspace(projectID: project.id, instanceID: instanceID, cwd: project.path)
        }
        .task(id: balancingRequest) { await balanceEnvironment() }
        .task(id: routing?.projectID) {
            if restoredDraftProjectID == projectID, routing?.projectID != nil { await loadBranches() }
        }
        .task(id: projectID) { await restoreDraftAndLoadBranches() }
        .onDisappear {
            guard !submittedSuccessfully, !discardedDraft else { return }
            persistCurrentDraftImmediately()
        }
        .sheet(isPresented: $showingBranchPicker) {
            NewTaskBranchPicker(
                branches: branches,
                selection: selectedBranch,
                isLoading: branchesLoading,
                loadFailed: branchLoadFailed,
                onSelect: { branch in
                    makeRoutingManual()
                    workspaceSelectionIsExplicit = true
                    selectedBranch = branch
                    showingBranchPicker = false
                },
                onRefresh: { Task { await loadBranches(refresh: true) } }
            )
        }
        .alert("Couldn’t Start Task", isPresented: $submissionFailed) {
            Button("OK") {}
        } message: {
            Text("Your task is still here. Check your connection and try again.")
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private var content: some View {
        if creationProjects.isEmpty {
            noProjects
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(T3Colors.background.ignoresSafeArea())
        } else {
            VStack(spacing: 0) {
                ScrollView {
                    hero
                        .padding(.top, 40)
                        .padding(.bottom, 20)
                }
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.interactively)

                FeatureComposerView(
                    text: $prompt,
                    selection: selectionBinding,
                    attachments: $attachments,
                    interactionMode: $interactionMode,
                    providers: creationProviders,
                    providerSetup: ProviderSetupContext(client: model.client, environmentID: executionProject?.environmentID),
                    threadSelection: nil,
                    isSending: isSubmitting,
                    isWorking: false,
                    focused: $promptFocused,
                    onSend: startTask,
                    onStop: {},
                    forceExpanded: true,
                    powerFeatures: composerPowerFeatures,
                    sendBlocker: sendBlocker,
                    historyDraftKey: currentDraftKey,
                    historyDraftStore: draftStore,
                    onWillStash: {
                        isSwappingDraft = true
                        let pending = draftSaveTask
                        pending?.cancel()
                        await pending?.value
                        if let key = currentDraftKey { await immediateDraftSaveTasks[key]?.value }
                    },
                    onDidStash: { isSwappingDraft = false }
                )
            }
            .background(T3Colors.background.ignoresSafeArea())
        }
    }

    // MARK: - Leaving

    private var hasUnsavedWork: Bool {
        !trimmedPrompt.isEmpty || !attachments.isEmpty || voice.state.isBusy
    }

    private func requestLeave() {
        if hasUnsavedWork {
            confirmsLeaving = true
        } else {
            dismiss()
        }
    }

    /// Deletes the stored draft rather than just closing: the sheet saves its
    /// draft on the way out, so "Delete" has to stop that save and remove the
    /// copy already written. A recording in flight is cancelled with it.
    private func deleteDraftAndClose() {
        if voice.state.isBusy { voice.cancelRecording() }
        discardedDraft = true
        let pendingSave = draftSaveTask
        draftSaveTask = nil
        let key = currentDraftKey
        let immediateSave = key.flatMap { immediateDraftSaveTasks.removeValue(forKey: $0) }
        let store = draftStore
        Task { @MainActor in
            await NewTaskDraftWriteFence.cancelAndWait(pendingSave)
            await NewTaskDraftWriteFence.wait(immediateSave)
            if let key { try? await store.removeDraft(for: key) }
        }
        dismiss()
    }

    /// The question, with the project as an accent menu inside it, then the
    /// computer and workspace as glass capsule menus in layout flow.
    private var hero: some View {
        VStack(spacing: 18) {
            VStack(spacing: 6) {
                Text("What should we build")
                HStack(spacing: 5) {
                    Text("in")
                    projectMenu
                    Text("?")
                }
            }
            .font(T3Typography.threadHeading1.weight(.regular))
            .tracking(-0.35)
            .foregroundStyle(T3Colors.textPrimary)
            .multilineTextAlignment(.center)

            ComposeFlowLayout(spacing: 8) {
                computerMenu
                // A T3 Work conversation is directory-based Hermes chat:
                // worktrees, branches and origin do not apply, so the
                // capsules that offer them disappear entirely.
                if !isWorkConversation {
                    workspaceMenu
                    branchControl
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 20)
        .accessibilityElement(children: .contain)
    }

    private var projectMenu: some View {
        Menu {
            ForEach(creationProjects) { project in
                Button {
                    selectProject(project.id)
                } label: {
                    // A menu row reads a second Text as its subtitle and a
                    // bare Image as its trailing mark, so the path sits small
                    // under the name instead of wrapping beside it.
                    let row = projectMenuRow(project)
                    Text(row.title)
                    if let detail = row.detail {
                        Text(detail)
                    }
                    if project.id == projectID {
                        Image(systemName: "checkmark")
                    }
                }
            }
        } label: {
            // Primary text, not the accent role: most palettes define accent
            // as the message-bubble fill, which nearly vanishes on the sheet.
            HStack(spacing: 4) {
                if let project = selectedProject {
                    ProjectFaviconBadge(
                        environmentID: project.environmentID,
                        workspaceRoot: project.path,
                        faviconPath: project.faviconPath,
                        projectIcon: project.projectIcon,
                        projectTitle: project.name,
                        size: projectIconSize
                    ) {
                        Image(systemName: "folder")
                    }
                    .padding(.trailing, 2)
                }
                Text(selectedProject?.name ?? "a project")
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(T3Colors.textSecondary)
                    .accessibilityHidden(true)
            }
            .foregroundStyle(T3Colors.textPrimary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isSubmitting)
        .accessibilityLabel("Project")
        .accessibilityValue(selectedProject?.name ?? "None")
    }

    @ViewBuilder
    private var computerMenu: some View {
        let offline = executionProject != nil && !executionEnvironmentConnected
        let title = balancing
            ? "Checking machines…"
            : automaticRouting ? "Auto · \(environmentName)" : environmentName + (offline ? " Offline" : "")
        let symbol = offline
            ? "wifi.slash"
            : automaticRouting
                ? "scalemass"
                : model.snapshot.environments.first { $0.id == executionProject?.environmentID }?.machineSymbol ?? "server.rack"
        if creationEnvironments.count > 1 || loadBalancingEnabled {
            Menu {
                if loadBalancingEnabled {
                    Button { retryAutomaticRouting() } label: {
                        Label(automaticRouting ? "Retry Automatic Selection" : "Auto Balance", systemImage: "scalemass")
                    }
                    .disabled(!attachments.isEmpty)
                }
                Picker("Computer", selection: Binding(
                    get: { automaticRouting ? "" : executionProject?.environmentID ?? "" },
                    set: { selectEnvironment($0) }
                )) {
                    ForEach(creationEnvironments) { environment in
                        Text(environment.name).tag(environment.id)
                    }
                }
                .pickerStyle(.inline)
            } label: {
                ComposeCapsuleLabel(
                    title: title,
                    systemImage: symbol,
                    glyphTint: offline ? T3Colors.warning : T3Colors.textSecondary
                )
            }
            .buttonStyle(.plain)
            .disabled(isSubmitting)
            .accessibilityLabel("Computer")
            .accessibilityValue(title)
        } else {
            ComposeCapsuleLabel(
                title: title,
                systemImage: symbol,
                showsChevron: false,
                glyphTint: offline ? T3Colors.warning : T3Colors.textSecondary
            )
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Computer, \(title)")
        }
    }

    /// Current checkout or a new worktree, and for a worktree whether it
    /// starts from the latest origin, in one glass capsule menu.
    private var workspaceMenu: some View {
        Menu {
            Picker("Workspace", selection: Binding(
                get: { workspaceMode },
                set: { setWorkspaceMode($0) }
            )) {
                ForEach(FeatureWorkspaceMode.allCases, id: \.self) { mode in
                    Label(mode.title, systemImage: mode.systemImage).tag(mode)
                }
            }
            .pickerStyle(.inline)
            if workspaceMode == .worktree {
                Toggle("Start from Latest Origin", isOn: Binding(
                    get: { startFromOrigin },
                    set: { value in
                        makeRoutingManual()
                        workspaceSelectionIsExplicit = true
                        startFromOrigin = value
                    }
                ))
            }
        } label: {
            ComposeCapsuleLabel(
                title: workspaceMode.title,
                systemImage: branchLoadFailed ? "exclamationmark.triangle" : workspaceMode.systemImage,
                glyphTint: branchLoadFailed ? T3Colors.warning : T3Colors.textSecondary
            )
        }
        .buttonStyle(.plain)
        .disabled(isSubmitting)
        .accessibilityLabel("Workspace")
        .accessibilityValue(workspaceMode.title)
    }

    /// The branch: a picker for a new worktree's base, a plain label for the
    /// current checkout's branch.
    @ViewBuilder
    private var branchControl: some View {
        if workspaceMode == .worktree {
            Button {
                showingBranchPicker = true
            } label: {
                ComposeCapsuleLabel(
                    title: selectedBranch?.name ?? (branchesLoading ? "Loading Branches" : "Choose Branch"),
                    systemImage: "arrow.triangle.branch"
                )
            }
            .buttonStyle(.plain)
            .disabled(isSubmitting)
            .accessibilityLabel("Base branch")
            .accessibilityValue(selectedBranch?.name ?? "Not selected")
        } else if let selectedBranch {
            ComposeCapsuleLabel(
                title: selectedBranch.name,
                systemImage: "arrow.triangle.branch",
                showsChevron: false
            )
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Current branch, \(selectedBranch.name)")
        }
    }

    /// Why send is off, when it is. Mirrors `canSubmit` (minus the draft's own
    /// content, which the composer judges), so a send that would silently do
    /// nothing is always drawn disabled with its reason beside it. Waits that
    /// resolve on their own only explain themselves once there is something to
    /// send, so opening the sheet does not flash a row.
    private var sendBlocker: FeatureComposerSendBlocker? {
        guard !isSubmitting else { return nil }
        let hasContent = !trimmedPrompt.isEmpty || !attachments.isEmpty
        guard executionProject != nil else {
            return FeatureComposerSendBlocker("Choose a project to start a task.", systemImage: "folder")
        }
        if balancingMessage != nil {
            return FeatureComposerSendBlocker(
                "No eligible machine has capacity right now.",
                systemImage: "scalemass",
                actionTitle: "Retry Auto",
                action: retryAutomaticRouting
            )
        }
        if !executionEnvironmentConnected {
            return FeatureComposerSendBlocker("\(environmentName) is offline.", systemImage: "wifi.slash")
        }
        if needsBalancing || balancing {
            return FeatureComposerSendBlocker("Checking machines…", systemImage: "scalemass")
        }
        if restoredDraftProjectID != projectID {
            return hasContent ? FeatureComposerSendBlocker("Loading draft…", systemImage: "hourglass") : waitingBlocker
        }
        if effectiveWorkspaceMode == .worktree, branchLoadFailed, selectedBranch == nil {
            return FeatureComposerSendBlocker(
                "Couldn’t load branches.",
                systemImage: "exclamationmark.triangle",
                actionTitle: "Retry",
                action: { Task { await loadBranches(refresh: true) } }
            )
        }
        if branchesLoading {
            return hasContent ? FeatureComposerSendBlocker("Loading branches…", systemImage: "hourglass") : waitingBlocker
        }
        if effectiveWorkspaceMode == .worktree, selectedBranch == nil {
            return FeatureComposerSendBlocker(
                "Choose a base branch.",
                systemImage: "arrow.triangle.branch",
                actionTitle: "Choose Branch",
                action: { showingBranchPicker = true }
            )
        }
        if concreteSelection == nil {
            return FeatureComposerSendBlocker("Choose a model to start.", systemImage: "cpu")
        }
        return nil
    }

    /// A silent blocker for a short wait with nothing typed yet: send stays
    /// off without a row appearing and vanishing as the sheet opens.
    private var waitingBlocker: FeatureComposerSendBlocker? {
        FeatureComposerSendBlocker("")
    }

    private var noProjects: some View {
        ContentUnavailableView {
            Label("No Projects Yet", systemImage: "folder.badge.plus")
        } description: {
            Text("Tasks run in a project folder on one of your computers.")
        } actions: {
            Button("Create Project") {
                dismiss()
                Task { @MainActor in
                    await Task.yield()
                    onCreateProject()
                }
            }
            .t3ProminentButtonStyle()
        }
    }

    private var selectedProject: FeatureProject? {
        creationProjects.first { $0.id == projectID }
            ?? (routing?.projectID != nil ? model.snapshot.projects.first { $0.id == projectID } : nil)
    }

    /// Storage stays anchored to selectedProject; execution can move once without replacing a draft.
    private var executionProject: FeatureProject? {
        guard let targetID = routing?.projectID else { return selectedProject }
        return model.snapshot.projects.first { $0.id == targetID }
    }

    private var executionEnvironmentConnected: Bool {
        guard let project = executionProject,
              let environment = model.snapshot.environments.first(where: { $0.id == project.environmentID }) else { return false }
        return (environment.isActive ? model.snapshot.connection.state : environment.connectionState) == .connected
    }

    private var automaticRouting: Bool {
        loadBalancingEnabled && routing?.automatic != false && creationEnvironments.count > 1
            && (!workspaceSelectionIsExplicit || routing?.automatic == true)
            && (attachments.isEmpty || routing?.projectID != nil)
    }

    private var needsBalancing: Bool { automaticRouting && routing?.projectID == nil }

    private struct BalancingRequest: Equatable {
        let projectID: String
        let restored: Bool
        let needsBalancing: Bool
        let selection: FeatureSelection?
        let candidates: [FeatureProject]
        let weights: String
        let attempt: Int
    }

    private var balancingCandidates: [FeatureProject] {
        guard needsBalancing, let anchor = selectedProject, let selection,
              let provider = creationProviders.first(where: { $0.id == selection.providerID }) else { return [] }
        return NewTaskLoadBalancing.candidates(
            anchor: anchor, projects: creationProjects, environments: model.snapshot.environments,
            activeConnection: model.snapshot.connection.state, configs: model.client.workspaceServerConfigs(),
            selection: selection, driver: provider.driver,
            weights: NativeLoadBalancingPreferences.weights(from: loadBalancingWeightsJSON)
        )
    }

    private var balancingRequest: BalancingRequest {
        .init(projectID: projectID, restored: restoredDraftProjectID == projectID,
              needsBalancing: needsBalancing, selection: selection, candidates: balancingCandidates,
              weights: loadBalancingWeightsJSON, attempt: balancingAttempt)
    }

    private func makeRoutingManual() {
        routing = .init(automatic: false, projectID: routing?.projectID)
        balancing = false
        balancingMessage = nil
    }

    private func retryAutomaticRouting() {
        guard !isSubmitting, attachments.isEmpty else { return }
        routing = .init(automatic: true)
        workspaceSelectionIsExplicit = false
        branches = []
        selectedBranch = nil
        balancingAttempt += 1
    }

    @MainActor
    private func balanceEnvironment() async {
        let request = balancingRequest
        guard request.restored, request.needsBalancing, !isSubmitting else {
            balancing = false
            return
        }
        balancing = true
        balancingMessage = nil
        let client = model.client
        let weights = NativeLoadBalancingPreferences.weights(from: request.weights)
        let samples = await withTaskGroup(of: LoadBalancingCandidate.self) { group in
            for project in request.candidates {
                group.addTask { @MainActor in
                    let resources = try? await client.hostResources(environmentID: project.environmentID)
                    return LoadBalancingCandidate(environmentID: project.environmentID, resources: resources,
                        receivedAt: Date().timeIntervalSince1970 * 1000, weight: weights[project.environmentID] ?? 50)
                }
            }
            var values: [String: LoadBalancingCandidate] = [:]
            for await sample in group { values[sample.environmentID] = sample }
            // Keep a deterministic tie break, independent of network response order.
            return request.candidates.compactMap { values[$0.environmentID] }
        }
        guard !Task.isCancelled, balancingRequest == request, !isSubmitting else { return }
        balancing = false
        guard let environmentID = LoadBalancedEnvironment.choose(samples, now: Date().timeIntervalSince1970 * 1000),
              let project = request.candidates.first(where: { $0.environmentID == environmentID }) else {
            balancingMessage = "No eligible machine has available capacity. Choose a machine manually or retry Auto in the computer menu."
            return
        }
        branches = []
        selectedBranch = nil
        branchesLoading = true
        routing = .init(automatic: true, projectID: project.id)
    }

    private func projectMenuRow(_ project: FeatureProject) -> (title: String, detail: String?) {
        DailyUXCreationContext.projectMenuRow(for: project, in: creationEnvironments)
    }

    private var creationProjects: [FeatureProject] {
        DailyUXCreationContext.projects(
            in: model.snapshot,
            serverConfigs: model.client.workspaceServerConfigs()
        )
    }

    private var creationProjectIDs: [String] {
        creationProjects.map(\.id)
    }

    private var creationEnvironments: [FeatureEnvironment] {
        let environmentIDs = Set(creationProjects.map(\.environmentID))
        return model.snapshot.environments.filter { environmentIDs.contains($0.id) }
    }

    private var environmentName: String {
        if let environmentID = executionProject?.environmentID,
           let environment = model.snapshot.environments.first(where: { $0.id == environmentID }) {
            return environment.name
        }
        return model.snapshot.connection.environmentName ?? "this server"
    }

    private var initialSelection: FeatureSelection? {
        ProviderModelSelectionResolver.materialized(
            DailyUXCreationContext.initialSelection(
                for: executionProject,
                in: model.snapshot
            ),
            in: creationProviders
        )
    }

    private var environmentPreferences: FeatureEnvironmentPreferences {
        DailyUXCreationContext.environmentPreferences(
            for: executionProject,
            in: model.snapshot
        )
    }

    private var selectionBinding: Binding<FeatureSelection?> {
        Binding(
            get: { selection },
            set: { value in
                selectionIsExplicit = true
                var next = value
                if let project = executionProject {
                    if selection?.providerID != value?.providerID || selection?.modelID != value?.modelID {
                        next = projectMemoryStore.applyingFastMode(to: value, environmentID: project.environmentID)
                    } else {
                        projectMemoryStore.rememberFastMode(value, environmentID: project.environmentID)
                    }
                }
                selection = next
                preferredSelection = next
            }
        )
    }

    /// Model and provider capabilities belong to the project's environment,
    /// which may not be the connection currently selected in Settings.
    private var creationProviders: [FeatureProvider] {
        ProviderModelCatalogNormalizer.normalized(
            DailyUXCreationContext.providers(
                for: executionProject,
                in: model.snapshot
            )
        )
    }

    private var composerPowerFeatures: FeatureComposerPowerFeatures {
        let provider = creationProviders.first {
            $0.id == selection?.providerID
        }?.inWorkspace(executionProject?.path)
        // Keyed to the draft, not the project path scope: a dictation that
        // lands after the sheet closed waits for this same draft, and never
        // for New Work, New Chat or another project's task.
        let voiceScope = FeatureComposerVoiceScope.newTask(draftKey: currentDraftKey ?? draftID ?? "unscoped")
        guard let project = executionProject else {
            return FeatureComposerPowerFeatures(
                slashCommands: provider?.slashCommands ?? [],
                skills: provider?.skills ?? [],
                showSkillsInSlashMenu: model.snapshot.settings.showSkillsInSlashMenu,
                voiceScope: voiceScope
            )
        }
        return FeatureComposerPowerFeatures(
            slashCommands: provider?.slashCommands ?? [],
            skills: provider?.skills ?? [],
            showSkillsInSlashMenu: model.snapshot.settings.showSkillsInSlashMenu,
            pathSearchScopeID: project.id,
            searchPaths: { query in
                try await model.client.searchProjectFiles(
                    projectID: project.id,
                    query: query,
                    limit: 20
                ).map(Self.composerPathEntry)
            },
            voiceScope: voiceScope
        )
    }

    private static func composerPathEntry(_ entry: FeatureFileEntry) -> FeatureComposerPathEntry {
        FeatureComposerPathEntry(
            path: entry.path,
            kind: entry.kind == .directory ? .directory : .file
        )
    }

    private var canSubmit: Bool {
        !isSubmitting
            && executionProject != nil
            && !needsBalancing
            && !balancing
            && !branchesLoading
            && executionEnvironmentConnected
            && restoredDraftProjectID == projectID
            && concreteSelection != nil
            && (!trimmedPrompt.isEmpty || !attachments.isEmpty)
            && (attachments.isEmpty || imagesAllowed)
            && (effectiveWorkspaceMode != .worktree || selectedBranch != nil)
    }

    /// The selected project is the server's Hermes backing project — the one
    /// sitting on its configured `t3WorkDirectory`. Work conversations are
    /// directory-based, so every worktree affordance and parameter drops out.
    private var isWorkConversation: Bool {
        guard let project = executionProject else { return false }
        return model.client.workspaceServerConfigs().contains { config in
            config.environmentID == project.environmentID
                && config.t3WorkDirectory == project.path
        }
    }

    /// Work always resolves to the current checkout; a server-configured
    /// worktree default would otherwise leave the send gate permanently off.
    private var effectiveWorkspaceMode: FeatureWorkspaceMode {
        MobileWorkspaceRouting.resolveDraftWorkspaceMode(
            isWorkConversation: isWorkConversation,
            requestedMode: workspaceMode
        )
    }

    private var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var imagesAllowed: Bool {
        DailyUXModelOptions.supportsImages(
            selection: concreteSelection,
            providers: creationProviders
        )
    }

    private var concreteSelection: FeatureSelection? {
        ProviderModelSelectionResolver.materialized(selection, in: creationProviders)
    }

    private func startTask() {
        guard canSubmit,
              let project = executionProject,
              let concreteSelection else {
            return
        }
        promptFocused = false
        isSubmitting = true
        let pendingDraftSaveTask = draftSaveTask
        pendingDraftSaveTask?.cancel()
        draftSaveTask = nil
        let draftKey = currentDraftKey
        let draftSnapshot = composerDraft
        let immediateDraftSaveTask = draftKey.flatMap {
            immediateDraftSaveTasks.removeValue(forKey: $0)
        }
        let request = NewTaskRequest(
            projectID: project.id,
            prompt: trimmedPrompt,
            selection: concreteSelection,
            runtimeMode: .fullAccess,
            interactionMode: interactionMode,
            workspaceMode: effectiveWorkspaceMode,
            branch: isWorkConversation ? nil : selectedBranch?.name,
            worktreePath: !isWorkConversation && effectiveWorkspaceMode == .local
                ? NewTaskWorkspaceDefaults.normalizedWorktreePath(
                    for: selectedBranch,
                    projectPath: project.path
                )
                : nil,
            startFromOrigin: isWorkConversation ? false : startFromOrigin,
            attachments: attachments
        )

        Task { @MainActor in
            await NewTaskDraftWriteFence.cancelAndWait(pendingDraftSaveTask)
            await NewTaskDraftWriteFence.cancelAndWait(immediateDraftSaveTask)
            if let draftKey {
                try? await draftStore.setDraft(draftSnapshot, for: draftKey)
            }
            if let thread = await submit(request) {
                submittedSuccessfully = true
                let trailingDraftSaveTask = draftSaveTask
                draftSaveTask = nil
                await NewTaskDraftWriteFence.cancelAndWait(trailingDraftSaveTask)
                if let draftKey {
                    let trailingSave = immediateDraftSaveTasks.removeValue(forKey: draftKey)
                    await NewTaskDraftWriteFence.cancelAndWait(trailingSave)
                    try? await draftStore.removeDraft(for: draftKey)
                }
                onCreated(thread)
            } else {
                isSubmitting = false
                submissionFailed = true
                promptFocused = true
            }
        }
    }

    private func selectProject(_ id: String) {
        if id == executionProject?.id { makeRoutingManual(); return }
        guard id != projectID else {
            routing = .init(automatic: false)
            branches = []
            selectedBranch = nil
            branchesLoading = true
            Task { await loadBranches() }
            return
        }
        persistCurrentDraftImmediately()
        projectID = id
        prepareProjectIfNeeded(id)
        routing = .init(automatic: false)
    }

    private func selectEnvironment(_ id: String) {
        if executionProject?.environmentID == id { makeRoutingManual(); return }
        let project = projectMemory.rememberedProjectID(forEnvironment: id).flatMap { recentID in
            creationProjects.first { $0.id == recentID && $0.environmentID == id }
        } ?? creationProjects.first { $0.environmentID == id }
        guard let project else { return }
        selectProject(project.id)
    }

    private func selectInitialProject(_ id: String) {
        projectID = id
        prepareProjectIfNeeded(id)
    }

    private func prepareProjectIfNeeded(_ id: String) {
        guard draftRestoreContext?.projectID != id else { return }

        if selectionIsExplicit, let selection {
            preferredSelection = selection
        }

        routing = nil
        balancing = false
        balancingMessage = nil
        restoredDraftProjectID = nil
        draftSaveTask?.cancel()
        draftSaveTask = nil
        prompt = ""
        attachments = []
        selectionIsExplicit = false
        workspaceSelectionIsExplicit = false
        branches = []
        selectedBranch = nil
        branchLoadFailed = false
        branchesLoading = false

        guard let project = creationProjects.first(where: { $0.id == id }) else {
            selection = nil
            workspaceMode = .local
            startFromOrigin = true
            draftRestoreContext = nil
            return
        }

        projectMemory.record(projectID: project.id, environmentID: project.environmentID)
        projectMemoryStore.record(projectID: project.id, environmentID: project.environmentID)

        let providers = ProviderModelCatalogNormalizer.normalized(
            DailyUXCreationContext.providers(for: project, in: model.snapshot)
        )
        let carriedSelection = DailyUXModelOptions.validated(preferredSelection, in: providers)
        selection = ProviderModelSelectionResolver.materialized(
            DailyUXCreationContext.selection(
                carrying: preferredSelection,
                to: project,
                in: model.snapshot
            ),
            in: providers
        )
        selection = projectMemoryStore.applyingFastMode(to: selection, environmentID: project.environmentID)
        selectionIsExplicit = carriedSelection != nil
        let preferences = DailyUXCreationContext.environmentPreferences(
            for: project,
            in: model.snapshot
        )
        workspaceMode = preferences.defaultWorkspaceMode
        startFromOrigin = preferences.newWorktreesStartFromOrigin
        draftRestoreContext = NewTaskDraftRestoreContext(
            projectID: id,
            baseline: FeatureComposerDraft()
        )
    }

    private func setWorkspaceMode(_ mode: FeatureWorkspaceMode) {
        makeRoutingManual()
        workspaceSelectionIsExplicit = true
        workspaceMode = mode
        selectedBranch = switch mode {
        case .local: NewTaskWorkspaceDefaults.localBranch(in: branches)
        case .worktree: NewTaskWorkspaceDefaults.worktreeBase(in: branches)
        }
    }

    @MainActor
    private func loadBranches(refresh: Bool = false) async {
        let requestedProjectID = executionProject?.id ?? ""
        guard !requestedProjectID.isEmpty else { return }

        branchesLoading = true
        branchLoadFailed = false
        do {
            let loaded = try await model.workspaceBranches(
                projectID: requestedProjectID,
                refresh: refresh
            )
            guard !Task.isCancelled, executionProject?.id == requestedProjectID else { return }
            branches = loaded.sorted(by: Self.branchSort)

            if let selectedBranch,
               let updated = branches.first(where: { $0.name == selectedBranch.name }) {
                self.selectedBranch = updated
            } else {
                self.selectedBranch = switch workspaceMode {
                case .local: NewTaskWorkspaceDefaults.localBranch(in: branches)
                case .worktree: NewTaskWorkspaceDefaults.worktreeBase(in: branches)
                }
            }
        } catch is CancellationError {
            return
        } catch {
            guard executionProject?.id == requestedProjectID else { return }
            branchLoadFailed = true
        }
        guard executionProject?.id == requestedProjectID else { return }
        branchesLoading = false
    }

    @MainActor
    private func restoreDraftAndLoadBranches() async {
        let requestedProjectID = projectID
        guard let project = selectedProject,
              let context = draftRestoreContext,
              context.projectID == requestedProjectID,
              !requestedProjectID.isEmpty else {
            return
        }
        let key = FeatureComposerDraftStore.newTaskKey(project: project, draftID: draftID)
        let pendingImmediateSave = immediateDraftSaveTasks[key]
        await NewTaskDraftWriteFence.wait(pendingImmediateSave)
        guard !Task.isCancelled,
              projectID == requestedProjectID,
              draftRestoreContext?.projectID == requestedProjectID else {
            return
        }
        let saved = try? await draftStore.draft(for: key)
        guard !Task.isCancelled,
              projectID == requestedProjectID,
              draftRestoreContext?.projectID == requestedProjectID else {
            return
        }

        let liveDraft = composerDraft
        let liveSelectionIsExplicit = selectionIsExplicit
        let liveWorkspaceSelectionIsExplicit = workspaceSelectionIsExplicit
        let restored = context.merging(
            saved: saved,
            current: liveDraft,
            fallbackSelection: initialSelection,
            fallbackWorkspace: FeatureComposerWorkspaceDraft(
                mode: environmentPreferences.defaultWorkspaceMode,
                branch: nil,
                worktreePath: nil,
                startFromOrigin: environmentPreferences.newWorktreesStartFromOrigin
            )
        )
        routing = restored.routing
        if routing == nil, saved?.workspace != nil { routing = .init(automatic: false) }
        prompt = restored.text
        attachments = restored.attachments
        selection = DailyUXModelOptions.validated(restored.selection, in: creationProviders)
            ?? initialSelection
        selectionIsExplicit = liveSelectionIsExplicit || saved?.selection != nil
        if selectionIsExplicit, let selection {
            preferredSelection = selection
        }
        if let workspace = restored.workspace {
            workspaceMode = workspace.mode
            selectedBranch = workspace.branch.map {
                FeatureWorkspaceBranch(
                    name: $0,
                    worktreePath: workspace.worktreePath
                )
            }
            startFromOrigin = workspace.startFromOrigin
        }
        workspaceSelectionIsExplicit = liveWorkspaceSelectionIsExplicit
            || saved?.workspace != nil
        restoredDraftProjectID = requestedProjectID
        if liveDraft != context.baseline {
            scheduleDraftSave()
        }
        // Like Mail and Messages, the sheet opens ready to type — once the
        // draft is in the field, so the caret lands after the restored text.
        if !didFocusPrompt {
            didFocusPrompt = true
            promptFocused = true
        }
        await loadBranches()
    }

    private var currentDraftKey: String? {
        guard let project = selectedProject else { return nil }
        return FeatureComposerDraftStore.newTaskKey(project: project, draftID: draftID)
    }

    private var composerDraft: FeatureComposerDraft {
        FeatureComposerDraft(
            text: prompt,
            attachments: attachments,
            selection: selectionIsExplicit || routing?.projectID != nil ? selection : nil,
            workspace: workspaceSelectionIsExplicit
                ? FeatureComposerWorkspaceDraft(
                    mode: workspaceMode,
                    branch: selectedBranch?.name,
                    worktreePath: workspaceMode == .local
                        ? NewTaskWorkspaceDefaults.normalizedWorktreePath(
                            for: selectedBranch,
                            projectPath: executionProject?.path ?? ""
                        )
                        : nil,
                    startFromOrigin: startFromOrigin
                )
                : nil,
            routing: routing
        )
    }

    private func scheduleDraftSave() {
        guard !isSwappingDraft, restoredDraftProjectID == projectID,
              !isSubmitting,
              !submittedSuccessfully,
              let key = currentDraftKey else {
            return
        }
        let pendingDraftSaveTask = draftSaveTask
        pendingDraftSaveTask?.cancel()
        draftSaveTask = nil
        let snapshot = composerDraft
        draftSaveTask = Task {
            await NewTaskDraftWriteFence.wait(pendingDraftSaveTask)
            do {
                try await Task.sleep(for: .milliseconds(220))
                try Task.checkCancellation()
                try await draftStore.setDraft(snapshot, for: key)
            } catch is CancellationError {
                return
            } catch {
                return
            }
        }
    }

    private func persistCurrentDraftImmediately() {
        guard !isSwappingDraft, !submittedSuccessfully,
              let key = currentDraftKey else {
            return
        }
        let pendingDraftSaveTask = draftSaveTask
        pendingDraftSaveTask?.cancel()
        draftSaveTask = nil
        let snapshot = composerDraft
        let restoreContext = draftRestoreContext
        let draftProjectID = projectID
        let needsRestoreMerge = restoredDraftProjectID != draftProjectID
        let previousSave = immediateDraftSaveTasks[key]
        previousSave?.cancel()
        let task = Task { @MainActor in
            await NewTaskDraftWriteFence.wait(pendingDraftSaveTask)
            await NewTaskDraftWriteFence.wait(previousSave)
            guard !Task.isCancelled else { return }
            if needsRestoreMerge,
               let restoreContext,
               restoreContext.projectID == draftProjectID {
                let saved = try? await draftStore.draft(for: key)
                guard !Task.isCancelled else { return }
                let merged = restoreContext.merging(saved: saved, current: snapshot)
                try? await draftStore.setDraft(merged, for: key)
            } else {
                try? await draftStore.setDraft(snapshot, for: key)
            }
        }
        immediateDraftSaveTasks[key] = task
    }

    private static func branchSort(
        _ lhs: FeatureWorkspaceBranch,
        _ rhs: FeatureWorkspaceBranch
    ) -> Bool {
        let lhsRank = lhs.isCurrent ? 0 : lhs.isDefault ? 1 : lhs.isRemote ? 3 : 2
        let rhsRank = rhs.isCurrent ? 0 : rhs.isDefault ? 1 : rhs.isRemote ? 3 : 2
        if lhsRank != rhsRank { return lhsRank < rhsRank }
        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
    }
}

enum NewTaskDraftWriteFence {
    static func wait(_ task: Task<Void, Never>?) async {
        await task?.value
    }

    static func cancelAndWait(_ task: Task<Void, Never>?) async {
        task?.cancel()
        await task?.value
    }
}

/// Captures the clean target-project state before its persisted draft is read.
/// Async restore results can then merge live typing without ever borrowing state
/// from the project that was previously selected.
struct NewTaskDraftRestoreContext: Equatable {
    let projectID: String
    let baseline: FeatureComposerDraft

    func merging(
        saved: FeatureComposerDraft?,
        current: FeatureComposerDraft,
        fallbackSelection: FeatureSelection? = nil,
        fallbackWorkspace: FeatureComposerWorkspaceDraft? = nil
    ) -> FeatureComposerDraft {
        FeatureComposerDraftRestoration.merge(
            saved: saved,
            baseline: baseline,
            current: current,
            fallbackSelection: fallbackSelection,
            fallbackWorkspace: fallbackWorkspace
        )
    }
}

/// The base branch for a new worktree: a floating glass sheet on iOS 26,
/// searchable, with pull to refresh.
private struct NewTaskBranchPicker: View {
    let branches: [FeatureWorkspaceBranch]
    let selection: FeatureWorkspaceBranch?
    let isLoading: Bool
    let loadFailed: Bool
    let onSelect: (FeatureWorkspaceBranch) -> Void
    let onRefresh: () -> Void

    @State private var query = ""

    var body: some View {
        NavigationStack {
            Group {
                if isLoading, branches.isEmpty {
                    ProgressView("Loading branches")
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if loadFailed, branches.isEmpty {
                    ContentUnavailableView {
                        Label("Branches Unavailable", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text("Check the connection and try again.")
                    } actions: {
                        Button("Try Again", action: onRefresh)
                            .buttonStyle(.bordered)
                    }
                } else if filteredBranches.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else {
                    List(filteredBranches) { branch in
                        row(branch)
                    }
                    .listStyle(.insetGrouped)
                    .t3SheetListBackground()
                    .refreshable { onRefresh() }
                }
            }
            .navigationTitle("Base Branch")
            .navigationBarTitleDisplayMode(.inline)
            .t3Searchable(text: $query, prompt: Text("Search branches"))
            .t3SheetToolbar(.close)
            .t3NavigationChrome()
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .modifier(NewTaskBranchSheetBackground())
    }

    private func row(_ branch: FeatureWorkspaceBranch) -> some View {
        Button {
            PlatformHapticEngine.shared.playSelection()
            onSelect(branch)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "arrow.triangle.branch")
                    .foregroundStyle(T3Colors.textTertiary)
                    .accessibilityHidden(true)

                Text(branch.name)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer(minLength: 10)

                if let badge = branch.badge {
                    Text(badge)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(T3Colors.textSecondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(T3Colors.subtleStrong, in: Capsule())
                }

                if branch.id == selection?.id {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(T3Colors.accent)
                        .accessibilityLabel("Selected")
                }
            }
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .t3SheetRow()
    }

    private var filteredBranches: [FeatureWorkspaceBranch] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return branches }
        return branches.filter {
            $0.name.localizedCaseInsensitiveContains(trimmed)
        }
    }
}

/// iOS 26 floats a medium sheet as glass; a painted background would turn it
/// back into an opaque slab. Earlier systems keep the palette background.
private struct NewTaskBranchSheetBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
        } else {
            content.presentationBackground(T3Colors.background)
        }
    }
}
