import SwiftUI

struct PlatformRootView: View {
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @Bindable private var model: FeatureRootModel

    @State private var navigationRequest: FeatureWorkspaceNavigationRequest?
    @State private var pendingRoute: PlatformRoute?
    @State private var previousThreadStates: [String: FeatureThreadState]?
    @State private var lastNotificationPreference: Bool?
    @State private var incomingShareCoordinator = PlatformIncomingShareCoordinator()
    @State private var incomingShareNeedsProject = false
    @State private var importedShareProjectID: String?
    @State private var pairingLink: PlatformPairingLink?

    init(model: FeatureRootModel) {
        self.model = model
    }

    var body: some View {
        FeatureRootView(
            model: model,
            navigationRequest: navigationRequest,
            onNavigationRequestConsumed: { requestID in
                guard navigationRequest?.id == requestID else { return }
                navigationRequest = nil
            }
        )
        .onOpenURL { url in
            handle(url: url, letOnboardingConfirmConnection: true)
        }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            guard let url = activity.webpageURL else { return }
            handle(url: url, letOnboardingConfirmConnection: false)
        }
        .onReceive(NotificationCenter.default.publisher(for: .platformRouteReceived)) { note in
            // A notification tap leaves its route in the mailbox, which hands it
            // out once however many of these paths wake for it. In-app posts
            // carry theirs in `userInfo`.
            guard let route = PlatformRouteMailbox.shared.take()
                ?? note.userInfo?["route"] as? PlatformRoute else { return }
            handle(route)
        }
        .onChange(of: model.isLoading, initial: true) { _, isLoading in
            guard !isLoading else { return }
            processThreadChanges()
            synchronizeNotificationPreference()
            synchronizeCloudDelivery()
            consumePendingRouteIfPossible()
            consumeMailboxRouteIfAvailable()
            refreshIncomingShares()
        }
        .onChange(of: model.homePresentationRevision) { _, _ in
            processThreadChanges()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                consumeMailboxRouteIfAvailable()
                synchronizeNotificationPreference()
                synchronizeCloudDelivery()
                refreshIncomingShares()
            } else if phase == .background {
                PlatformBackgroundRefreshCoordinator.shared.schedule()
            }
        }
        .onChange(of: model.snapshot.settings.notificationsEnabled) { _, _ in
            synchronizeNotificationPreference()
            synchronizeCloudDelivery()
        }
        .onChange(of: notificationEventPreferences) { _, _ in
            synchronizeCloudDelivery()
        }
        .onChange(of: model.snapshot.settings.liveActivitiesEnabled) { _, _ in
            synchronizeAgentAwareness()
            synchronizeCloudDelivery()
        }
        .onChange(of: model.snapshot.settings.hapticsEnabled, initial: true) { _, isEnabled in
            PlatformHapticEngine.shared.isEnabled = isEnabled
        }
        .environment(\.t3HapticsEnabled, model.snapshot.settings.hapticsEnabled)
        .onChange(of: model.snapshot.projects.map(\.id)) { _, _ in
            refreshIncomingShares()
        }
        .sheet(item: presentedIncomingShare, onDismiss: openImportedShareDraft) { envelope in
            PlatformIncomingShareDestinationSheet(
                envelope: envelope,
                projects: incomingShareProjects,
                environments: model.snapshot.environments,
                isImporting: incomingShareCoordinator.isImporting,
                importingProjectID: importedShareProjectID,
                onCancel: incomingShareCoordinator.dismissDestination,
                onSelect: importIncomingShare(into:)
            )
        }
        .sheet(item: $pairingLink) { link in
            ConnectionOnboardingView(
                model: model,
                presentation: .link(link.details),
                onConnected: {
                    PlatformHapticEngine.shared.play(.success)
                },
                onClose: { pairingLink = nil }
            )
            .presentationDetents([.medium, .large])
        }
        .alert("Create a project to continue", isPresented: $incomingShareNeedsProject) {
            Button("Not now", role: .cancel) {}
            Button("Create project") {
                navigationRequest = FeatureWorkspaceNavigationRequest(
                    destination: .newTask(projectID: nil)
                )
            }
        } message: {
            Text("Your share is saved. Connect an environment and create a project to finish importing it.")
        }
    }

    private var incomingShareProjects: [FeatureProject] {
        DailyUXCreationContext.projects(
            in: model.snapshot,
            serverConfigs: model.client.workspaceServerConfigs()
        ).sorted {
            if $0.name.localizedStandardCompare($1.name) == .orderedSame {
                return $0.environmentID < $1.environmentID
            }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }

    private var presentedIncomingShare: Binding<T3IncomingShareEnvelope?> {
        Binding(
            get: {
                guard !incomingShareProjects.isEmpty else { return nil }
                return incomingShareCoordinator.pendingEnvelope
            },
            set: { value in
                guard value == nil, importedShareProjectID == nil else { return }
                incomingShareCoordinator.dismissDestination()
            }
        )
    }

    private var shouldShowWorkspace: Bool {
        FeatureRootPresentation.showsWorkspace(
            snapshot: model.snapshot,
            isManagingConnections: model.isManagingConnections
        )
    }

    private func handle(url: URL, letOnboardingConfirmConnection: Bool) {
        do {
            let route = try PlatformDeepLinkParser.parse(url)
            if case .connection = route,
               letOnboardingConfirmConnection,
               ConnectionOnboardingLinks.areHandledByOnboarding {
                // A visible onboarding page confirms opened pairing links itself.
                return
            }
            handle(route)
        } catch {
            model.reportFailure(error.localizedDescription, title: "Couldn't Open Link")
        }
    }

    private func handle(_ route: PlatformRoute) {
        guard !model.isLoading else {
            pendingRoute = route
            return
        }
        Task { @MainActor in
            await consume(route)
        }
    }

    private func consumePendingRouteIfPossible() {
        guard let route = pendingRoute else { return }
        pendingRoute = nil
        handle(route)
    }

    private func consumeMailboxRouteIfAvailable() {
        guard !model.isLoading, let route = PlatformRouteMailbox.shared.take() else { return }
        handle(route)
    }

    private func synchronizeNotificationPreference() {
        guard !model.isLoading else { return }
        let preference = model.snapshot.settings.notificationsEnabled
        let previous = lastNotificationPreference
        lastNotificationPreference = preference

        Task {
            let authorized: Bool
            if preference, previous == false {
                // The model changes only after Settings is explicitly saved.
                authorized = await PlatformNotificationService.shared.requestAuthorization()
            } else {
                authorized = await PlatformNotificationService.shared.synchronize(enabled: preference)
            }
            guard preference, !authorized, model.snapshot.settings.notificationsEnabled else {
                return
            }

            // Keep the app toggle honest when authorization is absent or revoked.
            var settings = model.snapshot.settings
            settings.notificationsEnabled = false
            await model.saveSettings(settings)
        }
    }

    /// The relay filters pushes by these too, so a change re-registers.
    private var notificationEventPreferences: [Bool] {
        let settings = model.snapshot.settings
        return [settings.notifyOnAttention, settings.notifyOnCompletion, settings.notifyOnFailure]
    }

    private func synchronizeCloudDelivery() {
        guard !model.isLoading else { return }
        PlatformCloudDeliveryCoordinator.shared.synchronize(
            settings: model.snapshot.settings
        )
    }

    private func refreshIncomingShares() {
        guard !model.isLoading else { return }
        let hasProjects = !incomingShareProjects.isEmpty
        Task { @MainActor in
            if await incomingShareCoordinator.refresh(hasProjects: hasProjects) {
                incomingShareNeedsProject = true
            }
        }
    }

    private func importIncomingShare(into project: FeatureProject) {
        guard !incomingShareCoordinator.isImporting else { return }
        importedShareProjectID = project.id
        Task { @MainActor in
            do {
                try await incomingShareCoordinator.importPending(into: project)
            } catch {
                importedShareProjectID = nil
                model.reportFailure(error.localizedDescription, title: "Couldn't Import Share")
            }
        }
    }

    private func openImportedShareDraft() {
        guard let projectID = importedShareProjectID else { return }
        importedShareProjectID = nil
        navigationRequest = FeatureWorkspaceNavigationRequest(
            destination: .newTask(projectID: projectID)
        )
        PlatformHapticEngine.shared.emit(
            .success,
            enabled: model.snapshot.settings.hapticsEnabled
        )
    }

    @MainActor
    private func consume(_ route: PlatformRoute) async {
        switch route {
        case let .connection(endpoint, token):
            // Never pair silently from a link: Confirm Connection shows the
            // server and code first, the same page onboarding uses.
            pairingLink = PlatformPairingLink(
                details: ConnectionDetails(endpoint: endpoint, pairingCode: token)
            )
        case let .environment(id):
            guard await activateEnvironmentIfNeeded(id) else { return }
            PlatformHapticEngine.shared.selection(
                enabled: model.snapshot.settings.hapticsEnabled
            )
        case let .thread(environmentID, threadID):
            guard await activateEnvironmentIfNeeded(environmentID) else { return }
            let resolvedID = PlatformRouteResolver.thread(
                in: model.snapshot,
                environmentID: environmentID,
                id: threadID
            )?.id
            // A thread named by a notification can be newer than the snapshot,
            // such as one started on the computer while the phone slept. With
            // its environment known, Home holds the request until it arrives.
            let fallbackID = environmentID.map {
                FeatureScopedID.thread(environmentID: $0, wireID: threadID)
            }
            guard let id = resolvedID ?? fallbackID else {
                if model.errorMessage == nil {
                    model.reportFailure("That thread is not available on this device.", title: "Couldn't Open Thread")
                }
                return
            }
            navigationRequest = FeatureWorkspaceNavigationRequest(
                destination: .thread(id: id)
            )
            PlatformHapticEngine.shared.selection(
                enabled: model.snapshot.settings.hapticsEnabled
            )
        case let .project(environmentID, projectID):
            guard await activateEnvironmentIfNeeded(environmentID),
                  let project = PlatformRouteResolver.project(
                      in: model.snapshot,
                      environmentID: environmentID,
                      id: projectID
                  )
            else {
                if model.errorMessage == nil {
                    model.reportFailure("That project is not available on this device.", title: "Couldn't Open Project")
                }
                return
            }
            navigationRequest = FeatureWorkspaceNavigationRequest(
                destination: .project(id: project.id)
            )
            PlatformHapticEngine.shared.selection(
                enabled: model.snapshot.settings.hapticsEnabled
            )
        case let .newTask(environmentID, projectID):
            guard await activateEnvironmentIfNeeded(environmentID) else { return }
            let resolvedProject = projectID.flatMap {
                PlatformRouteResolver.project(
                    in: model.snapshot,
                    environmentID: environmentID,
                    id: $0
                )
            }
            if projectID != nil, resolvedProject == nil {
                model.reportFailure("That project is not available on this device.", title: "Couldn't Start Task")
                return
            }
            navigationRequest = FeatureWorkspaceNavigationRequest(
                destination: .newTask(projectID: resolvedProject?.id)
            )
            PlatformHapticEngine.shared.selection(
                enabled: model.snapshot.settings.hapticsEnabled
            )
        }
    }

    @MainActor
    private func activateEnvironmentIfNeeded(_ id: String?) async -> Bool {
        guard let id else { return true }
        guard let environment = model.snapshot.environments.first(where: { $0.id == id }) else {
            model.reportFailure("That environment is not saved on this device.", title: "Couldn't Open Link")
            return false
        }
        guard !environment.isActive else { return true }
        await model.activateEnvironment(id)
        return model.snapshot.environments.contains { $0.id == id && $0.isActive }
    }

    /// Home revisions are coalesced by FeatureRootModel, so this performs one
    /// bounded scan per meaningful snapshot change rather than on every render.
    private func processThreadChanges() {
        let current = model.snapshot.threads.reduce(into: [String: FeatureThreadState]()) {
            $0[$1.id] = $1.state
        }
        let signals = PlatformThreadTransitionClassifier.signals(
            previous: previousThreadStates,
            current: model.snapshot.threads
        )
        previousThreadStates = current
        PlatformRecentThreadStore.shared.update(from: model.snapshot.threads)
        synchronizeAgentAwareness()

        for signal in signals {
            if scenePhase == .active {
                PlatformHapticEngine.shared.emit(
                    signal.kind,
                    enabled: model.snapshot.settings.hapticsEnabled
                )
            } else if model.snapshot.settings.notifies(signal.kind) {
                Task { await PlatformNotificationService.shared.schedule(signal) }
            }
        }
    }

    private func synchronizeAgentAwareness() {
        PlatformAgentAwarenessCoordinator.shared.synchronize(
            snapshot: model.snapshot,
            liveActivitiesEnabled: model.snapshot.settings.liveActivitiesEnabled
        )
    }
}

/// A pairing link waiting for the user to confirm it.
private struct PlatformPairingLink: Identifiable {
    let id = UUID()
    let details: ConnectionDetails
}
