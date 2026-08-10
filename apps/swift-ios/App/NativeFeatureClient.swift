import ClerkKit
import Foundation

extension FeatureInputAnswer {
    var jsonValue: JSONValue {
        switch self {
        case let .text(value):
            .string(value)
        case let .selections(values):
            .array(values.map(JSONValue.string))
        }
    }
}

/// Composes the transport-focused Core layer with the UI-focused Features layer.
@MainActor
final class NativeFeatureClient: FeatureClient, FeatureDeviceManaging,
    FeatureProjectCreationClient, FeatureWorkspaceAssetResolving,
    FeatureProjectFaviconResolving, FeatureThreadRoleAssigning, FeatureUsageReading,
    T3ConnectCapable
{
    /// Visible turn items requested on a cold load. The server reports what it
    /// withheld, and "load earlier" refetches without a window.
    private static let initialThreadVisibleItemLimit = 60

    private let runtime: EnvironmentRuntime
    let t3ConnectController: T3ConnectController
    private let hasMatchingT3ConnectController: Bool
    private let settingsStore: UserDefaults
    private let fallbackPollingInitialDelay: Duration
    private let fallbackPollingInterval: Duration
    private let aggregateRefreshInterval: Duration
    private let environmentShellTimeoutInterval: TimeInterval
    private let aggregateEnvironmentLoader: @Sendable (EnvironmentRuntime) async throws -> [Environment]
    private let stream: AsyncStream<FeatureEvent>
    private let continuation: AsyncStream<FeatureEvent>.Continuation

    private var activeEnvironment: Environment?
    private var client: T3Client?
    private var latestShell: OrchestrationV2ShellSnapshot?
    private var environmentClients: [String: T3Client] = [:]
    private var shellsByEnvironmentID: [String: OrchestrationV2ShellSnapshot] = [:]
    private var archivedThreadsByEnvironmentID: [String: [FeatureThread]] = [:]
    private var archivedShellThreadsByEnvironmentID: [
        String: [String: OrchestrationV2ThreadShell]
    ] = [:]
    private var projectEnvironmentIDs: [String: String] = [:]
    private var projectWireIDs: [String: String] = [:]
    /// `previewUrl` from each project's checked-in `t3.json`, keyed by the
    /// project's feature id. Read from the workspace rather than the shell
    /// snapshot: the file belongs to the repository, not to T3's database.
    private var pinnedPreviewURLs: [String: String] = [:]
    private var probedPreviewURLProjectIDs: Set<String> = []
    private var pinnedPreviewURLTasks: [String: Task<Void, Never>] = [:]
    private var threadEnvironmentIDs: [String: String] = [:]
    private var threadWireIDs: [String: String] = [:]
    private var provisionalThreadRoutes: [String: ProvisionalThreadRoute] = [:]
    private var environmentConnectionStates: [String: FeatureConnection.State] = [:]
    private var environmentConnectionDetails: [String: String] = [:]
    private var latestServerConfig: ServerConfigSnapshot?
    private var serverConfigsByEnvironmentID: [String: ServerConfigSnapshot] = [:]
    private var latestSnapshot: FeatureSnapshot?
    private var activeThreadID: String?
    private var activeThreadEnvironmentID: String?
    private var latestDetails: [String: FeatureThreadDetail] = [:]
    private var attachmentURLs: [AttachmentCacheKey: CachedAttachmentURL] = [:]
    private var pendingBootstrapSubmissions: [PendingBootstrapSubmission] = []
    private var pendingTurnSubmissions: [String: PendingTurnSubmission] = [:]
    private var attachmentHydrationTasks: [
        String: (id: UUID, task: Task<Void, Never>)
    ] = [:]
    private var approvalRoutes: [String: PendingRequestRoute] = [:]
    private var inputRoutes: [String: PendingRequestRoute] = [:]
    private struct TerminalKey: Hashable {
        let threadID: String
        let terminalID: String
    }

    private var terminalSnapshots: [TerminalKey: FeatureTerminalSnapshot] = [:]
    private var pollingTask: Task<Void, Never>?
    private var fallbackPollingTask: Task<Void, Never>?
    private var configurationTask: Task<Void, Never>?
    private var aggregateRefreshTask: Task<Void, Never>?
    private var aggregateRefreshID: UUID?
    private var shellPublishTask: Task<Void, Never>?
    private var archivedRefreshTask: Task<Void, Never>?
    private var detailRefreshTask: Task<Void, Never>?
    private var detailStreamTask: Task<Void, Never>?
    private var detailPublishTask: Task<Void, Never>?
    private var passiveDetailPollingTask: Task<Void, Never>?
    private var detailRefreshPending = false
    private var detailRefreshGeneration = 0
    private var detailStreamGeneration = 0
    private var environmentGeneration = 0
    private var lastShellEventAt: Date?
    private var activeRawThread: OrchestrationV2ThreadProjection?
    private var activeThreadSequence: Int?
    private var activeThreadPage: FeatureThreadPage?
    private var threadHistoryEpoch = 0

    init(
        runtime: EnvironmentRuntime? = nil,
        t3ConnectController: T3ConnectController? = nil,
        settingsStore: UserDefaults = .standard,
        fallbackPollingInitialDelay: Duration = .seconds(3),
        fallbackPollingInterval: Duration = .seconds(2),
        aggregateRefreshInterval: Duration = .seconds(20),
        environmentShellTimeoutInterval: TimeInterval = 6,
        aggregateEnvironmentLoader: @escaping @Sendable (EnvironmentRuntime) async throws -> [Environment] = {
            try await $0.environments()
        }
    ) {
        let controller: T3ConnectController
        if let t3ConnectController {
            controller = t3ConnectController
        } else if let runtime {
            controller = T3ConnectController(
                resolution: .unavailable(
                    reason: runtime.supportsManagedAuthorization
                        ? "This client runtime requires its matching T3 Connect controller."
                        : "This client runtime was created without T3 Connect authorization."
                )
            )
        } else {
            controller = T3ConnectController()
        }
        self.t3ConnectController = controller
        hasMatchingT3ConnectController = t3ConnectController != nil || runtime == nil
        self.runtime = runtime ?? EnvironmentRuntime(
            managedAuthorization: T3ConnectRuntimeAuthorization(controller: controller)
        )
        self.settingsStore = settingsStore
        self.fallbackPollingInitialDelay = fallbackPollingInitialDelay
        self.fallbackPollingInterval = fallbackPollingInterval
        self.aggregateRefreshInterval = aggregateRefreshInterval
        self.environmentShellTimeoutInterval = environmentShellTimeoutInterval
        self.aggregateEnvironmentLoader = aggregateEnvironmentLoader
        let pair = AsyncStream<FeatureEvent>.makeStream()
        stream = pair.stream
        continuation = pair.continuation
        // Voice Input is account state on the relay, not environment state, so
        // the composer cannot reach it through a thread's environment. Publish
        // the capability once here; the registry holds it weakly.
        FeatureVoiceCapability.register(self)
    }

    deinit {
        pollingTask?.cancel()
        fallbackPollingTask?.cancel()
        configurationTask?.cancel()
        aggregateRefreshTask?.cancel()
        shellPublishTask?.cancel()
        archivedRefreshTask?.cancel()
        detailRefreshTask?.cancel()
        detailStreamTask?.cancel()
        detailPublishTask?.cancel()
        passiveDetailPollingTask?.cancel()
        attachmentHydrationTasks.values.forEach { $0.task.cancel() }
        continuation.finish()
    }

    func initialSnapshot() async throws -> FeatureSnapshot {
        let environments = try await runtime.environments()
        guard let activeClient = try await runtime.activeClient() else {
            await clearActiveEnvironment()
            let snapshot = disconnectedSnapshot(environments: environments)
            latestSnapshot = snapshot
            return snapshot
        }
        // The runtime actor can change its active selection at any suspension
        // point. Derive both values from one client so the snapshot cannot pair
        // one environment with another environment's connection.
        let environment = activeClient.environment

        await adoptEnvironment(environment, client: activeClient)
        let generation = environmentGeneration
        let loads = await loadEnvironmentShells(environments)
        guard isCurrentSession(client: activeClient, generation: generation) else {
            throw CancellationError()
        }
        reconcileEnvironmentLoads(loads, savedEnvironments: environments)
        latestShell = shellsByEnvironmentID[environment.id]
        startPolling(activeClient)
        let activeIsReachable = loads.contains {
            $0.environment.id == environment.id && $0.shell != nil
        }
        if activeIsReachable {
            scheduleArchivedRefresh(client: activeClient, environment: environment)
        }
        let snapshot = makeSnapshot(
            environments: environments,
            activeEnvironment: environment,
            connectionState: activeIsReachable ? .connected : .disconnected,
            connectionDetail: activeIsReachable ? nil : "That server is currently unreachable."
        )
        latestSnapshot = snapshot
        return snapshot
    }

    func events() -> AsyncStream<FeatureEvent> {
        stream
    }

    func pair(endpoint: String, token: String?) async throws {
        let pairedClient: T3Client
        if let token, !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            pairedClient = try await runtime.pair(
                host: endpoint,
                code: token,
                clientLabel: "T3 Code Swift"
            )
        } else {
            pairedClient = try await runtime.pair(url: endpoint, clientLabel: "T3 Code Swift")
        }
        await adoptEnvironment(pairedClient.environment, client: pairedClient)
        startPolling(pairedClient)
    }

    func connectT3Environment(
        _ credential: T3ConnectManagedEnvironmentCredential
    ) async throws {
        guard hasMatchingT3ConnectController else {
            throw T3ConnectRelayError.invalidConfiguration(
                "This client runtime requires its matching T3 Connect controller."
            )
        }
        guard runtime.supportsManagedAuthorization else {
            throw T3ConnectRelayError.invalidConfiguration(
                "This client runtime was created without T3 Connect authorization."
            )
        }
        guard credential.environmentID.isEmpty == false,
              let httpBaseURL = credential.endpoint.httpBaseURL,
              let webSocketBaseURL = credential.endpoint.webSocketBaseURL,
              httpBaseURL.scheme?.lowercased() == "https",
              webSocketBaseURL.scheme?.lowercased() == "wss",
              httpBaseURL.host != nil,
              webSocketBaseURL.host != nil else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The managed environment endpoint is invalid."
            )
        }

        let descriptor = try await runtime.descriptor(at: httpBaseURL)
        guard descriptor.environmentId == credential.environmentID else {
            throw T3ConnectRelayError.environmentMismatch
        }
        let authorization = try await t3ConnectController.managedAuthorizer.exchange(
            credential,
            clientLabel: "T3 Code SwiftUI"
        )
        guard authorization.environmentID == descriptor.environmentId,
              authorization.endpoint == credential.endpoint,
              authorization.proofKeyThumbprint == credential.proofKeyThumbprint else {
            throw T3ConnectRelayError.environmentMismatch
        }

        let environment = Environment(
            id: descriptor.environmentId,
            label: descriptor.label,
            httpBaseURL: httpBaseURL,
            webSocketBaseURL: webSocketBaseURL,
            kind: .managedDPoP,
            descriptor: descriptor
        )
        let savedCredential = EnvironmentCredential.managedDPoP(
            accessToken: authorization.accessToken,
            expiresAt: authorization.expiresAt,
            scopes: authorization.scopes,
            environmentID: authorization.environmentID,
            proofKeyThumbprint: authorization.proofKeyThumbprint
        )
        let managedClient = try await runtime.saveManagedEnvironment(
            environment,
            credential: savedCredential
        )
        await adoptEnvironment(environment, client: managedClient)
        do {
            try await refresh(client: managedClient)
        } catch {
            let environments = (try? await runtime.environments()) ?? [environment]
            let snapshot = makeSnapshot(
                environments: environments,
                activeEnvironment: environment,
                connectionState: .connecting,
                connectionDetail: "Connected securely. Loading this environment."
            )
            publish(snapshot)
        }
        startPolling(managedClient)
    }

    func activateEnvironment(id: String) async throws {
        let activated = try await runtime.activate(id: id)
        await adoptEnvironment(activated.environment, client: activated)
        try await refresh(client: activated)
        startPolling(activated)
    }

    func removeEnvironment(id: String) async throws {
        let removesActiveEnvironment = activeEnvironment?.id == id
        try await runtime.remove(id: id)
        if removesActiveEnvironment {
            await clearActiveEnvironment(disconnectClient: false)
        }
    }

    func disconnect() async {
        await clearActiveEnvironment()
    }

    private func adoptEnvironment(
        _ environment: Environment,
        client newClient: T3Client
    ) async {
        if activeEnvironment?.id == environment.id, client === newClient {
            activeEnvironment = environment
            environmentClients[environment.id] = newClient
            latestShell = shellsByEnvironmentID[environment.id]
            startAggregateRefresh(newClient)
            return
        }
        let previousClient = client
        pollingTask?.cancel()
        fallbackPollingTask?.cancel()
        configurationTask?.cancel()
        aggregateRefreshTask?.cancel()
        archivedRefreshTask?.cancel()
        passiveDetailPollingTask?.cancel()
        pollingTask = nil
        fallbackPollingTask = nil
        configurationTask = nil
        aggregateRefreshTask = nil
        aggregateRefreshID = nil
        archivedRefreshTask = nil
        passiveDetailPollingTask = nil
        clearEnvironmentState(preserveEnvironmentSnapshots: true)
        activeEnvironment = environment
        client = newClient
        environmentClients[environment.id] = newClient
        latestShell = shellsByEnvironmentID[environment.id]
        if let previousClient, previousClient !== newClient {
            await previousClient.disconnect()
        }
        startAggregateRefresh(newClient)
    }

    private func clearActiveEnvironment(disconnectClient: Bool = true) async {
        let previousClient = client
        pollingTask?.cancel()
        fallbackPollingTask?.cancel()
        configurationTask?.cancel()
        aggregateRefreshTask?.cancel()
        archivedRefreshTask?.cancel()
        passiveDetailPollingTask?.cancel()
        pollingTask = nil
        fallbackPollingTask = nil
        configurationTask = nil
        aggregateRefreshTask = nil
        aggregateRefreshID = nil
        archivedRefreshTask = nil
        passiveDetailPollingTask = nil
        clearEnvironmentState()
        client = nil
        activeEnvironment = nil
        if disconnectClient, let previousClient {
            await previousClient.disconnect()
        }
    }

    private func clearEnvironmentState(preserveEnvironmentSnapshots: Bool = false) {
        environmentGeneration &+= 1
        resetDetailRefresh()
        resetDetailStream()
        attachmentHydrationTasks.values.forEach { $0.task.cancel() }
        attachmentHydrationTasks.removeAll()
        archivedRefreshTask?.cancel()
        archivedRefreshTask = nil
        shellPublishTask?.cancel()
        shellPublishTask = nil
        latestShell = nil
        lastShellEventAt = nil
        latestServerConfig = nil
        if !preserveEnvironmentSnapshots {
            environmentClients.removeAll()
            shellsByEnvironmentID.removeAll()
            serverConfigsByEnvironmentID.removeAll()
            providerCatalogCache.removeAll()
            archivedThreadsByEnvironmentID.removeAll()
            archivedShellThreadsByEnvironmentID.removeAll()
            projectEnvironmentIDs.removeAll()
            projectWireIDs.removeAll()
            pinnedPreviewURLTasks.values.forEach { $0.cancel() }
            pinnedPreviewURLTasks.removeAll()
            pinnedPreviewURLs.removeAll()
            probedPreviewURLProjectIDs.removeAll()
            threadEnvironmentIDs.removeAll()
            threadWireIDs.removeAll()
            provisionalThreadRoutes.removeAll()
            environmentConnectionStates.removeAll()
            environmentConnectionDetails.removeAll()
        }
        latestSnapshot = nil
        activeThreadID = nil
        activeThreadEnvironmentID = nil
        activeRawThread = nil
        activeThreadSequence = nil
        activeThreadPage = nil
        threadHistoryEpoch &+= 1
        latestDetails.removeAll()
        attachmentURLs.removeAll()
        pendingBootstrapSubmissions.removeAll()
        pendingTurnSubmissions.removeAll()
        approvalRoutes.removeAll()
        inputRoutes.removeAll()
        terminalSnapshots.removeAll()
    }

    private func isCurrentSession(client: T3Client, generation: Int) -> Bool {
        guard generation == environmentGeneration, let currentClient = self.client else {
            return false
        }
        return currentClient === client
    }

    private func isKnownClient(
        _ client: T3Client,
        environmentID: String,
        generation: Int
    ) -> Bool {
        generation == environmentGeneration
            && environmentClients[environmentID] === client
    }

    func addProject(path: String) async throws {
        guard let environmentID = activeEnvironment?.id else {
            throw NativeFeatureClientError.notConnected
        }
        try await addProject(environmentID: environmentID, path: path)
    }

    func addProject(environmentID: String, path: String) async throws {
        let client = try await projectCreationClient(environmentID: environmentID)
        try await createProject(client: client, path: path)
    }

    func browseProjectFolders(
        environmentID: String,
        partialPath: String
    ) async throws -> FilesystemBrowseResult {
        let client = try await projectCreationClient(environmentID: environmentID)
        return try await client.browseFilesystem(partialPath: partialPath)
    }

    func workspaceAssetURL(threadID: String, path: String) async throws -> URL {
        let route = try threadRoute(for: threadID)
        return try await route.client.resolvedAssetURL(
            resource: .workspaceFile(threadID: route.wireID, path: path)
        )
    }

    func usageSummary(
        environmentID: String,
        sinceDay: String,
        untilDay: String,
        timeZone: String
    ) async throws -> UsageSummary {
        let client = try await environmentClient(id: environmentID)
        return try await client.getUsageSummary(
            sinceDay: sinceDay,
            untilDay: untilDay,
            timeZone: timeZone
        )
    }

    func projectFaviconURL(
        environmentID: String,
        cwd: String,
        faviconPath: String?
    ) async throws -> URL? {
        let client = try await environmentClient(id: environmentID)
        let url = try await client.resolvedAssetURL(
            resource: .projectFavicon(cwd: cwd, path: faviconPath)
        )
        // The server signals "no icon" with a marker filename instead of an
        // error, so the letter badge is a decision rather than a failure path.
        return url.lastPathComponent.contains("project-favicon-missing") ? nil : url
    }

    func discoverProjectSources(
        environmentID: String
    ) async throws -> SourceControlDiscoveryResult {
        let client = try await projectCreationClient(environmentID: environmentID)
        return try await client.discoverSourceControl()
    }

    func lookupProjectRepository(
        environmentID: String,
        provider: SourceControlProviderKind,
        repository: String
    ) async throws -> SourceControlRepositoryInfo {
        let client = try await projectCreationClient(environmentID: environmentID)
        return try await client.lookupRepository(
            provider: provider,
            repository: repository
        )
    }

    func cloneProjectRepository(
        environmentID: String,
        remoteURL: String,
        destinationPath: String
    ) async throws -> SourceControlCloneResult {
        let client = try await projectCreationClient(environmentID: environmentID)
        do {
            return try await client.cloneRepository(
                remoteURL: remoteURL,
                destinationPath: destinationPath
            )
        } catch let error as RPCError {
            switch error {
            case .connectionUnavailable, .disconnected, .responseTimedOut:
                // The clone RPC is not receipt-bearing, so a lost reply is
                // ambiguous. Confirm the requested destination became a Git
                // repository with a primary remote before moving on to the
                // independently retryable project-registration step.
                if let refs = try? await client.listVCSRefs(
                    cwd: destinationPath,
                    refresh: true,
                    limit: 1
                ), refs.isRepo, refs.hasPrimaryRemote {
                    return SourceControlCloneResult(
                        cwd: destinationPath,
                        remoteUrl: remoteURL,
                        repository: nil
                    )
                }
                throw error
            case .remote, .protocolViolation:
                throw error
            }
        }
    }

    private func createProject(client: T3Client, path: String) async throws {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw NativeFeatureClientError.invalidProjectPath
        }
        let title = ProjectCreationPath.lastPathComponent(trimmed)
        let projectID = UUID().uuidString
        do {
            _ = try await client.createProject(
                projectID: projectID,
                title: title.isEmpty ? "Project" : title,
                workspaceRoot: trimmed,
                defaultModel: client.environment.id == activeEnvironment?.id
                    ? fallbackModelSelection(
                        environmentID: client.environment.id,
                        projectID: nil,
                        shell: shellsByEnvironmentID[client.environment.id]
                    )
                    : nil
            )
        } catch {
            // The dispatch reply may be lost after the server persisted the
            // project. A fresh shell turns that ambiguous failure into success
            // and also makes retrying clone registration idempotent.
            guard await recoverCreatedProject(
                client: client,
                projectID: projectID,
                path: trimmed
            ) else {
                throw error
            }
            return
        }

        do {
            try await refresh(client: client)
        } catch {
            guard await recoverCreatedProject(
                client: client,
                projectID: projectID,
                path: trimmed
            ) else {
                throw error
            }
        }
    }

    private func recoverCreatedProject(
        client: T3Client,
        projectID: String,
        path: String
    ) async -> Bool {
        let environment = client.environment
        let generation = environmentGeneration
        guard let shell = try? await client.shellSnapshot(),
              isKnownClient(client, environmentID: environment.id, generation: generation),
              shell.projects.contains(where: {
                  $0.id == projectID
                    || ProjectCreationPath.normalizedForComparison($0.workspaceRoot)
                        == ProjectCreationPath.normalizedForComparison(path)
              }) else {
            return false
        }
        shellsByEnvironmentID[environment.id] = shell
        if activeEnvironment?.id == environment.id {
            latestShell = shell
        }
        rebuildEntityIndexes((try? await runtime.environments()) ?? [environment])
        await emitSnapshot(shell, environment: environment)
        return true
    }

    func listWorkspaceBranches(
        projectID: String,
        refresh: Bool
    ) async throws -> [FeatureWorkspaceBranch] {
        let route = try projectRoute(for: projectID)
        let project = try project(for: route)
        var refs: [VCSRef] = []
        var cursor: Int?
        var seenCursors = Set<Int>()
        repeat {
            let result = try await route.client.listVCSRefs(
                cwd: project.workspaceRoot,
                cursor: cursor,
                refresh: refresh && cursor == nil,
                limit: 100
            )
            guard result.isRepo else { return [] }
            refs.append(contentsOf: result.refs)
            guard let nextCursor = result.nextCursor,
                  seenCursors.insert(nextCursor).inserted else {
                break
            }
            cursor = nextCursor
        } while true

        return refs.map { ref in
            FeatureWorkspaceBranch(
                name: ref.name,
                isRemote: ref.isRemote ?? false,
                isCurrent: ref.current,
                isDefault: ref.isDefault,
                worktreePath: ref.worktreePath
            )
        }
    }

    func createThread(
        projectID: String,
        title: String?,
        selection: FeatureSelection?
    ) async throws -> FeatureThread {
        let route = try projectRoute(for: projectID)
        let client = route.client
        let environment = client.environment
        let generation = environmentGeneration
        let threadID = UUID().uuidString
        let model = modelSelection(
            selection,
            projectID: route.wireID,
            environmentID: environment.id,
            shell: shellsByEnvironmentID[environment.id]
        )
        let resolvedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let threadTitle = resolvedTitle?.isEmpty == false ? resolvedTitle! : "New thread"
        _ = try await client.createThread(
            threadID: threadID,
            projectID: route.wireID,
            title: threadTitle,
            model: model,
            runtimeMode: .fullAccess
        )
        guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
            throw CancellationError()
        }
        registerProvisionalThread(wireID: threadID, environmentID: environment.id)
        if let shell = try? await client.shellSnapshot() {
            guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
                throw CancellationError()
            }
            shellsByEnvironmentID[environment.id] = shell
            if activeEnvironment?.id == environment.id {
                latestShell = shell
            }
            await emitSnapshot(shell, environment: environment)
            if let created = shell.threads.first(where: { $0.id == threadID }) {
                provisionalThreadRoutes[FeatureScopedID.thread(
                    environmentID: environment.id,
                    wireID: threadID
                )] = nil
                return mapThread(created, environment: environment)
            }
        }
        return FeatureThread(
            id: FeatureScopedID.thread(environmentID: environment.id, wireID: threadID),
            wireID: threadID,
            projectID: route.uiID,
            environmentID: environment.id,
            environmentName: environment.label,
            title: threadTitle,
            providerID: model.instanceId,
            providerName: providerDisplayName(model.instanceId),
            modelID: model.model
        )
    }

    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread {
        try await createThreadAndSend(
            projectID: projectID,
            prompt: prompt,
            selection: selection,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            workspaceMode: .local,
            branch: nil,
            worktreePath: nil,
            startFromOrigin: false,
            attachments: attachments
        )
    }

    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        workspaceMode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread {
        try await createThreadAndSendResolved(
            projectID: projectID,
            prompt: prompt,
            selection: selection,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            workspaceMode: workspaceMode,
            branch: branch,
            worktreePath: worktreePath,
            startFromOrigin: startFromOrigin,
            attachments: attachments,
            submissionIdentity: nil
        )
    }

    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        workspaceMode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity
    ) async throws -> FeatureThread {
        try await createThreadAndSendResolved(
            projectID: projectID,
            prompt: prompt,
            selection: selection,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            workspaceMode: workspaceMode,
            branch: branch,
            worktreePath: worktreePath,
            startFromOrigin: startFromOrigin,
            attachments: attachments,
            submissionIdentity: identity
        )
    }

    private func createThreadAndSendResolved(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        workspaceMode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment],
        submissionIdentity: FeatureSubmissionIdentity?
    ) async throws -> FeatureThread {
        let route = try projectRoute(for: projectID)
        let client = route.client
        let environment = client.environment
        let generation = environmentGeneration
        let routedProject = try project(for: route)
        let branch = branch?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard workspaceMode != .worktree || branch?.isEmpty == false else {
            throw NativeFeatureClientError.branchRequired
        }
        let worktreePath = workspaceMode == .local ? worktreePath : nil
        let model = modelSelection(
            selection,
            projectID: route.wireID,
            environmentID: environment.id,
            shell: shellsByEnvironmentID[environment.id]
        )
        let title = Self.title(from: prompt, hasAttachments: !attachments.isEmpty)
        let uploads = try makeUploadAttachments(attachments)
        let runtime = coreRuntimeMode(runtimeMode)
        let interaction = coreInteractionMode(interactionMode)
        let signature = BootstrapSubmissionSignature(
            projectID: projectID,
            prompt: prompt,
            model: model,
            runtimeMode: runtime,
            interactionMode: interaction,
            workspaceMode: workspaceMode,
            branch: branch,
            worktreePath: worktreePath,
            startFromOrigin: startFromOrigin,
            attachments: attachments
        )
        let pending: PendingBootstrapSubmission
        let explicitIdentity = submissionIdentity.map { commandIdentity($0) }
        if let explicitIdentity,
           let existing = pendingBootstrapSubmissions.first(where: {
               $0.identity == explicitIdentity
           }) {
            pending = existing
        } else if explicitIdentity == nil,
                  let existing = pendingBootstrapSubmissions.first(where: {
                      $0.signature == signature
                  }) {
            pending = existing
        } else {
            pending = PendingBootstrapSubmission(
                signature: signature,
                threadID: submissionIdentity?.threadID ?? UUID().uuidString,
                identity: explicitIdentity ?? CommandIdentity(),
                worktreeBranchName: workspaceMode == .worktree
                    ? Self.temporaryWorktreeBranchName(
                        seed: submissionIdentity?.threadID
                    )
                    : nil
            )
            pendingBootstrapSubmissions.append(pending)
        }

        do {
            _ = try await client.createThreadAndSend(
                threadID: pending.threadID,
                projectID: route.wireID,
                title: title,
                text: prompt,
                model: model,
                runtimeMode: runtime,
                interactionMode: interaction,
                branch: branch,
                worktreePath: worktreePath,
                worktreePreparation: pending.worktreeBranchName.flatMap { worktreeBranch in
                    branch.map {
                        ThreadWorktreePreparation(
                            projectCwd: routedProject.workspaceRoot,
                            baseBranch: $0,
                            branch: worktreeBranch,
                            startFromOrigin: startFromOrigin
                        )
                    }
                },
                attachments: uploads,
                commandID: pending.identity.commandID,
                messageID: pending.identity.messageID
            )
        } catch {
            // A connection can disappear after the server accepted the command
            // but before its reply reaches us. Bootstrap expansion creates the
            // thread before dispatching the stable final turn, so recover an
            // interrupted empty thread by sending only that original turn.
            let recovered = try await recoverBootstrap(
                client: client,
                pending: pending,
                projectID: route.wireID,
                text: prompt,
                model: model,
                attachments: uploads
            )
            guard recovered else {
                await resetFailedBootstrapIfConfirmed(
                    client: client,
                    pending: pending,
                    projectCwd: routedProject.workspaceRoot
                )
                throw error
            }
        }

        registerProvisionalThread(wireID: pending.threadID, environmentID: environment.id)
        guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
            throw CancellationError()
        }
        removePendingBootstrap(identity: pending.identity)
        // Dispatch acceptance is the commit point. A dropped refresh must not
        // turn a successful first turn into a retry that creates a duplicate.
        if let shell = try? await client.shellSnapshot() {
            guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
                throw CancellationError()
            }
            shellsByEnvironmentID[environment.id] = shell
            if activeEnvironment?.id == environment.id {
                latestShell = shell
            }
            await emitSnapshot(shell, environment: environment)
            if let created = shell.threads.first(where: { $0.id == pending.threadID }) {
                provisionalThreadRoutes[FeatureScopedID.thread(
                    environmentID: environment.id,
                    wireID: pending.threadID
                )] = nil
                return mapThread(created, environment: environment)
            }
        }
        return FeatureThread(
            id: FeatureScopedID.thread(
                environmentID: environment.id,
                wireID: pending.threadID
            ),
            wireID: pending.threadID,
            projectID: route.uiID,
            environmentID: environment.id,
            environmentName: environment.label,
            title: title,
            branch: workspaceMode == .worktree ? pending.worktreeBranchName : branch,
            worktreePath: worktreePath,
            providerID: model.instanceId,
            providerName: providerDisplayName(model.instanceId),
            modelID: model.model,
            modelOptions: mapOptionSelections(model.options),
            runtimeMode: runtimeMode.mobileNormalized,
            interactionMode: interactionMode.mobileNormalized
        )
    }

    private func recoverBootstrap(
        client: T3Client,
        pending: PendingBootstrapSubmission,
        projectID: String,
        text: String,
        model: ModelSelection,
        attachments: [UploadChatAttachment]
    ) async throws -> Bool {
        guard let snapshot = try? await client.threadSnapshot(id: pending.threadID) else {
            return false
        }
        if snapshot.projection.containsUserMessage(id: pending.identity.messageID) {
            return true
        }
        guard snapshot.projection.thread.projectId == projectID,
              snapshot.projection.thread.deletedAt == nil,
              !snapshot.projection.hasAnyUserMessage else {
            return false
        }

        do {
            _ = try await client.sendTurn(
                threadID: pending.threadID,
                text: text,
                model: model,
                attachments: attachments,
                commandID: pending.identity.commandID,
                messageID: pending.identity.messageID
            )
        } catch {
            guard await messageWasCommitted(
                client: client,
                threadID: pending.threadID,
                messageID: pending.identity.messageID
            ) else {
                throw error
            }
        }
        return true
    }

    /// A failed bootstrap can leave its generated worktree behind after the
    /// server rolls back the thread. Only reset the retry identity after a
    /// fresh shell confirms the thread is absent; ambiguous network failures
    /// keep the stable IDs so the normal recovery path remains idempotent.
    private func resetFailedBootstrapIfConfirmed(
        client: T3Client,
        pending: PendingBootstrapSubmission,
        projectCwd: String
    ) async {
        guard let shell = try? await client.shellSnapshot(),
              !shell.threads.contains(where: { $0.id == pending.threadID }) else {
            return
        }

        if let branch = pending.worktreeBranchName,
           let refs = try? await client.listVCSRefs(
               cwd: projectCwd,
               query: branch,
               refresh: true,
               limit: 100
           ),
           let path = refs.refs.first(where: {
               $0.name == branch && $0.isRemote != true
           })?.worktreePath {
            // Never force-remove: setup scripts may have left useful changes.
            // A clean orphan is safe to reclaim; a dirty one remains visible
            // through normal worktree management.
            try? await client.removeWorktree(cwd: projectCwd, path: path)
        }

        removePendingBootstrap(identity: pending.identity)
    }

    private func removePendingBootstrap(identity: CommandIdentity) {
        pendingBootstrapSubmissions.removeAll { $0.identity == identity }
    }

    func renameThread(id: String, title: String) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.rename(threadID: route.wireID, title: title)
        updateCachedArchivedThread(id: route.uiID) { $0.title = title }
        try? await refresh(client: route.client)
    }

    /// The regenerated title arrives on the thread stream, not in this reply, so
    /// the command only starts the work. The shell's `titleRegeneration` is what
    /// puts the row into its regenerating state until it lands.
    func regenerateThreadTitle(id: String) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.regenerateTitle(threadID: route.wireID)
        try? await refresh(client: route.client)
    }

    func generateHandoffScript(threadID: String) async throws -> String {
        let route = try threadRoute(for: threadID)
        return try await route.client.handoffScript(threadID: route.wireID).script
    }

    func mergeThreadBack(
        sourceThreadID: String,
        targetThreadID: String,
        runID: String
    ) async throws {
        let source = try threadRoute(for: sourceThreadID)
        let target = try threadRoute(for: targetThreadID)
        // Both threads are one server's rows; a merge across two paired
        // environments has no meaning and no command to express it.
        guard source.environmentID == target.environmentID else {
            throw NativeFeatureClientError.crossEnvironmentMerge
        }
        _ = try await source.client.mergeBack(
            sourceThreadID: source.wireID,
            targetThreadID: target.wireID,
            runID: runID
        )
        try? await refresh(client: source.client)
    }

    /// Ends the agent processes behind a thread without touching its history.
    ///
    /// One thread can be backed by several provider sessions, and there is no
    /// "stop this thread" command — each session is detached individually,
    /// which is what `client-runtime`'s `stopThreadSession` does too.
    func stopThreadSession(threadID: String) async throws {
        let route = try threadRoute(for: threadID)
        let sessionIDs = try await providerSessionIDs(for: route)
        guard !sessionIDs.isEmpty else { return }
        try await route.client.detachProviderSessions(
            threadID: route.wireID,
            providerSessionIDs: sessionIDs,
            reason: "client-requested"
        )
        try? await refreshThread(id: route.uiID, client: route.client)
    }

    /// The open thread's projection is already in hand; any other thread is
    /// read fresh, because a stale session list would detach the wrong sessions
    /// or none at all.
    private func providerSessionIDs(
        for route: NativeThreadRoute
    ) async throws -> [String] {
        let projection: OrchestrationV2ThreadProjection
        if activeThreadID == route.uiID, let cached = activeRawThread {
            projection = cached
        } else {
            projection = try await route.client
                .threadSnapshot(id: route.wireID)
                .projection
        }
        var seen: Set<String> = []
        return projection.providerSessions.map(\.id).filter { seen.insert($0).inserted }
    }

    /// Restores the thread's workspace to an earlier checkpoint.
    ///
    /// The rollback target is resolved from the projection's checkpoint table,
    /// so its `threadID` is the row's *source* thread id — a wire id, and not
    /// necessarily this environment's open thread when the row was inherited.
    /// Both spellings are accepted for that reason: a feature-scoped id routes
    /// directly, and a bare wire id is resolved inside the open thread's
    /// environment rather than guessed at across every saved server.
    func rollBackToCheckpoint(
        threadID: String,
        scopeID: String,
        checkpointID: String
    ) async throws {
        let route = try checkpointRoute(for: threadID)
        _ = try await route.client.rollBackToCheckpoint(
            threadID: route.wireID,
            scopeID: scopeID,
            checkpointID: checkpointID
        )
        try? await refreshThread(id: route.uiID, client: route.client)
    }

    private func checkpointRoute(for threadID: String) throws -> NativeThreadRoute {
        if let route = try? threadRoute(for: threadID) { return route }
        guard let environmentID = activeThreadEnvironmentID ?? activeEnvironment?.id else {
            throw NativeFeatureClientError.threadNotFound
        }
        return try threadRoute(
            for: FeatureScopedID.thread(environmentID: environmentID, wireID: threadID)
        )
    }

    /// One entry per environment whose server config this client has seen.
    ///
    /// Ordered by the saved-environment list rather than by dictionary hashing:
    /// `resolveHermesConversationTarget` takes the first environment that can
    /// host the conversation, so an unstable order would make a Work launch
    /// land on a different server between runs.
    func workspaceServerConfigs() -> [MobileWorkspaceEnvironmentConfig] {
        var ordered = latestSnapshot?.environments.map(\.id) ?? []
        if ordered.isEmpty, let activeID = activeEnvironment?.id {
            ordered = [activeID]
        }
        var seen = Set(ordered)
        ordered.append(
            contentsOf: serverConfigsByEnvironmentID.keys
                .sorted()
                .filter { seen.insert($0).inserted }
        )
        return ordered.compactMap { environmentID in
            guard let config = serverConfigsByEnvironmentID[environmentID] else { return nil }
            return MobileWorkspaceEnvironmentConfig(
                environmentID: environmentID,
                t3WorkDirectory: config.t3WorkDirectory,
                providers: config.providers
            )
        }
    }

    func reorderQueuedRun(
        threadID: String,
        runID: String,
        beforeRunID: String?
    ) async throws {
        let route = try threadRoute(for: threadID)
        _ = try await route.client.reorderQueuedRun(
            threadID: route.wireID,
            runID: runID,
            beforeRunID: beforeRunID
        )
        try? await refreshThread(id: route.uiID, client: route.client)
    }

    func promoteQueuedRun(
        threadID: String,
        queuedRunID: String,
        targetRunID: String
    ) async throws {
        let route = try threadRoute(for: threadID)
        _ = try await route.client.promoteQueuedRun(
            threadID: route.wireID,
            queuedRunID: queuedRunID,
            targetRunID: targetRunID
        )
        try? await refreshThread(id: route.uiID, client: route.client)
    }

    func cancelQueuedRun(threadID: String, runID: String) async throws {
        let route = try threadRoute(for: threadID)
        _ = try await route.client.cancelQueuedRun(
            threadID: route.wireID,
            runID: runID
        )
        try? await refreshThread(id: route.uiID, client: route.client)
    }

    func editQueuedRun(threadID: String, runID: String, text: String) async throws {
        let route = try threadRoute(for: threadID)
        _ = try await route.client.editQueuedRun(
            threadID: route.wireID,
            runID: runID,
            text: text
        )
        try? await refreshThread(id: route.uiID, client: route.client)
    }

    func setThreadArchived(id: String, archived: Bool) async throws {
        let route = try threadRoute(for: id)
        let cached = cachedThread(id: route.uiID)
        _ = try await route.client.archive(threadID: route.wireID, archived: archived)
        reconcileArchivedCache(thread: cached, route: route, archived: archived)
        await emitCachedSnapshot(for: route.environmentID)
        try? await refresh(client: route.client, includeArchived: true)
    }

    func setThreadSettled(id: String, settled: Bool) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.settle(threadID: route.wireID, settled: settled)
        try? await refresh(client: route.client)
    }

    func setThreadSnoozed(id: String, until: Date?) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.snooze(threadID: route.wireID, until: until)
        try? await refresh(client: route.client)
    }

    func setThreadPinned(id: String, pinned: Bool) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.pin(threadID: route.wireID, pinned: pinned)
        try? await refresh(client: route.client)
    }

    func setWorkInboxRole(threadID: String, role: String?) async throws {
        let route = try threadRoute(for: threadID)
        _ = try await route.client.setWorkInboxRole(threadID: route.wireID, role: role)
        try? await refresh(client: route.client)
    }

    func setRuntimeMode(id: String, mode: FeatureRuntimeMode) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.setRuntimeMode(
            threadID: route.wireID,
            mode: coreRuntimeMode(mode)
        )
        try? await refresh(client: route.client)
        if activeThreadID == route.uiID {
            try? await refreshThread(id: route.uiID, client: route.client)
        }
    }

    func setInteractionMode(id: String, mode: FeatureInteractionMode) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.setInteractionMode(
            threadID: route.wireID,
            mode: coreInteractionMode(mode)
        )
        try? await refresh(client: route.client)
        if activeThreadID == route.uiID {
            try? await refreshThread(id: route.uiID, client: route.client)
        }
    }

    func deleteThread(id: String) async throws {
        let route = try threadRoute(for: id)
        _ = try await route.client.delete(threadID: route.wireID)
        archivedThreadsByEnvironmentID[route.environmentID]?.removeAll {
            $0.id == route.uiID
        }
        if let shell = shellsByEnvironmentID[route.environmentID] {
            var updated = shell
            updated.threads = shell.threads.filter { $0.id != route.wireID }
            shellsByEnvironmentID[route.environmentID] = updated
        }
        provisionalThreadRoutes[route.uiID] = nil
        if activeThreadID == route.uiID {
            resetDetailRefresh()
            resetDetailStream()
            passiveDetailPollingTask?.cancel()
            passiveDetailPollingTask = nil
            activeThreadID = nil
            activeThreadEnvironmentID = nil
        }
        latestDetails[route.uiID] = nil
        await emitCachedSnapshot(for: route.environmentID)
        try? await refresh(client: route.client, includeArchived: true)
    }

    func loadThread(id: String) async throws -> FeatureThreadDetail {
        let route = try threadRoute(for: id)
        let client = route.client
        let environment = client.environment
        let generation = environmentGeneration
        resetDetailRefresh()
        resetDetailStream()
        passiveDetailPollingTask?.cancel()
        passiveDetailPollingTask = nil
        activeThreadID = route.uiID
        activeThreadEnvironmentID = environment.id
        threadHistoryEpoch &+= 1
        let historyEpoch = threadHistoryEpoch
        activeThreadPage = nil
        let supportsPagination = serverConfigsByEnvironmentID[
            environment.id
        ]?.threadSnapshotWindow == true
        let snapshot = try await client.threadSnapshot(
            id: route.wireID,
            maxVisibleItems: supportsPagination ? Self.initialThreadVisibleItemLimit : nil
        )
        guard isKnownClient(client, environmentID: environment.id, generation: generation),
              threadHistoryEpoch == historyEpoch,
              activeThreadID == route.uiID,
              activeThreadEnvironmentID == environment.id else {
            throw CancellationError()
        }
        activeThreadPage = featurePage(
            truncatedVisibleItemCount: snapshot.projection.truncatedVisibleItemCount
        )
        let detail = mapDetail(
            snapshot.projection,
            environment: environment,
            page: activeThreadPage
        )
        activeRawThread = snapshot.projection
        activeThreadSequence = snapshot.snapshotSequence
        latestDetails[route.uiID] = detail
        scheduleAttachmentHydration(
            in: detail,
            threadID: route.uiID,
            client: client,
            environmentID: environment.id
        )
        startDetailStream(
            route,
            after: snapshot.snapshotSequence,
            snapshotMaxVisibleItems: supportsPagination ? Self.initialThreadVisibleItemLimit : nil
        )
        return detail
    }

    /// Loads the rest of the transcript.
    ///
    /// V2 has no keyset cursor: the initial load asks for a window and the
    /// server reports how much it withheld, so "load earlier" is simply the same
    /// request without a window. One fetch replaces the windowed projection with
    /// the complete one, which is why there is no page-merge step here.
    func loadEarlierThreadTurns(id: String) async throws -> FeatureThreadDetail? {
        let route = try threadRoute(for: id)
        guard activeThreadID == route.uiID,
              activeThreadEnvironmentID == route.environmentID,
              var page = activeThreadPage,
              page.hasMore,
              !page.isLoading else {
            return latestDetails[id]
        }

        let generation = environmentGeneration
        let epoch = threadHistoryEpoch
        page.isLoading = true
        activeThreadPage = page
        publishActivePageState(threadID: route.uiID)

        do {
            let snapshot = try await route.client.threadSnapshot(id: route.wireID)
            guard isKnownClient(
                route.client,
                environmentID: route.environmentID,
                generation: generation
            ), activeThreadID == route.uiID else {
                throw CancellationError()
            }
            // A thread switch or a newer authoritative snapshot landed while the
            // full history was in flight; adopting it now would rewind the view.
            guard threadHistoryEpoch == epoch,
                  snapshot.snapshotSequence >= (activeThreadSequence ?? 0) else {
                clearOlderThreadLoading(threadID: route.uiID)
                return latestDetails[route.uiID]
            }

            guard let environment = environmentClients[route.environmentID]?.environment else {
                clearOlderThreadLoading(threadID: route.uiID)
                return latestDetails[route.uiID]
            }

            activeThreadPage = featurePage(
                truncatedVisibleItemCount: snapshot.projection.truncatedVisibleItemCount
            )
            activeRawThread = snapshot.projection
            activeThreadSequence = snapshot.snapshotSequence
            let detail = mapDetail(
                snapshot.projection,
                environment: environment,
                page: activeThreadPage
            )
            latestDetails[route.uiID] = detail
            publish(detail, threadID: route.uiID)
            return detail
        } catch {
            if activeThreadID == route.uiID, threadHistoryEpoch == epoch {
                clearOlderThreadLoading(threadID: route.uiID)
            }
            throw error
        }
    }

    func releaseThread(id: String) {
        guard activeThreadID == id else { return }
        resetDetailRefresh()
        resetDetailStream()
        passiveDetailPollingTask?.cancel()
        passiveDetailPollingTask = nil
        activeThreadID = nil
        activeThreadEnvironmentID = nil
        activeRawThread = nil
        activeThreadSequence = nil
        activeThreadPage = nil
        threadHistoryEpoch &+= 1
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?
    ) async throws {
        try await sendMessage(
            threadID: threadID,
            text: text,
            selection: selection,
            attachments: []
        )
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment]
    ) async throws {
        try await sendMessageResolved(
            threadID: threadID,
            text: text,
            selection: selection,
            attachments: attachments,
            submissionIdentity: nil
        )
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity
    ) async throws {
        try await sendMessageResolved(
            threadID: threadID,
            text: text,
            selection: selection,
            attachments: attachments,
            submissionIdentity: identity
        )
    }

    private func sendMessageResolved(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment],
        submissionIdentity: FeatureSubmissionIdentity?
    ) async throws {
        let route = try threadRoute(for: threadID)
        let client = route.client
        let environmentID = route.environmentID
        let generation = environmentGeneration
        guard let shellThread = shellsByEnvironmentID[environmentID]?.threads
            .first(where: { $0.id == route.wireID }) else {
            throw NativeFeatureClientError.threadNotFound
        }
        let model = selection.map(coreModelSelection)
        let uploads = try makeUploadAttachments(attachments)
        let runtimeMode = coreRuntimeMode(mapRuntimeMode(shellThread.runtimeMode))
        let interactionMode = InteractionMode.default
        let signature = TurnSubmissionSignature(
            text: text,
            model: model,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            attachments: attachments
        )
        let pending: PendingTurnSubmission
        let explicitIdentity = submissionIdentity.map { commandIdentity($0) }
        if let explicitIdentity,
           let existing = pendingTurnSubmissions[route.uiID],
           existing.identity == explicitIdentity {
            pending = existing
        } else if explicitIdentity == nil,
                  let existing = pendingTurnSubmissions[route.uiID],
                  existing.signature == signature {
            pending = existing
        } else {
            pending = PendingTurnSubmission(
                signature: signature,
                identity: explicitIdentity ?? CommandIdentity()
            )
            pendingTurnSubmissions[route.uiID] = pending
        }

        do {
            _ = try await client.sendTurn(
                threadID: submissionIdentity?.threadID ?? route.wireID,
                text: text,
                model: model,
                attachments: uploads,
                commandID: pending.identity.commandID,
                messageID: pending.identity.messageID
            )
        } catch {
            guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
                throw CancellationError()
            }
            guard await messageWasCommitted(
                client: client,
                threadID: submissionIdentity?.threadID ?? route.wireID,
                messageID: pending.identity.messageID
            ) else {
                // Keep the stable identity. Retrying the same restored draft
                // cannot enqueue a duplicate turn after an ambiguous failure.
                throw error
            }
        }
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        if pendingTurnSubmissions[route.uiID]?.identity == pending.identity {
            pendingTurnSubmissions[route.uiID] = nil
        }
        // Live sync reconciles these snapshots. Refreshes are opportunistic
        // after the accepted command so transient reads cannot invite a
        // duplicate user turn.
        try? await refreshThread(id: route.uiID, client: client)
        try? await refresh(client: client)
    }

    private func messageWasCommitted(
        client: T3Client,
        threadID: String,
        messageID: String
    ) async -> Bool {
        guard let snapshot = try? await client.threadSnapshot(id: threadID) else {
            return false
        }
        return snapshot.projection.containsUserMessage(id: messageID)
    }

    func cancelTurn(threadID: String) async throws {
        let route = try threadRoute(for: threadID)
        // V2 interrupts a run, and names it: there is no separate turn identity
        // and no "interrupt whatever is running" form. The shell carries the
        // active run for a live thread; a stale shell falls back to the
        // projection before giving up, because interrupting nothing is silence
        // where the user asked for a stop.
        var resolved = shellsByEnvironmentID[route.environmentID]?.threads
            .first(where: { $0.id == route.wireID })?
            .activeRunId
        if resolved == nil {
            resolved = try? await route.client
                .threadSnapshot(id: route.wireID)
                .projection
                .activeRunID
        }
        guard let runID = resolved else { return }
        _ = try await route.client.interrupt(threadID: route.wireID, runID: runID)
        try? await refresh(client: route.client)
    }

    func resolveApproval(id: String, decision: FeatureApprovalDecision) async throws {
        guard let request = approvalRoutes[id] else {
            throw NativeFeatureClientError.approvalNotFound
        }
        let route = try threadRoute(for: request.threadID)
        let wireDecision = switch decision {
        case .allowOnce: "accept"
        case .allowForSession: "acceptForSession"
        case .deny: "decline"
        }
        _ = try await route.client.respondToApproval(
            threadID: route.wireID,
            requestID: request.wireID,
            decision: wireDecision
        )
        approvalRoutes[id] = nil
        removeCachedApproval(id: id, threadID: route.uiID)
        try? await refreshThread(id: route.uiID, client: route.client)
    }

    func resolveUserInput(id: String, answers: [String: FeatureInputAnswer]) async throws {
        guard let request = inputRoutes[id] else {
            throw NativeFeatureClientError.inputRequestNotFound
        }
        let route = try threadRoute(for: request.threadID)
        _ = try await route.client.respondToUserInput(
            threadID: route.wireID,
            requestID: request.wireID,
            answers: answers.mapValues(\.jsonValue)
        )
        inputRoutes[id] = nil
        removeCachedInput(id: id, threadID: route.uiID)
        try? await refreshThread(id: route.uiID, client: route.client)
    }

    func saveSettings(_ settings: FeatureSettings) async throws {
        let data = try JSONEncoder().encode(settings)
        settingsStore.set(data, forKey: Self.settingsKey)
    }

    func loadDeviceSessions() async throws -> [FeatureDeviceSession] {
        let client = try requireClient()
        try await requireScope("access:read", client: client)
        return try await client.clientSessions().map { session in
            FeatureDeviceSession(
                sessionID: session.sessionId,
                label: session.client.label,
                deviceType: FeatureDeviceType(rawValue: session.client.deviceType) ?? .unknown,
                operatingSystem: session.client.os,
                browser: session.client.browser,
                ipAddress: session.client.ipAddress,
                issuedAt: parseDate(session.issuedAt),
                expiresAt: parseDate(session.expiresAt),
                lastConnectedAt: session.lastConnectedAt.map(parseDate),
                isConnected: session.connected,
                isCurrent: session.current
            )
        }
    }

    func revokeDeviceSession(id: String) async throws {
        let client = try requireClient()
        try await requireScope("access:write", client: client)
        guard try await client.revokeClientSession(id: id) else {
            throw NativeFeatureClientError.deviceSessionNotFound
        }
    }

    func revokeOtherDeviceSessions() async throws {
        let client = try requireClient()
        try await requireScope("access:write", client: client)
        _ = try await client.revokeOtherClientSessions()
    }

    func listFiles(threadID: String, path: String?) async throws -> [FeatureFileEntry] {
        let route = try threadRoute(for: threadID)
        let context = try workspaceContext(route: route)
        let result = try await route.client.listProjectEntries(cwd: context.cwd)
        return NativeWorkspaceMapper.files(result.entries, directory: path)
    }

    func searchProjectFiles(
        projectID: String,
        query: String,
        limit: Int
    ) async throws -> [FeatureFileEntry] {
        let route = try projectRoute(for: projectID)
        let project = try project(for: route)
        let result = try await route.client.searchProjectEntries(
            cwd: project.workspaceRoot,
            query: query,
            limit: limit
        )
        return result.entries.map(Self.mapSearchEntry)
    }

    func searchThreadFiles(
        threadID: String,
        query: String,
        limit: Int
    ) async throws -> [FeatureFileEntry] {
        let route = try threadRoute(for: threadID)
        let context = try workspaceContext(route: route)
        let result = try await route.client.searchProjectEntries(
            cwd: context.cwd,
            query: query,
            limit: limit
        )
        return result.entries.map(Self.mapSearchEntry)
    }

    private static func mapSearchEntry(_ entry: ProjectEntry) -> FeatureFileEntry {
        let name = URL(fileURLWithPath: entry.path).lastPathComponent
        return FeatureFileEntry(
            path: entry.path,
            name: name,
            kind: entry.kind == .directory ? .directory : .file,
            isHidden: name.hasPrefix(".")
        )
    }

    func readFile(threadID: String, path: String) async throws -> FeatureFileContent {
        let route = try threadRoute(for: threadID)
        let context = try workspaceContext(route: route)
        let result = try await route.client.readProjectFile(
            cwd: context.cwd,
            relativePath: path
        )
        return FeatureFileContent(
            path: result.relativePath,
            text: result.contents,
            language: NativeWorkspaceMapper.language(for: result.relativePath),
            isTruncated: result.truncated,
            totalBytes: result.byteLength
        )
    }

    func loadReview(threadID: String) async throws -> FeatureReview {
        let route = try threadRoute(for: threadID)
        let context = try workspaceContext(route: route)
        let preview = try await route.client.reviewDiffPreview(cwd: context.cwd)
        return NativeWorkspaceMapper.review(preview)
    }

    /// The diff one checkpoint captured.
    ///
    /// `orchestration.getTurnDiff` addresses a checkpoint by the turn-count
    /// range around it rather than by id, so the projection is read first to
    /// translate — see ``CheckpointTurnRangeResolver``. A checkpoint that cannot
    /// be translated throws: the working tree answers a different question, and
    /// returning it here is exactly the mistake this call exists to stop.
    func loadReview(threadID: String, checkpointID: String) async throws -> FeatureReview {
        let route = try checkpointRoute(for: threadID)
        let projection = try await threadProjection(for: route)
        let range = try CheckpointTurnRangeResolver.range(
            forCheckpoint: checkpointID,
            in: projection
        )
        let diff = range.needsFullThreadDiff
            ? try await route.client.fullThreadDiff(
                threadID: route.wireID,
                toTurnCount: range.toTurnCount
            )
            : try await route.client.turnDiff(
                threadID: route.wireID,
                fromTurnCount: range.fromTurnCount,
                toTurnCount: range.toTurnCount
            )
        return Self.checkpointReview(diff, cwd: try? workspaceContext(route: route).cwd)
    }

    /// The open thread's projection is already in hand; anything else is read
    /// fresh. Same rule as ``providerSessionIDs(for:)``, and for the same
    /// reason: a stale projection would resolve the checkpoint to the wrong
    /// turn, which is a mislabelled diff rather than a visible failure.
    private func threadProjection(
        for route: NativeThreadRoute
    ) async throws -> OrchestrationV2ThreadProjection {
        if activeThreadID == route.uiID, let cached = activeRawThread { return cached }
        return try await route.client.threadSnapshot(id: route.wireID).projection
    }

    /// Folds a turn diff into the same shape the working-tree path returns, so
    /// the review renders it unchanged.
    ///
    /// The patch goes through `NativeWorkspaceMapper.review` rather than a
    /// second parser: both replies are plain unified diffs, and the one wrapped
    /// as a `ReviewDiffSource` here is the only input that mapper takes.
    ///
    /// The per-file source refs are then cleared. They exist so the diff view
    /// can hydrate full-file context through `review.getDiffFileContents`, which
    /// reads the *current* workspace — for a historical checkpoint that would
    /// re-introduce the bug one screen deeper, so the file view keeps to the
    /// hunks the patch actually carries.
    static func checkpointReview(_ diff: ThreadTurnDiff, cwd: String?) -> FeatureReview {
        let sourceID = "turn:\(diff.fromTurnCount)-\(diff.toTurnCount)"
        var review = NativeWorkspaceMapper.review(
            ReviewDiffPreview(
                cwd: cwd ?? "",
                generatedAt: "",
                sources: [
                    ReviewDiffSource(
                        id: sourceID,
                        kind: "turn",
                        title: "Turn \(diff.toTurnCount)",
                        baseRef: nil,
                        headRef: nil,
                        diff: diff.diff,
                        diffHash: sourceID,
                        truncated: false
                    ),
                ]
            )
        )
        review.title = "Turn \(diff.toTurnCount)"
        review.baseReference = diff.fromTurnCount == 0
            ? "Thread start … turn \(diff.toTurnCount)"
            : "Turn \(diff.fromTurnCount) … turn \(diff.toTurnCount)"
        review.files = review.files.map { file in
            var file = file
            file.sourceKind = nil
            file.sourceBaseReference = nil
            file.sourceHeadReference = nil
            return file
        }
        return review
    }

    func loadReviewFileContents(
        threadID: String,
        file: FeatureReviewFile
    ) async throws -> FeatureReviewFileContents? {
        guard file.change != .binary, let sourceKind = file.sourceKind else { return nil }
        let route = try threadRoute(for: threadID)
        let context = try workspaceContext(route: route)
        let changeType: String = switch file.change {
        case .added: "new"
        case .deleted: "deleted"
        case .renamed: file.additions == 0 && file.deletions == 0
            ? "rename-pure"
            : "rename-changed"
        case .modified, .binary: "change"
        }
        let contents = try await route.client.reviewDiffFileContents(
            cwd: context.cwd,
            sourceKind: sourceKind,
            changeType: changeType,
            baseRef: file.sourceBaseReference,
            headRef: file.sourceHeadReference,
            oldPath: file.previousPath ?? file.path,
            newPath: file.path
        )
        return FeatureReviewFileContents(
            oldContents: contents.oldContents,
            newContents: contents.newContents
        )
    }

    func sourceControlStatus(threadID: String) async throws -> FeatureSourceControlStatus {
        let route = try threadRoute(for: threadID)
        let context = try workspaceContext(route: route)
        return NativeWorkspaceMapper.sourceControl(
            try await route.client.refreshVCSStatus(cwd: context.cwd)
        )
    }

    /// One subscription per checkout, not per thread: threads that share a
    /// worktree share a status, and the server keeps one cached status per cwd.
    private struct ChangeRequestSubscription: Hashable {
        let environmentID: String
        let cwd: String
    }

    func threadChangeRequests(threadIDs: [String]) -> AsyncStream<[String: FeaturePullRequest]> {
        AsyncStream { continuation in
            let task = Task { @MainActor [weak self] in
                await self?.streamChangeRequests(threadIDs: threadIDs, into: continuation)
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func streamChangeRequests(
        threadIDs: [String],
        into continuation: AsyncStream<[String: FeaturePullRequest]>.Continuation
    ) async {
        var branchesByThreadID: [String: String] = [:]
        var threadIDsBySubscription: [ChangeRequestSubscription: [String]] = [:]
        for threadID in threadIDs {
            guard let route = try? threadRoute(for: threadID),
                  let context = try? workspaceContext(route: route),
                  let shell = shellsByEnvironmentID[route.environmentID],
                  let thread = shell.threads.first(where: { $0.id == route.wireID }),
                  let branch = thread.branch?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !branch.isEmpty else { continue }
            branchesByThreadID[threadID] = branch
            let subscription = ChangeRequestSubscription(
                environmentID: route.environmentID,
                cwd: context.cwd
            )
            threadIDsBySubscription[subscription, default: []].append(threadID)
        }
        guard !threadIDsBySubscription.isEmpty else { return }

        let accumulator = ChangeRequestAccumulator()
        await withTaskGroup(of: Void.self) { group in
            for (subscription, subscribedThreadIDs) in threadIDsBySubscription {
                guard let client = environmentClients[subscription.environmentID] else { continue }
                group.addTask { @MainActor in
                    // A snapshot carries both halves; the deltas carry one each,
                    // so the last seen value of the other half has to survive.
                    var refName: String?
                    var pullRequest: FeaturePullRequest?
                    let events = await client.vcsStatusEvents(cwd: subscription.cwd)
                    do {
                        for try await event in events {
                            switch event {
                            case let .snapshot(local, remote):
                                refName = local.refName
                                pullRequest = remote?.pr.map(NativeWorkspaceMapper.pullRequest)
                            case let .localUpdated(local):
                                refName = local.refName
                            case let .remoteUpdated(remote):
                                pullRequest = remote?.pr.map(NativeWorkspaceMapper.pullRequest)
                            }
                            if let merged = accumulator.apply(
                                threadIDs: subscribedThreadIDs,
                                branches: branchesByThreadID,
                                refName: refName,
                                pullRequest: pullRequest
                            ) {
                                continuation.yield(merged)
                            }
                        }
                    } catch {
                        // A workspace that cannot report status has no change
                        // request to show; the row keeps its branch label.
                    }
                }
            }
            await group.waitForAll()
        }
    }

    func performSourceControlAction(
        threadID: String,
        action: FeatureSourceControlAction,
        message: String?
    ) async throws -> FeatureSourceControlStatus {
        let route = try threadRoute(for: threadID)
        let client = route.client
        let context = try workspaceContext(route: route)

        if action == .pull {
            _ = try await client.pull(cwd: context.cwd)
        } else {
            let progress = try await client.runGitAction(
                cwd: context.cwd,
                action: NativeWorkspaceMapper.gitAction(action),
                commitMessage: message
            )
            for try await event in progress {
                if event.kind == "action_failed" {
                    throw RPCError.remote(event.message ?? "The source-control action failed.")
                }
            }
        }

        return NativeWorkspaceMapper.sourceControl(
            try await client.refreshVCSStatus(cwd: context.cwd)
        )
    }

    func terminalSnapshot(
        threadID: String,
        terminalID: String
    ) async throws -> FeatureTerminalSnapshot {
        let route = try threadRoute(for: threadID)
        let key = TerminalKey(threadID: route.uiID, terminalID: terminalID)
        if let snapshot = terminalSnapshots[key] {
            return snapshot
        }
        let context = try workspaceContext(route: route)
        return FeatureTerminalSnapshot(
            threadID: route.uiID,
            terminalID: terminalID,
            workingDirectory: context.cwd
        )
    }

    func terminalEvents(
        threadID: String,
        terminalID: String
    ) -> AsyncStream<FeatureTerminalSnapshot> {
        guard let route = try? threadRoute(for: threadID),
              let context = try? workspaceContext(route: route) else {
            return AsyncStream { continuation in continuation.finish() }
        }
        let environmentID = route.environmentID
        let client = route.client
        let uiThreadID = route.uiID
        let wireThreadID = route.wireID
        let key = TerminalKey(threadID: uiThreadID, terminalID: terminalID)
        let generation = environmentGeneration
        return AsyncStream { continuation in
            if let snapshot = terminalSnapshots[key] {
                continuation.yield(snapshot)
            }
            let task = Task { [weak self] in
                do {
                    let events = try await client.attachTerminal(
                        threadID: wireThreadID,
                        terminalID: terminalID,
                        cwd: context.cwd,
                        worktreePath: context.worktreePath,
                        columns: 80,
                        rows: 24
                    )
                    for try await event in events {
                        guard !Task.isCancelled else { break }
                        guard let self else { break }
                        guard self.isKnownClient(
                            client,
                            environmentID: environmentID,
                            generation: generation
                        ) else {
                            break
                        }
                        let snapshot = self.consumeTerminalEvent(
                            event,
                            threadID: uiThreadID,
                            terminalID: terminalID
                        )
                        continuation.yield(snapshot)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    guard let self else {
                        continuation.finish()
                        return
                    }
                    guard self.isKnownClient(
                        client,
                        environmentID: environmentID,
                        generation: generation
                    ) else {
                        continuation.finish()
                        return
                    }
                    var snapshot = self.terminalSnapshots[key]
                        ?? FeatureTerminalSnapshot(
                            threadID: uiThreadID,
                            terminalID: terminalID,
                            workingDirectory: context.cwd
                        )
                    snapshot.state = .failed
                    snapshot.error = error.localizedDescription
                    self.terminalSnapshots[key] = snapshot
                    continuation.yield(snapshot)
                    continuation.finish()
                }
            }
            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }

    func terminalSessions(threadID: String) -> AsyncStream<[FeatureTerminalSnapshot]> {
        guard let route = try? threadRoute(for: threadID) else {
            return AsyncStream { continuation in continuation.finish() }
        }
        let environmentID = route.environmentID
        let client = route.client
        let uiThreadID = route.uiID
        let wireThreadID = route.wireID
        let generation = environmentGeneration
        return AsyncStream { continuation in
            let task = Task { [weak self] in
                var summaries = [TerminalSummary]()
                do {
                    for try await event in await client.terminalMetadataEvents() {
                        guard !Task.isCancelled else { break }
                        guard let self else { break }
                        guard self.isKnownClient(
                            client,
                            environmentID: environmentID,
                            generation: generation
                        ) else {
                            break
                        }

                        switch event.type {
                        case "snapshot":
                            summaries = (event.terminals ?? []).filter {
                                $0.threadId == wireThreadID
                            }
                        case "upsert":
                            if let summary = event.terminal,
                               summary.threadId == wireThreadID {
                                summaries.removeAll { $0.terminalId == summary.terminalId }
                                summaries.append(summary)
                            }
                        case "remove":
                            if event.threadId == wireThreadID,
                               let terminalID = event.terminalId {
                                summaries.removeAll { $0.terminalId == terminalID }
                            }
                        default:
                            break
                        }

                        let sessions = summaries
                            .sorted {
                                $0.terminalId.localizedStandardCompare($1.terminalId)
                                    == .orderedAscending
                            }
                            .map { self.mergeTerminalSummary($0, threadID: uiThreadID) }
                        continuation.yield(sessions)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish()
                }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    func openTerminal(
        threadID: String,
        terminalID: String,
        columns: Int,
        rows: Int
    ) async throws {
        let route = try threadRoute(for: threadID)
        let client = route.client
        let environmentID = route.environmentID
        let generation = environmentGeneration
        let context = try workspaceContext(route: route)
        let snapshot = try await client.openTerminal(
            threadID: route.wireID,
            terminalID: terminalID,
            cwd: context.cwd,
            worktreePath: context.worktreePath,
            columns: columns,
            rows: rows
        )
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        let mapped = NativeWorkspaceMapper.terminal(snapshot)
        var scoped = mapped
        scoped.threadID = route.uiID
        terminalSnapshots[TerminalKey(threadID: route.uiID, terminalID: terminalID)] = scoped
    }

    func writeTerminal(threadID: String, terminalID: String, data: String) async throws {
        let route = try threadRoute(for: threadID)
        try await route.client.writeTerminal(
            threadID: route.wireID,
            terminalID: terminalID,
            data: data
        )
    }

    func resizeTerminal(
        threadID: String,
        terminalID: String,
        columns: Int,
        rows: Int
    ) async throws {
        let route = try threadRoute(for: threadID)
        try await route.client.resizeTerminal(
            threadID: route.wireID,
            terminalID: terminalID,
            columns: columns,
            rows: rows
        )
    }

    func clearTerminal(threadID: String, terminalID: String) async throws {
        let route = try threadRoute(for: threadID)
        try await route.client.clearTerminal(
            threadID: route.wireID,
            terminalID: terminalID
        )
    }

    func closeTerminal(threadID: String, terminalID: String) async throws {
        let route = try threadRoute(for: threadID)
        let client = route.client
        let environmentID = route.environmentID
        let generation = environmentGeneration
        try await client.closeTerminal(threadID: route.wireID, terminalID: terminalID)
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        let context = try workspaceContext(route: route)
        terminalSnapshots[TerminalKey(threadID: route.uiID, terminalID: terminalID)] =
            FeatureTerminalSnapshot(
                threadID: route.uiID,
                terminalID: terminalID,
                workingDirectory: context.cwd
            )
    }

    private func requireClient() throws -> T3Client {
        guard let client else { throw NativeFeatureClientError.notConnected }
        return client
    }

    private func projectCreationClient(environmentID: String) async throws -> T3Client {
        try await environmentClient(id: environmentID)
    }

    /// The client for a saved environment, connecting one if this session has
    /// not touched that environment yet. Environment-scoped surfaces — project
    /// creation, automations — act on servers the user is not currently viewing.
    private func environmentClient(id environmentID: String) async throws -> T3Client {
        if let client = environmentClients[environmentID] {
            return client
        }
        guard let environment = try await runtime.environments().first(where: {
            $0.id == environmentID
        }) else {
            throw NativeFeatureClientError.environmentNotFound
        }
        let client = await runtime.client(for: environment)
        environmentClients[environmentID] = client
        return client
    }

    private func projectRoute(for projectID: String) throws -> NativeProjectRoute {
        guard let environmentID = projectEnvironmentIDs[projectID],
              let wireID = projectWireIDs[projectID],
              let client = environmentClients[environmentID] else {
            throw NativeFeatureClientError.projectNotFound
        }
        return NativeProjectRoute(
            uiID: FeatureScopedID.project(environmentID: environmentID, wireID: wireID),
            wireID: wireID,
            environmentID: environmentID,
            client: client
        )
    }

    private func project(for route: NativeProjectRoute) throws -> OrchestrationProject {
        guard let project = shellsByEnvironmentID[route.environmentID]?.projects.first(where: {
            $0.id == route.wireID
        }) else {
            throw NativeFeatureClientError.projectNotFound
        }
        return project
    }

    private func threadRoute(for threadID: String) throws -> NativeThreadRoute {
        guard let environmentID = threadEnvironmentIDs[threadID],
              let wireID = threadWireIDs[threadID],
              let client = environmentClients[environmentID] else {
            throw NativeFeatureClientError.threadNotFound
        }
        return NativeThreadRoute(
            uiID: FeatureScopedID.thread(environmentID: environmentID, wireID: wireID),
            wireID: wireID,
            environmentID: environmentID,
            client: client
        )
    }

    private func registerProvisionalThread(wireID: String, environmentID: String) {
        let uiID = FeatureScopedID.thread(environmentID: environmentID, wireID: wireID)
        provisionalThreadRoutes[uiID] = ProvisionalThreadRoute(
            environmentID: environmentID,
            wireID: wireID
        )
        threadEnvironmentIDs[uiID] = environmentID
        threadWireIDs[uiID] = wireID
    }

    private func cachedThread(id: String) -> FeatureThread? {
        latestSnapshot?.threads.first(where: { $0.id == id })
            ?? archivedThreadsByEnvironmentID.values.lazy
                .flatMap { $0 }
                .first(where: { $0.id == id })
    }

    private func updateCachedArchivedThread(
        id: String,
        update: (inout FeatureThread) -> Void
    ) {
        for environmentID in Array(archivedThreadsByEnvironmentID.keys) {
            guard var threads = archivedThreadsByEnvironmentID[environmentID],
                  let index = threads.firstIndex(where: { $0.id == id }) else {
                continue
            }
            update(&threads[index])
            archivedThreadsByEnvironmentID[environmentID] = threads
            return
        }
    }

    private func reconcileArchivedCache(
        thread: FeatureThread?,
        route: NativeThreadRoute,
        archived: Bool
    ) {
        archivedThreadsByEnvironmentID[route.environmentID, default: []]
            .removeAll { $0.id == route.uiID }
        var archivedShellThreads = archivedShellThreadsByEnvironmentID[
            route.environmentID,
            default: [:]
        ]
        let previouslyArchivedShell = archivedShellThreads.removeValue(
            forKey: route.wireID
        )

        if archived, var thread {
            // Keep the accepted lifecycle transition visible until both live
            // and archived follow-up reads converge, including when the
            // owning passive device drops immediately after the command.
            thread.isArchived = true
            archivedThreadsByEnvironmentID[route.environmentID, default: []].append(thread)
        }

        if let shell = shellsByEnvironmentID[route.environmentID] {
            if archived {
                if let liveThread = shell.threads.first(where: { $0.id == route.wireID }) {
                    archivedShellThreads[route.wireID] = liveThread
                }
                var updated = shell
                updated.threads = shell.threads.filter { $0.id != route.wireID }
                shellsByEnvironmentID[route.environmentID] = updated
            } else if let previouslyArchivedShell {
                var threads = shell.threads.filter { $0.id != route.wireID }
                threads.append(Self.unarchived(previouslyArchivedShell))
                var updated = shell
                updated.threads = threads
                shellsByEnvironmentID[route.environmentID] = updated
            }
        }
        archivedShellThreadsByEnvironmentID[route.environmentID] = archivedShellThreads
    }

    private static func unarchived(
        _ thread: OrchestrationV2ThreadShell
    ) -> OrchestrationV2ThreadShell {
        var restored = thread
        restored.archivedAt = nil
        return restored
    }

    /// The file name a project pins its dev-server URL in. Mirrors
    /// `T3_PROJECT_FILE_NAME` in packages/contracts/src/t3ProjectFile.ts.
    private static let projectFileName = "t3.json"

    /// Reads each project's `t3.json` once, and re-emits when one turns up a
    /// pinned `previewUrl`.
    ///
    /// The read is deliberately off the snapshot's critical path: a project's
    /// Ports section is one row poorer until it lands, whereas awaiting a
    /// per-project workspace read inside `emitSnapshot` would delay every
    /// thread update behind file I/O on the environment. A missing, truncated,
    /// or invalid file resolves to "no pinned URL" — a repository mid-edit must
    /// not make the section flicker.
    private func schedulePinnedPreviewURLReads(
        for environment: Environment,
        shell: OrchestrationV2ShellSnapshot
    ) {
        guard let client = environmentClients[environment.id] else { return }
        let generation = environmentGeneration
        for project in shell.projects {
            let uiID = FeatureScopedID.project(
                environmentID: environment.id,
                wireID: project.id
            )
            guard !probedPreviewURLProjectIDs.contains(uiID),
                  pinnedPreviewURLTasks[uiID] == nil else { continue }
            let workspaceRoot = project.workspaceRoot
            pinnedPreviewURLTasks[uiID] = Task { [weak self] in
                let url = await Self.pinnedPreviewURL(
                    client: client,
                    workspaceRoot: workspaceRoot
                )
                guard let self, !Task.isCancelled else { return }
                self.pinnedPreviewURLTasks[uiID] = nil
                guard self.isKnownClient(
                    client,
                    environmentID: environment.id,
                    generation: generation
                ) else { return }
                self.probedPreviewURLProjectIDs.insert(uiID)
                guard let url else { return }
                self.pinnedPreviewURLs[uiID] = url
                await self.emitCachedSnapshot(for: environment.id)
            }
        }
    }

    private static func pinnedPreviewURL(
        client: T3Client,
        workspaceRoot: String
    ) async -> String? {
        guard let file = try? await client.readProjectFile(
            cwd: workspaceRoot,
            relativePath: projectFileName
        ), !file.truncated else { return nil }
        guard let document = try? JSONDecoder.t3.decode(
            JSONValue.self,
            from: Data(file.contents.utf8)
        ), let raw = document["previewUrl"]?.stringValue else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func emitCachedSnapshot(for environmentID: String) async {
        guard let environment = environmentClients[environmentID]?.environment,
              let shell = shellsByEnvironmentID[environmentID] else {
            return
        }
        await emitSnapshot(shell, environment: environment)
    }

    private func removeCachedApproval(id: String, threadID: String) {
        guard var detail = latestDetails[threadID] else { return }
        detail.approvals.removeAll { $0.id == id }
        if detail.approvals.isEmpty, detail.thread.state == .waitingForApproval {
            detail.thread.state = detail.userInputs.isEmpty ? .idle : .waitingForInput
        }
        publish(detail, threadID: threadID)
    }

    private func removeCachedInput(id: String, threadID: String) {
        guard var detail = latestDetails[threadID] else { return }
        detail.userInputs.removeAll { $0.id == id }
        if detail.userInputs.isEmpty, detail.thread.state == .waitingForInput {
            detail.thread.state = detail.approvals.isEmpty ? .idle : .waitingForApproval
        }
        publish(detail, threadID: threadID)
    }

    private func workspaceContext(route: NativeThreadRoute) throws -> (
        cwd: String,
        worktreePath: String?
    ) {
        guard let shell = shellsByEnvironmentID[route.environmentID],
              let thread = shell.threads.first(where: { $0.id == route.wireID }),
              let project = shell.projects.first(where: { $0.id == thread.projectId }) else {
            throw NativeFeatureClientError.workspaceNotFound
        }
        return (
            cwd: thread.worktreePath ?? project.workspaceRoot,
            worktreePath: thread.worktreePath
        )
    }

    private func consumeTerminalEvent(
        _ event: TerminalEvent,
        threadID: String,
        terminalID: String
    ) -> FeatureTerminalSnapshot {
        let key = TerminalKey(threadID: threadID, terminalID: terminalID)
        if let coreSnapshot = event.snapshot {
            var snapshot = NativeWorkspaceMapper.terminal(coreSnapshot)
            snapshot.threadID = threadID
            snapshot.buffer = Self.cappedTerminalBuffer(snapshot.buffer)
            terminalSnapshots[key] = snapshot
            return snapshot
        }

        var snapshot = terminalSnapshots[key]
            ?? FeatureTerminalSnapshot(threadID: threadID, terminalID: terminalID)
        switch event.type {
        case "output":
            snapshot.buffer.append(event.data ?? "")
            snapshot.buffer = Self.cappedTerminalBuffer(snapshot.buffer)
        case "exited":
            snapshot.state = .exited
            snapshot.exitCode = event.exitCode
        case "closed":
            snapshot.state = .stopped
        case "error":
            snapshot.state = .failed
            snapshot.error = event.message
        case "cleared":
            snapshot.buffer = ""
        case "activity":
            snapshot.title = event.label ?? snapshot.title
            snapshot.hasRunningSubprocess = event.hasRunningSubprocess
                ?? snapshot.hasRunningSubprocess
        default:
            break
        }
        terminalSnapshots[key] = snapshot
        return snapshot
    }

    private func mergeTerminalSummary(
        _ summary: TerminalSummary,
        threadID: String
    ) -> FeatureTerminalSnapshot {
        let key = TerminalKey(threadID: threadID, terminalID: summary.terminalId)
        var snapshot = NativeWorkspaceMapper.terminal(summary)
        snapshot.threadID = threadID
        if let cached = terminalSnapshots[key] {
            snapshot.buffer = cached.buffer
            snapshot.error = cached.error
        }
        terminalSnapshots[key] = snapshot
        return snapshot
    }

    /// A verbose command can stream megabytes; the viewer only ever shows the
    /// tail, so cap retained history to keep layout and memory bounded.
    private static let terminalBufferLimit = 512 * 1024

    private static func cappedTerminalBuffer(_ buffer: String) -> String {
        let utf8 = buffer.utf8
        guard utf8.count > terminalBufferLimit else { return buffer }
        // Slice in UTF-8 bytes (the unit the limit is defined in), then snap
        // forward to a character boundary so multibyte output cannot blow
        // past the cap or tear a scalar.
        let byteStart = utf8.index(utf8.endIndex, offsetBy: -terminalBufferLimit)
        var start = byteStart.samePosition(in: buffer)
        if start == nil {
            var probe = byteStart
            while probe < utf8.endIndex, start == nil {
                probe = utf8.index(after: probe)
                start = probe.samePosition(in: buffer)
            }
        }
        guard let start else { return buffer }
        let tail = buffer[start...]
        // Trim to the next line boundary so the top of the view isn't a torn line.
        if let newline = tail.firstIndex(of: "\n") {
            return String(tail[tail.index(after: newline)...])
        }
        return String(tail)
    }

    private func startPolling(_ activeClient: T3Client) {
        pollingTask?.cancel()
        fallbackPollingTask?.cancel()
        configurationTask?.cancel()
        let generation = environmentGeneration
        pollingTask = Task { [weak self] in
            do {
                await activeClient.connect()
                guard self?.isCurrentSession(
                    client: activeClient,
                    generation: generation
                ) == true else {
                    return
                }
                let sequence = self?.latestShell?.snapshotSequence
                let events = await activeClient.shellEvents(after: sequence)
                // Re-bind self per event instead of holding it strongly across
                // the indefinite stream, so the client can deinit mid-stream.
                for try await item in events {
                    guard !Task.isCancelled,
                          let self,
                          self.isCurrentSession(
                              client: activeClient,
                              generation: generation
                          ) else {
                        break
                    }
                    self.lastShellEventAt = .now
                    self.emitConnection(.connected)
                    switch item {
                    case let .snapshot(shell):
                        await self.consume(
                            shell: shell,
                            client: activeClient,
                            refreshActiveThread: true
                        )
                    case .projectUpdated, .projectRemoved, .threadUpdated, .threadRemoved:
                        await self.consume(delta: item, client: activeClient)
                    case .synchronized:
                        break
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                // The independent HTTP fallback below keeps the workspace
                // fresh while the socket reconnects.
            }

            guard !Task.isCancelled,
                  let self,
                  self.isCurrentSession(client: activeClient, generation: generation) else {
                return
            }
            self.emitConnection(
                .reconnecting,
                detail: "Live updates paused. Refreshing over HTTP."
            )
        }
        let fallbackPollingInitialDelay = fallbackPollingInitialDelay
        let fallbackPollingInterval = fallbackPollingInterval
        fallbackPollingTask = Task { [weak self] in
            do {
                try await Task.sleep(for: fallbackPollingInitialDelay)
            } catch {
                return
            }
            while !Task.isCancelled {
                guard let self,
                      self.isCurrentSession(
                          client: activeClient,
                          generation: generation
                      ) else {
                    return
                }
                let socketIsSynchronized =
                    await activeClient.liveConnectionActive()
                    && self.lastShellEventAt != nil
                if !socketIsSynchronized {
                    self.emitConnection(
                        .reconnecting,
                        detail: "Live updates reconnecting. Refreshing over HTTP."
                    )
                    do {
                        let shell = try await activeClient.shellSnapshot()
                        guard !Task.isCancelled,
                              self.isCurrentSession(
                                  client: activeClient,
                                  generation: generation
                              ) else {
                            return
                        }
                        await self.consumeFallbackShell(
                            shell: shell,
                            client: activeClient,
                            generation: generation
                        )
                    } catch is CancellationError {
                        return
                    } catch {
                        guard !Task.isCancelled,
                              self.isCurrentSession(
                                  client: activeClient,
                                  generation: generation
                              ) else {
                            return
                        }
                        self.emitConnection(
                            .reconnecting,
                            detail: "Server unreachable. Retrying automatically."
                        )
                    }
                }
                do {
                    try await Task.sleep(for: fallbackPollingInterval)
                } catch {
                    return
                }
            }
        }
        configurationTask = Task { [weak self] in
            do {
                for try await event in await activeClient.serverConfigEvents() {
                    guard !Task.isCancelled,
                          let self,
                          self.isCurrentSession(
                              client: activeClient,
                              generation: generation
                          ) else {
                        break
                    }
                    switch event {
                    case let .snapshot(config):
                        self.latestServerConfig = config
                        self.setServerConfig(config, environmentID: activeClient.environment.id)
                    // A delta event reports one slice of the config. Every field
                    // it does not carry is copied from the last full snapshot —
                    // `t3WorkDirectory` in particular, because dropping it would
                    // silently disable T3 Work the first time a provider changed
                    // status.
                    case let .providerStatuses(providers):
                        let previous = self.serverConfigsByEnvironmentID[
                            activeClient.environment.id
                        ]
                        let config = ServerConfigSnapshot(
                            providers: providers,
                            settings: previous?.settings,
                            t3WorkDirectory: previous?.t3WorkDirectory,
                            threadSnapshotWindow: previous?.threadSnapshotWindow,
                            threadResumeCompletionMarker: previous?.threadResumeCompletionMarker,
                            shellResumeCompletionMarker: previous?.shellResumeCompletionMarker
                        )
                        self.latestServerConfig = config
                        self.setServerConfig(config, environmentID: activeClient.environment.id)
                    case let .settingsUpdated(settings):
                        let previous = self.serverConfigsByEnvironmentID[
                            activeClient.environment.id
                        ]
                        let config = ServerConfigSnapshot(
                            providers: previous?.providers
                                ?? self.latestServerConfig?.providers ?? [],
                            settings: settings,
                            t3WorkDirectory: previous?.t3WorkDirectory,
                            threadSnapshotWindow: previous?.threadSnapshotWindow,
                            threadResumeCompletionMarker: previous?.threadResumeCompletionMarker,
                            shellResumeCompletionMarker: previous?.shellResumeCompletionMarker
                        )
                        self.latestServerConfig = config
                        self.setServerConfig(config, environmentID: activeClient.environment.id)
                    case .unrelated:
                        continue
                    }
                    if let shell = self.latestShell {
                        await self.emitSnapshot(shell)
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                // The shell and thread streams remain useful on older servers
                // that do not expose the provider catalogue subscription.
            }
        }
    }

    /// Non-active environments do not hold WebSocket subscriptions. A quiet
    /// HTTP refresh keeps their home rows and reachability useful without
    /// multiplying live streams or creating a high-frequency battery cost.
    private func startAggregateRefresh(_ activeClient: T3Client) {
        aggregateRefreshTask?.cancel()
        let generation = environmentGeneration
        let refreshID = UUID()
        let interval = aggregateRefreshInterval
        let loadEnvironments = aggregateEnvironmentLoader
        aggregateRefreshID = refreshID
        aggregateRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: interval)
                } catch {
                    return
                }
                guard let self,
                      self.aggregateRefreshID == refreshID,
                      self.isCurrentSession(
                          client: activeClient,
                          generation: generation
                      ),
                      let activeEnvironment = self.activeEnvironment else {
                    return
                }
                let environments: [Environment]
                do {
                    environments = try await loadEnvironments(self.runtime)
                } catch is CancellationError where Task.isCancelled {
                    return
                } catch {
                    // Persistence can be briefly unavailable while another
                    // actor atomically replaces the environment document.
                    // Keep the low-frequency loop alive for the next cadence.
                    continue
                }
                guard !Task.isCancelled,
                      self.aggregateRefreshID == refreshID,
                      self.isCurrentSession(
                          client: activeClient,
                          generation: generation
                      ) else {
                    return
                }
                let passiveEnvironments = environments.filter {
                    $0.id != activeEnvironment.id
                }
                guard !passiveEnvironments.isEmpty else { continue }
                let loads = await self.loadEnvironmentShells(passiveEnvironments)
                guard !Task.isCancelled,
                      self.aggregateRefreshID == refreshID,
                      self.isCurrentSession(
                          client: activeClient,
                          generation: generation
                      ) else {
                    return
                }
                self.reconcileEnvironmentLoads(loads, savedEnvironments: environments)
                let currentConnection = self.latestSnapshot?.connection
                    ?? FeatureConnection(
                        state: .disconnected,
                        environmentName: activeEnvironment.label,
                        endpoint: activeEnvironment.httpBaseURL.absoluteString
                    )
                let snapshot = self.makeSnapshot(
                    environments: environments,
                    activeEnvironment: activeEnvironment,
                    connectionState: currentConnection.state,
                    connectionDetail: currentConnection.detail
                )
                self.publish(snapshot)
            }
        }
    }

    private func consume(
        shell: OrchestrationV2ShellSnapshot,
        client: T3Client,
        refreshActiveThread: Bool
    ) async {
        guard let currentClient = self.client, currentClient === client else { return }
        shellPublishTask?.cancel()
        shellPublishTask = nil
        latestShell = shell
        await emitSnapshot(shell)
        if refreshActiveThread, let threadID = activeThreadID {
            scheduleDetailRefresh(threadID: threadID, client: client)
        }
    }

    /// HTTP fallback refreshes data while preserving the socket's reconnecting
    /// state. The generation travels through the awaited snapshot publish so a
    /// task from a previous environment session cannot publish late results.
    private func consumeFallbackShell(
        shell: OrchestrationV2ShellSnapshot,
        client: T3Client,
        generation: Int
    ) async {
        guard isCurrentSession(client: client, generation: generation) else { return }
        shellPublishTask?.cancel()
        shellPublishTask = nil
        latestShell = shell
        await emitSnapshot(
            shell,
            markSourceConnected: false,
            expectedGeneration: generation
        )
        guard isCurrentSession(client: client, generation: generation),
              let threadID = activeThreadID else {
            return
        }
        scheduleDetailRefresh(threadID: threadID, client: client)
    }

    private func consume(delta: OrchestrationV2ShellStreamItem, client: T3Client) async {
        guard let currentClient = self.client, currentClient === client else { return }
        guard let current = latestShell else {
            if let shell = try? await client.shellSnapshot() {
                await consume(shell: shell, client: client, refreshActiveThread: true)
            }
            return
        }

        let sequence: Int

        switch delta {
        case let .projectUpdated(nextSequence, _):
            sequence = nextSequence
        case let .projectRemoved(nextSequence, _):
            sequence = nextSequence
        case let .threadUpdated(nextSequence, _, _):
            sequence = nextSequence
        case let .threadRemoved(nextSequence, _, _):
            sequence = nextSequence
        case .snapshot, .synchronized:
            return
        }

        // Replayed deltas are expected after reconnect. They must be entirely
        // side-effect free, including for cached detail and selection state.
        guard sequence > current.snapshotSequence else { return }

        var projects = current.projects
        var threads = current.threads
        var changedThreadID: String?
        var shouldRefreshArchived = false

        switch delta {
        case let .projectUpdated(_, project):
            if let index = projects.firstIndex(where: { $0.id == project.id }) {
                projects[index] = project
            } else {
                projects.append(project)
            }
        case let .projectRemoved(_, projectID):
            projects.removeAll { $0.id == projectID }
        case let .threadUpdated(_, location, thread):
            changedThreadID = activeEnvironment.map {
                FeatureScopedID.thread(environmentID: $0.id, wireID: thread.id)
            }
            // V2 reports archiving as an update carrying `location: .archive`
            // rather than as a removal, so the thread has to move between the
            // two lists here or it would appear in both.
            switch location {
            case .active:
                if let environmentID = activeEnvironment?.id {
                    archivedThreadsByEnvironmentID[environmentID]?.removeAll {
                        ($0.wireID ?? $0.id) == thread.id
                    }
                    archivedShellThreadsByEnvironmentID[environmentID]?[thread.id] = nil
                }
                if let index = threads.firstIndex(where: { $0.id == thread.id }) {
                    threads[index] = thread
                } else {
                    threads.append(thread)
                }
            case .archive:
                threads.removeAll { $0.id == thread.id }
                if let environmentID = activeEnvironment?.id {
                    archivedShellThreadsByEnvironmentID[environmentID, default: [:]][thread.id] =
                        thread
                }
                shouldRefreshArchived = true
            }
        case let .threadRemoved(_, location, threadID):
            if location == .archive, let environmentID = activeEnvironment?.id {
                archivedShellThreadsByEnvironmentID[environmentID]?[threadID] = nil
                archivedThreadsByEnvironmentID[environmentID]?.removeAll {
                    ($0.wireID ?? $0.id) == threadID
                }
            }
            let uiThreadID = activeEnvironment.map {
                FeatureScopedID.thread(environmentID: $0.id, wireID: threadID)
            }
            changedThreadID = uiThreadID
            shouldRefreshArchived = true
            threads.removeAll { $0.id == threadID }
            if let uiThreadID {
                latestDetails[uiThreadID] = nil
            }
            if activeThreadID == uiThreadID {
                resetDetailRefresh()
                resetDetailStream()
                activeThreadID = nil
                activeThreadEnvironmentID = nil
                activeRawThread = nil
                activeThreadSequence = nil
                activeThreadPage = nil
                threadHistoryEpoch &+= 1
            }
        case .snapshot, .synchronized:
            return
        }

        var shell = current
        shell.snapshotSequence = sequence
        shell.projects = projects
        shell.threads = threads
        latestShell = shell
        scheduleShellPublish(client)
        if shouldRefreshArchived, let environment = activeEnvironment {
            scheduleArchivedRefresh(client: client, environment: environment)
        }
        if let changedThreadID, activeThreadID == changedThreadID {
            scheduleDetailRefresh(threadID: changedThreadID, client: client)
        }
    }

    /// Shell streams can emit many metadata updates during one provider turn.
    /// Home only needs the newest row state, so publish at most four times per
    /// second while the selected transcript continues on its dedicated stream.
    private func scheduleShellPublish(_ client: T3Client) {
        guard shellPublishTask == nil else { return }
        let generation = environmentGeneration
        shellPublishTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard let self else { return }
            self.shellPublishTask = nil
            guard !Task.isCancelled,
                  self.isCurrentSession(client: client, generation: generation),
                  let shell = self.latestShell else {
                return
            }
            await self.emitSnapshot(shell)
        }
    }

    private func scheduleDetailRefresh(
        threadID: String,
        client: T3Client,
        force: Bool = false
    ) {
        guard activeThreadID == threadID,
              activeThreadEnvironmentID == client.environment.id else { return }
        guard force || detailStreamTask == nil else { return }
        guard detailRefreshTask == nil else {
            detailRefreshPending = true
            return
        }
        detailRefreshPending = false
        detailRefreshGeneration &+= 1
        let generation = detailRefreshGeneration
        let sessionGeneration = environmentGeneration
        detailRefreshTask = Task { [weak self] in
            do {
                // Four updates per second keeps streaming text responsive while
                // coalescing bursty shell events into one detail snapshot.
                try await Task.sleep(for: .milliseconds(250))
            } catch {
                self?.finishDetailRefresh(generation: generation, client: client)
                return
            }
            guard let self else { return }
            if !Task.isCancelled,
               self.activeThreadID == threadID,
               self.isKnownClient(
                   client,
                   environmentID: client.environment.id,
                   generation: sessionGeneration
               ) {
                try? await self.refreshThread(id: threadID, client: client)
            }
            self.finishDetailRefresh(generation: generation, client: client)
        }
    }

    private func startDetailStream(
        _ route: NativeThreadRoute,
        after sequence: Int,
        snapshotMaxVisibleItems: Int?
    ) {
        detailStreamGeneration &+= 1
        let streamGeneration = detailStreamGeneration
        let sessionGeneration = environmentGeneration
        detailStreamTask = Task { [weak self] in
            do {
                for try await item in await route.client.threadEvents(
                    threadID: route.wireID,
                    after: sequence,
                    snapshotMaxVisibleItems: snapshotMaxVisibleItems
                ) {
                    guard !Task.isCancelled,
                          let self,
                          self.detailStreamGeneration == streamGeneration,
                          self.activeThreadID == route.uiID,
                          self.isKnownClient(
                              route.client,
                              environmentID: route.environmentID,
                              generation: sessionGeneration
                          ) else {
                        break
                    }
                    self.consumeDetailStreamItem(item, route: route)
                }
            } catch is CancellationError {
                return
            } catch {
                // Shell-driven HTTP refresh remains the compatibility fallback.
            }
            guard let self else { return }
            self.finishDetailStream(
                generation: streamGeneration,
                route: route,
                sessionGeneration: sessionGeneration
            )
        }
    }

    private func consumeDetailStreamItem(
        _ item: OrchestrationV2ThreadStreamItem,
        route: NativeThreadRoute
    ) {
        switch item {
        case .synchronized:
            return
        case let .snapshot(snapshot):
            guard snapshot.snapshotSequence > (activeThreadSequence ?? 0) else { return }
            threadHistoryEpoch &+= 1
            activeThreadSequence = snapshot.snapshotSequence
            activeRawThread = snapshot.projection
            activeThreadPage = featurePage(
                truncatedVisibleItemCount: snapshot.projection.truncatedVisibleItemCount
            )
            scheduleRawDetailPublish(route: route)
        case let .event(sequence, event):
            guard let current = activeRawThread else {
                scheduleDetailRefresh(threadID: route.uiID, client: route.client, force: true)
                return
            }
            let reduction = NativeThreadDetailReducer.apply(event, to: current)
            // A negative sequence marks an event the reducer refuses to fold.
            // Fall back to the frame's own sequence for ordering.
            let effective = reduction.sequence < 0 ? sequence : reduction.sequence
            switch reduction.result {
            case let .updated(projection):
                guard effective > (activeThreadSequence ?? 0) else { return }
                activeThreadSequence = effective
                activeRawThread = projection
                scheduleRawDetailPublish(route: route)
            case .unchanged:
                guard effective > (activeThreadSequence ?? 0) else { return }
                activeThreadSequence = effective
            case .refresh:
                threadHistoryEpoch &+= 1
                activeThreadSequence = effective
                activeRawThread = nil
                discardPendingDetailPublish()
                scheduleDetailRefresh(threadID: route.uiID, client: route.client, force: true)
            }
        }
    }

    private func scheduleRawDetailPublish(route: NativeThreadRoute) {
        guard detailPublishTask == nil else { return }
        let streamGeneration = detailStreamGeneration
        detailPublishTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(80))
            guard let self else { return }
            self.detailPublishTask = nil
            guard !Task.isCancelled,
                  self.detailStreamGeneration == streamGeneration,
                  self.activeThreadID == route.uiID,
                  let rawThread = self.activeRawThread else {
                return
            }
            let previousDetail = self.latestDetails[route.uiID]
            let detail = self.mapDetail(
                rawThread,
                environment: route.client.environment,
                page: self.activeThreadPage
            )
            let delta = self.makeDetailDelta(previous: previousDetail, next: detail)
            self.publish(
                detail,
                threadID: route.uiID,
                renderCacheIsSource: true,
                delta: delta
            )
            self.scheduleAttachmentHydration(
                in: detail,
                threadID: route.uiID,
                client: route.client,
                environmentID: route.environmentID
            )
        }
    }

    private func finishDetailStream(
        generation: Int,
        route: NativeThreadRoute,
        sessionGeneration: Int
    ) {
        guard detailStreamGeneration == generation,
              activeThreadID == route.uiID,
              isKnownClient(
                  route.client,
                  environmentID: route.environmentID,
                  generation: sessionGeneration
              ) else {
            return
        }
        detailStreamTask = nil
        scheduleDetailRefresh(threadID: route.uiID, client: route.client)
        startPassiveDetailPolling(route)
    }

    /// Passive environments intentionally avoid full shell WebSocket streams.
    /// A selected passive thread is still live enough to drive remotely.
    private func startPassiveDetailPolling(_ route: NativeThreadRoute) {
        passiveDetailPollingTask?.cancel()
        passiveDetailPollingTask = nil
        guard route.environmentID != activeEnvironment?.id else { return }
        let generation = environmentGeneration
        passiveDetailPollingTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(2))
                } catch {
                    return
                }
                guard let self,
                      self.activeThreadID == route.uiID,
                      self.isKnownClient(
                          route.client,
                          environmentID: route.environmentID,
                          generation: generation
                      ) else {
                    return
                }
                try? await self.refreshThread(id: route.uiID, client: route.client)
            }
        }
    }

    private func finishDetailRefresh(generation: Int, client: T3Client) {
        guard detailRefreshGeneration == generation else { return }
        detailRefreshTask = nil
        let needsTrailingRefresh = detailRefreshPending
        detailRefreshPending = false
        if needsTrailingRefresh, let threadID = activeThreadID {
            scheduleDetailRefresh(threadID: threadID, client: client)
        }
    }

    private func resetDetailRefresh() {
        detailRefreshGeneration &+= 1
        detailRefreshTask?.cancel()
        detailRefreshTask = nil
        detailRefreshPending = false
    }

    private func resetDetailStream() {
        detailStreamGeneration &+= 1
        detailStreamTask?.cancel()
        detailStreamTask = nil
        discardPendingDetailPublish()
    }

    private func discardPendingDetailPublish() {
        detailPublishTask?.cancel()
        detailPublishTask = nil
    }

    private func loadEnvironmentShells(
        _ environments: [Environment]
    ) async -> [EnvironmentShellLoad] {
        let activeEnvironmentID = activeEnvironment?.id
        let environmentsWithCachedConfig = Set(serverConfigsByEnvironmentID.keys)
        let shellTimeoutInterval = environmentShellTimeoutInterval
        let runtime = runtime
        var clients: [(environment: Environment, client: T3Client)] = []
        clients.reserveCapacity(environments.count)
        for environment in environments {
            clients.append(
                (environment, await runtime.client(for: environment))
            )
        }

        return await withTaskGroup(of: EnvironmentShellLoad.self) { group in
            for pair in clients {
                group.addTask {
                    let shell = try? await pair.client.shellSnapshot(
                        timeoutInterval: shellTimeoutInterval
                    )
                    guard shell != nil else {
                        return EnvironmentShellLoad(
                            environment: pair.environment,
                            client: pair.client,
                            shell: nil,
                            config: nil
                        )
                    }

                    let isActive = pair.environment.id == activeEnvironmentID
                    let shouldFetchConfig = isActive
                        || !environmentsWithCachedConfig.contains(pair.environment.id)
                    var config: ServerConfigSnapshot?
                    if shouldFetchConfig {
                        if isActive {
                            config = try? await pair.client.serverConfig()
                        } else {
                            // A passive catalogue is a bounded one-shot RPC on
                            // an uncached client. Never disconnect the shared
                            // client because the environment may become active
                            // while this aggregate load is in flight.
                            let probe = await runtime.ephemeralClient(
                                for: pair.environment
                            )
                            config = try? await probe.serverConfig()
                            await probe.disconnect()
                        }
                    }
                    return EnvironmentShellLoad(
                        environment: pair.environment,
                        client: pair.client,
                        shell: shell,
                        config: config
                    )
                }
            }
            var loads: [EnvironmentShellLoad] = []
            loads.reserveCapacity(environments.count)
            for await load in group {
                loads.append(load)
            }
            return loads
        }
    }

    /// Successful reads replace that environment's cache. Failed reads leave
    /// its last-known rows intact, so one offline machine cannot empty home.
    private func reconcileEnvironmentLoads(
        _ loads: [EnvironmentShellLoad],
        savedEnvironments: [Environment]
    ) {
        let savedIDs = Set(savedEnvironments.map(\.id))
        environmentClients = environmentClients.filter { savedIDs.contains($0.key) }
        shellsByEnvironmentID = shellsByEnvironmentID.filter { savedIDs.contains($0.key) }
        serverConfigsByEnvironmentID = serverConfigsByEnvironmentID.filter {
            savedIDs.contains($0.key)
        }
        providerCatalogCache = providerCatalogCache.filter {
            savedIDs.contains($0.key)
        }
        archivedThreadsByEnvironmentID = archivedThreadsByEnvironmentID.filter {
            savedIDs.contains($0.key)
        }
        archivedShellThreadsByEnvironmentID = archivedShellThreadsByEnvironmentID.filter {
            savedIDs.contains($0.key)
        }
        environmentConnectionStates = environmentConnectionStates.filter {
            savedIDs.contains($0.key)
        }
        environmentConnectionDetails = environmentConnectionDetails.filter {
            savedIDs.contains($0.key)
        }

        for load in loads {
            environmentClients[load.environment.id] = load.client
            if let config = load.config {
                setServerConfig(config, environmentID: load.environment.id)
                if load.environment.id == activeEnvironment?.id {
                    latestServerConfig = config
                }
            }
            if let shell = load.shell {
                shellsByEnvironmentID[load.environment.id] = shell
                environmentConnectionStates[load.environment.id] = .connected
                environmentConnectionDetails[load.environment.id] = nil
            } else {
                environmentConnectionStates[load.environment.id] = .disconnected
                environmentConnectionDetails[load.environment.id] =
                    "That server is currently unreachable."
            }
        }
        rebuildEntityIndexes(savedEnvironments)
    }

    private func rebuildEntityIndexes(_ environments: [Environment]) {
        let savedIDs = Set(environments.map(\.id))
        provisionalThreadRoutes = provisionalThreadRoutes.filter {
            savedIDs.contains($0.value.environmentID)
        }

        var nextProjectEnvironments: [String: String] = [:]
        var nextProjectWireIDs: [String: String] = [:]
        var nextThreadEnvironments: [String: String] = [:]
        var nextThreadWireIDs: [String: String] = [:]
        var projectCandidates: [String: Set<EntityWireOwner>] = [:]
        var threadCandidates: [String: Set<EntityWireOwner>] = [:]
        var materializedThreadIDs: Set<String> = []

        for environment in environments {
            let environmentID = environment.id
            for project in shellsByEnvironmentID[environmentID]?.projects ?? [] {
                let uiID = FeatureScopedID.project(
                    environmentID: environmentID,
                    wireID: project.id
                )
                nextProjectEnvironments[uiID] = environmentID
                nextProjectWireIDs[uiID] = project.id
                projectCandidates[project.id, default: []].insert(
                    EntityWireOwner(environmentID: environmentID, wireID: project.id)
                )
            }
            for thread in shellsByEnvironmentID[environmentID]?.threads ?? [] {
                let uiID = FeatureScopedID.thread(
                    environmentID: environmentID,
                    wireID: thread.id
                )
                nextThreadEnvironments[uiID] = environmentID
                nextThreadWireIDs[uiID] = thread.id
                materializedThreadIDs.insert(uiID)
                threadCandidates[thread.id, default: []].insert(
                    EntityWireOwner(environmentID: environmentID, wireID: thread.id)
                )
            }
            for thread in archivedThreadsByEnvironmentID[environmentID] ?? [] {
                let wireID = thread.wireID ?? thread.id
                let uiID = FeatureScopedID.thread(
                    environmentID: environmentID,
                    wireID: wireID
                )
                nextThreadEnvironments[uiID] = environmentID
                nextThreadWireIDs[uiID] = wireID
                materializedThreadIDs.insert(uiID)
                threadCandidates[wireID, default: []].insert(
                    EntityWireOwner(environmentID: environmentID, wireID: wireID)
                )
            }
        }

        provisionalThreadRoutes = provisionalThreadRoutes.filter {
            !materializedThreadIDs.contains($0.key)
        }
        for (uiID, provisional) in provisionalThreadRoutes {
            nextThreadEnvironments[uiID] = provisional.environmentID
            nextThreadWireIDs[uiID] = provisional.wireID
            threadCandidates[provisional.wireID, default: []].insert(
                EntityWireOwner(
                    environmentID: provisional.environmentID,
                    wireID: provisional.wireID
                )
            )
        }

        // Raw IDs remain accepted for source-compatible fixtures only when
        // their owner is unambiguous. Native snapshots always use scoped IDs.
        for (rawID, candidates) in projectCandidates where candidates.count == 1 {
            guard let owner = candidates.first else { continue }
            nextProjectEnvironments[rawID] = owner.environmentID
            nextProjectWireIDs[rawID] = owner.wireID
        }
        for (rawID, candidates) in threadCandidates where candidates.count == 1 {
            guard let owner = candidates.first else { continue }
            nextThreadEnvironments[rawID] = owner.environmentID
            nextThreadWireIDs[rawID] = owner.wireID
        }

        projectEnvironmentIDs = nextProjectEnvironments
        projectWireIDs = nextProjectWireIDs
        threadEnvironmentIDs = nextThreadEnvironments
        threadWireIDs = nextThreadWireIDs
    }

    private func refresh(client: T3Client, includeArchived: Bool = false) async throws {
        let environment = client.environment
        let generation = environmentGeneration
        let shell = try await client.shellSnapshot()
        guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
            throw CancellationError()
        }
        shellsByEnvironmentID[environment.id] = shell
        if activeEnvironment?.id == environment.id {
            latestShell = shell
        }
        rebuildEntityIndexes(
            (try? await runtime.environments()) ?? [environment]
        )
        if includeArchived,
           let archivedShell = try? await client.archivedShellSnapshot(),
           isKnownClient(client, environmentID: environment.id, generation: generation) {
            archivedThreadsByEnvironmentID[environment.id] = archivedShell.threads.map {
                mapThread($0, environment: environment)
            }
            archivedShellThreadsByEnvironmentID[environment.id] = Dictionary(
                uniqueKeysWithValues: archivedShell.threads.map { ($0.id, $0) }
            )
            rebuildEntityIndexes((try? await runtime.environments()) ?? [environment])
        }
        await emitSnapshot(shell, environment: environment)
    }

    private func scheduleArchivedRefresh(client: T3Client, environment: Environment) {
        archivedRefreshTask?.cancel()
        let generation = environmentGeneration
        archivedRefreshTask = Task { [weak self] in
            guard let self,
                  let archivedShell = try? await client.archivedShellSnapshot(),
                  !Task.isCancelled,
                  self.isCurrentSession(client: client, generation: generation) else {
                return
            }
            self.archivedThreadsByEnvironmentID[environment.id] = archivedShell.threads.map {
                self.mapThread($0, environment: environment)
            }
            self.archivedShellThreadsByEnvironmentID[environment.id] = Dictionary(
                uniqueKeysWithValues: archivedShell.threads.map { ($0.id, $0) }
            )
            self.rebuildEntityIndexes(
                (try? await self.runtime.environments()) ?? [environment]
            )
            if let shell = self.latestShell {
                await self.emitSnapshot(shell)
            }
        }
    }

    private func refreshThread(id: String, client: T3Client) async throws {
        let route = try threadRoute(for: id)
        guard route.client === client else {
            throw NativeFeatureClientError.threadNotFound
        }
        let environment = route.client.environment
        let generation = environmentGeneration
        let supportsPagination = serverConfigsByEnvironmentID[
            environment.id
        ]?.threadSnapshotWindow == true
        let snapshot = try await client.threadSnapshot(
            id: route.wireID,
            maxVisibleItems: supportsPagination ? Self.initialThreadVisibleItemLimit : nil
        )
        guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
            throw CancellationError()
        }
        if activeThreadID == route.uiID {
            guard snapshot.snapshotSequence >= (activeThreadSequence ?? 0) else { return }
            threadHistoryEpoch &+= 1
            activeRawThread = snapshot.projection
            activeThreadSequence = snapshot.snapshotSequence
            activeThreadPage = featurePage(
                truncatedVisibleItemCount: snapshot.projection.truncatedVisibleItemCount
            )
        }
        let detail = mapDetail(
            snapshot.projection,
            environment: environment,
            page: activeThreadID == route.uiID
                ? activeThreadPage
                : featurePage(
                    truncatedVisibleItemCount: snapshot.projection.truncatedVisibleItemCount
                )
        )
        publish(detail, threadID: route.uiID)
        let hydrationBase = latestDetails[route.uiID] ?? detail
        let hydrated = await hydratedAttachmentURLs(
            in: hydrationBase,
            client: client,
            environmentID: environment.id,
            generation: generation
        )
        guard isKnownClient(client, environmentID: environment.id, generation: generation),
              latestDetails[route.uiID] == hydrationBase,
              hydrated != hydrationBase else {
            return
        }
        publish(hydrated, threadID: route.uiID)
    }

    private func emitSnapshot(
        _ shell: OrchestrationV2ShellSnapshot,
        environment sourceEnvironment: Environment? = nil,
        markSourceConnected: Bool = true,
        expectedGeneration: Int? = nil
    ) async {
        guard let environment = activeEnvironment else { return }
        let sourceEnvironment = sourceEnvironment ?? environment
        let generation = environmentGeneration
        guard expectedGeneration == nil || expectedGeneration == generation else { return }
        let environments = (try? await runtime.environments()) ?? [environment]
        guard generation == environmentGeneration,
              expectedGeneration == nil || expectedGeneration == environmentGeneration,
              activeEnvironment?.id == environment.id else {
            return
        }
        shellsByEnvironmentID[sourceEnvironment.id] = shell
        if markSourceConnected {
            environmentConnectionStates[sourceEnvironment.id] = .connected
            environmentConnectionDetails[sourceEnvironment.id] = nil
        }
        if sourceEnvironment.id == environment.id {
            latestShell = shell
        }
        rebuildEntityIndexes(environments)
        schedulePinnedPreviewURLReads(for: sourceEnvironment, shell: shell)
        let connectionState: FeatureConnection.State
        let connectionDetail: String?
        if sourceEnvironment.id == environment.id, markSourceConnected {
            connectionState = .connected
            connectionDetail = nil
        } else {
            connectionState = latestSnapshot?.connection.state
                ?? environmentConnectionStates[environment.id]
                ?? .disconnected
            connectionDetail = latestSnapshot?.connection.detail
        }
        let snapshot = makeSnapshot(
            environments: environments,
            activeEnvironment: environment,
            connectionState: connectionState,
            connectionDetail: connectionDetail
        )
        publish(snapshot)
    }

    /// Thread-only shell changes stay granular so Home does not replace and
    /// diff the aggregate snapshot for every active turn update. Structural
    /// changes retain the canonical snapshot event as a safe fallback.
    private func publish(_ snapshot: FeatureSnapshot) {
        guard let previous = latestSnapshot else {
            latestSnapshot = snapshot
            continuation.yield(.snapshot(snapshot))
            return
        }
        guard previous != snapshot else { return }
        latestSnapshot = snapshot

        guard canPublishThreadDelta(from: previous, to: snapshot) else {
            continuation.yield(.snapshot(snapshot))
            return
        }

        let previousByID = previous.threads.reduce(into: [String: FeatureThread]()) {
            $0[$1.id] = $1
        }
        let nextByID = snapshot.threads.reduce(into: [String: FeatureThread]()) {
            $0[$1.id] = $1
        }
        let removedIDs = previous.threads.compactMap { thread in
            nextByID[thread.id] == nil ? thread.id : nil
        }
        let changedThreads = snapshot.threads.filter { previousByID[$0.id] != $0 }

        guard !removedIDs.isEmpty || !changedThreads.isEmpty else {
            // A count-only project correction has no corresponding thread
            // event that could reproduce it in the feature model.
            continuation.yield(.snapshot(snapshot))
            return
        }
        for id in removedIDs {
            continuation.yield(.threadRemoved(id: id))
        }
        for thread in changedThreads {
            continuation.yield(.thread(thread))
        }
    }

    private func canPublishThreadDelta(
        from previous: FeatureSnapshot,
        to next: FeatureSnapshot
    ) -> Bool {
        previous.connection == next.connection
            && previous.environments == next.environments
            && previous.providers == next.providers
            && previous.settings == next.settings
            && projectsMatchIgnoringThreadCounts(previous.projects, next.projects)
    }

    private func projectsMatchIgnoringThreadCounts(
        _ lhs: [FeatureProject],
        _ rhs: [FeatureProject]
    ) -> Bool {
        guard lhs.count == rhs.count else { return false }
        return zip(lhs, rhs).allSatisfy { left, right in
            left.id == right.id
                && left.wireID == right.wireID
                && left.environmentID == right.environmentID
                && left.name == right.name
                && left.path == right.path
                && left.defaultSelection == right.defaultSelection
        }
    }

    /// Preserve the unchanged transcript prefix when a streaming update only
    /// replaces the tail message. The public event remains authoritative and
    /// backwards compatible for non-native FeatureClient implementations.
    private func publish(
        _ detail: FeatureThreadDetail,
        threadID: String,
        renderCacheIsSource: Bool = false,
        delta: FeatureDetailDelta? = nil
    ) {
        if renderCacheIsSource {
            // The projection rebuild is already authoritative; skip the prefix
            // comparison across the whole transcript.
            latestDetails[threadID] = detail
            if let delta {
                continuation.yield(.detailDelta(detail, delta))
            } else {
                continuation.yield(.detail(detail))
            }
            return
        }
        let next = latestDetails[threadID].map { current in
            mergedDetail(current: current, incoming: detail)
        } ?? detail
        guard latestDetails[threadID] != next else { return }
        latestDetails[threadID] = next
        continuation.yield(.detail(next))
    }

    /// The row-level delta the recycled transcript uses to avoid rescanning.
    ///
    /// V1 derived this from reducer mutation hints. The V2 projection is
    /// rebuilt wholesale, so the delta is computed by comparing the previous and
    /// next details directly — same result, and it cannot disagree with what was
    /// actually rendered.
    private func makeDetailDelta(
        previous: FeatureThreadDetail?,
        next: FeatureThreadDetail
    ) -> FeatureDetailDelta? {
        guard let previous else { return nil }

        let previousByID = Dictionary(
            previous.messages.map { ($0.id, $0) },
            uniquingKeysWith: { _, last in last }
        )
        // A message that vanished means the transcript was restructured, not
        // appended to; a full rebuild is the honest response.
        let nextIDs = Set(next.messages.map(\.id))
        guard previous.messages.allSatisfy({ nextIDs.contains($0.id) }) else { return nil }

        var changed: [FeatureMessage] = []
        var appended: [String] = []
        for message in next.messages {
            guard let existing = previousByID[message.id] else {
                appended.append(message.id)
                changed.append(message)
                continue
            }
            if existing != message { changed.append(message) }
        }

        if changed.isEmpty, appended.isEmpty { return nil }
        return FeatureDetailDelta(changedMessages: changed, appendedMessageIDs: appended)
    }

    private func mergedDetail(
        current: FeatureThreadDetail,
        incoming: FeatureThreadDetail
    ) -> FeatureThreadDetail {
        // The suffix merge exists to keep unchanged rendered rows identical so
        // the transcript updates in place. The projection passthrough is not
        // rendered directly and is always whole, so it is taken from the
        // incoming detail rather than merged.
        FeatureThreadDetail(
            thread: incoming.thread,
            messages: replacingChangedSuffix(current.messages, with: incoming.messages),
            approvals: replacingChangedSuffix(current.approvals, with: incoming.approvals),
            userInputs: replacingChangedSuffix(current.userInputs, with: incoming.userInputs),
            page: incoming.page,
            timelineItems: incoming.timelineItems,
            timelineRuns: incoming.timelineRuns,
            itemSupport: incoming.itemSupport,
            subagentChildThreadIDs: incoming.subagentChildThreadIDs,
            workflow: incoming.workflow
        )
    }

    private func replacingChangedSuffix<Element: Equatable>(
        _ current: [Element],
        with incoming: [Element]
    ) -> [Element] {
        guard current != incoming else { return current }
        let prefixCount = zip(current, incoming).prefix { pair in
            pair.0 == pair.1
        }.count
        var result = current
        result.replaceSubrange(prefixCount..., with: incoming.dropFirst(prefixCount))
        return result
    }

    private func disconnectedSnapshot(
        environments: [Environment],
        detail: String? = nil
    ) -> FeatureSnapshot {
        FeatureSnapshot(
            connection: .init(state: .disconnected, detail: detail),
            environments: environments.map { mapEnvironment($0, activeID: nil) },
            settings: loadSettings()
        )
    }

    private func emitConnection(
        _ state: FeatureConnection.State,
        detail: String? = nil
    ) {
        guard let environment = activeEnvironment else { return }
        // Shell event loops call this per event; only publish real transitions.
        guard environmentConnectionStates[environment.id] != state
            || environmentConnectionDetails[environment.id] != detail else { return }
        environmentConnectionStates[environment.id] = state
        environmentConnectionDetails[environment.id] = detail
        let connection = FeatureConnection(
            state: state,
            environmentName: environment.label,
            endpoint: environment.httpBaseURL.absoluteString,
            detail: detail
        )
        if var snapshot = latestSnapshot {
            snapshot.connection = connection
            if let index = snapshot.environments.firstIndex(where: { $0.id == environment.id }) {
                snapshot.environments[index].connectionState = state
                snapshot.environments[index].connectionDetail = detail
            }
            latestSnapshot = snapshot
        }
        continuation.yield(
            .connection(connection)
        )
    }

    private func makeSnapshot(
        environments: [Environment],
        activeEnvironment: Environment,
        connectionState: FeatureConnection.State,
        connectionDetail: String? = nil
    ) -> FeatureSnapshot {
        let threads = environments.flatMap { environment in
            let live = shellsByEnvironmentID[environment.id]?.threads.map {
                mapThread($0, environment: environment)
            } ?? []
            let liveIDs = Set(live.map(\.id))
            let cached = (archivedThreadsByEnvironmentID[environment.id] ?? []).filter {
                !liveIDs.contains($0.id)
            }
            return live + cached
        }
        let threadCountByProjectID = threads.reduce(into: [String: Int]()) {
            $0[$1.projectID, default: 0] += 1
        }
        let projects = environments.flatMap { environment in
            (shellsByEnvironmentID[environment.id]?.projects ?? []).map { project in
                let uiID = FeatureScopedID.project(
                    environmentID: environment.id,
                    wireID: project.id
                )
                return FeatureProject(
                    id: uiID,
                    wireID: project.id,
                    environmentID: environment.id,
                    name: project.title,
                    path: project.workspaceRoot,
                    threadCount: threadCountByProjectID[uiID, default: 0],
                    defaultSelection: project.defaultModelSelection.map(mapSelection),
                    scripts: project.scripts,
                    previewUrl: pinnedPreviewURLs[uiID],
                    faviconPath: project.faviconPath
                )
            }
        }
        let providersByEnvironment = environments.reduce(
            into: [String: [FeatureProvider]]()
        ) { catalogues, environment in
            guard let shell = shellsByEnvironmentID[environment.id] else { return }
            catalogues[environment.id] = mapProviders(
                environmentID: environment.id,
                shell: shell,
                config: serverConfigsByEnvironmentID[environment.id]
            )
        }
        let preferencesByEnvironment = environments.reduce(
            into: [String: FeatureEnvironmentPreferences]()
        ) { preferences, environment in
            guard let serverSettings = serverConfigsByEnvironmentID[environment.id]?.settings else {
                return
            }
            let defaultWorkspaceMode: FeatureWorkspaceMode =
                switch serverSettings.defaultThreadEnvMode {
                case .local: .local
                case .worktree: .worktree
                }
            preferences[environment.id] = FeatureEnvironmentPreferences(
                defaultWorkspaceMode: defaultWorkspaceMode,
                newWorktreesStartFromOrigin: serverSettings.newWorktreesStartFromOrigin
            )
        }
        return FeatureSnapshot(
            connection: FeatureConnection(
                state: connectionState,
                environmentName: activeEnvironment.label,
                endpoint: activeEnvironment.httpBaseURL.absoluteString,
                detail: connectionDetail
            ),
            environments: environments.map {
                mapEnvironment($0, activeID: activeEnvironment.id)
            },
            projects: projects,
            threads: threads,
            providers: providersByEnvironment[activeEnvironment.id] ?? [],
            providersByEnvironment: providersByEnvironment,
            preferencesByEnvironment: preferencesByEnvironment,
            settings: loadSettings()
        )
    }

    private func mapEnvironment(_ environment: Environment, activeID: String?) -> FeatureEnvironment {
        FeatureEnvironment(
            id: environment.id,
            name: environment.label,
            endpoint: environment.httpBaseURL.absoluteString,
            isActive: environment.id == activeID,
            connectionState: environmentConnectionStates[environment.id],
            connectionDetail: environmentConnectionDetails[environment.id]
        )
    }

    // MARK: - V2 projection mapping

    /// Builds the whole detail from the projection.
    ///
    /// V1 kept an incremental cache because the transcript was assembled from
    /// two unordered sources (`messages` plus `activities`) and every event had
    /// to be folded in by hand. V2 hands over one ordered, already-windowed
    /// `visibleTurnItems` list, so rebuilding costs O(window) and the diffable
    /// collection view still updates only the rows whose identity or content
    /// changed. `MarkdownRenderCache` — which is what actually protects scroll
    /// performance — is keyed by message id and survives the rebuild.
    private func mapDetail(
        _ projection: OrchestrationV2ThreadProjection,
        environment: Environment,
        page: FeatureThreadPage? = nil
    ) -> FeatureThreadDetail {
        let threadID = FeatureScopedID.thread(
            environmentID: environment.id,
            wireID: projection.thread.id
        )

        var messages: [FeatureMessage] = []
        var approvals: [FeatureApproval] = []
        var userInputs: [FeatureUserInput] = []
        var timelineItems: [OrchestrationV2ProjectedTurnItem] = []
        var itemSupport: [String: ThreadActivityItemSupport] = [:]
        var subagentChildThreadIDs: [String: String] = [:]
        let support = ProjectionItemSupportIndex(projection)

        for projected in projection.visibleTurnItems.sorted(by: { $0.position < $1.position }) {
            let item = projected.item
            timelineItems.append(projected)
            itemSupport[projected.id] = support.resolve(item)
            if case let .subagent(subagentID, _, _, _, childThreadID?, _, _, _) = item.payload {
                subagentChildThreadIDs[subagentID] = FeatureScopedID.thread(
                    environmentID: environment.id,
                    wireID: childThreadID
                )
            }

            switch item.payload {
            case let .approvalRequest(requestID, requestKind, prompt):
                // The item's own status is the authority on whether the request
                // is still open; V1 had to pair requested/resolved activities.
                guard !item.status.isTerminal else { break }
                let uiID = FeatureScopedID.approval(
                    environmentID: environment.id,
                    wireID: requestID
                )
                approvalRoutes[uiID] = PendingRequestRoute(
                    threadID: threadID,
                    wireID: requestID
                )
                approvals.append(
                    FeatureApproval(
                        id: uiID,
                        wireID: requestID,
                        threadID: threadID,
                        kind: mapApprovalKind(requestKind),
                        title: item.base.title ?? approvalTitle(for: requestKind),
                        detail: prompt ?? ""
                    )
                )

            case let .userInputRequest(requestID, questions):
                guard !item.status.isTerminal else { break }
                let uiID = FeatureScopedID.input(
                    environmentID: environment.id,
                    wireID: requestID
                )
                inputRoutes[uiID] = PendingRequestRoute(
                    threadID: threadID,
                    wireID: requestID
                )
                userInputs.append(
                    FeatureUserInput(
                        id: uiID,
                        wireID: requestID,
                        threadID: threadID,
                        questions: questions.map {
                            FeatureInputQuestion(
                                id: $0.id,
                                header: $0.header,
                                question: $0.question,
                                options: $0.options.map {
                                    FeatureInputOption(label: $0.label, detail: $0.description)
                                }
                            )
                        }
                    )
                )

            default:
                if let message = mapTurnItem(item, environmentID: environment.id) {
                    messages.append(message)
                }
            }
        }

        var mappedThread = mapThread(
            projection.thread,
            latestRun: projection.runs.max(by: { $0.ordinal < $1.ordinal }),
            environment: environment
        )
        if !approvals.isEmpty {
            mappedThread.state = .waitingForApproval
        } else if !userInputs.isEmpty {
            mappedThread.state = .waitingForInput
        }

        return FeatureThreadDetail(
            thread: mappedThread,
            messages: messages,
            approvals: approvals,
            userInputs: userInputs,
            page: page,
            timelineItems: timelineItems,
            timelineRuns: projection.runs.map(Self.timelineRun),
            itemSupport: itemSupport,
            subagentChildThreadIDs: subagentChildThreadIDs,
            workflow: mapWorkflow(projection, environment: environment)
        )
    }

    /// The projection's relational tables, narrowed for the queue control and
    /// the relationship graph.
    ///
    /// Two scopes travel out of here on purpose. The provider joins keep wire
    /// ids because they only ever resolve against each other inside this one
    /// projection. Everything that names a *thread* to the UI — the open
    /// thread's own shell, its subagent children, both ends of a context
    /// transfer — is rewritten to feature-scoped ids, because those are what
    /// the relationship rows match against the home snapshot and what a tap
    /// routes with.
    private func mapWorkflow(
        _ projection: OrchestrationV2ThreadProjection,
        environment: Environment
    ) -> FeatureThreadWorkflow {
        func scoped(_ wireID: String) -> String {
            FeatureScopedID.thread(environmentID: environment.id, wireID: wireID)
        }

        let runs = projection.runs.map(ThreadWorkflowRun.init)
        // Only the queued runs' messages are carried: the transcript already
        // holds every other message, and these are the only ones the queue
        // renders. `messages` is the table `run.userMessageId` resolves against.
        let queuedMessageIDs = Set(
            projection.runs.lazy.filter { $0.status == "queued" }.compactMap(\.userMessageId)
        )
        var queuedMessageTexts: [String: String] = [:]
        var queuedMessageAttachmentCounts: [String: Int] = [:]
        for message in projection.messages where queuedMessageIDs.contains(message.id) {
            queuedMessageTexts[message.id] = message.text
            queuedMessageAttachmentCounts[message.id] = message.attachments.count
        }

        let subagents = projection.subagents.map { subagent -> ThreadRelationshipSubagentLink in
            let link = ThreadRelationshipSubagentLink(subagent)
            guard let childThreadID = link.childThreadID else { return link }
            return ThreadRelationshipSubagentLink(
                id: link.id,
                childThreadID: scoped(childThreadID),
                status: link.status,
                title: link.title,
                workflow: link.workflow,
                usage: link.usage
            )
        }

        let transfers = projection.contextTransfers.map { transfer in
            ThreadRelationshipTransferLink(
                id: transfer.id,
                sourceThreadID: scoped(transfer.sourceThreadId),
                targetThreadID: scoped(transfer.targetThreadId),
                status: transfer.status
            )
        }

        return FeatureThreadWorkflow(
            appThreadID: projection.thread.id,
            activeProviderThreadID: projection.thread.activeProviderThreadId,
            runs: runs,
            providerTurns: projection.providerTurns.map(ThreadWorkflowProviderTurn.init),
            providerThreads: projection.providerThreads.map(ThreadWorkflowProviderThread.init),
            providerSessions: projection.providerSessions.map(ThreadWorkflowSession.init),
            queuedMessageTexts: queuedMessageTexts,
            queuedMessageAttachmentCounts: queuedMessageAttachmentCounts,
            thread: relationshipShell(projection.thread, environment: environment, runs: runs),
            subagents: subagents,
            transfers: transfers
        )
    }

    /// The open thread as the relationship graph reads it.
    ///
    /// `AppThread` has no status column — it is a run-level notion — so the
    /// shell's status is preferred and the active run's status is the fallback,
    /// which is what the graph's edge statuses and orb states are derived from.
    private func relationshipShell(
        _ thread: OrchestrationV2AppThread,
        environment: Environment,
        runs: [ThreadWorkflowRun]
    ) -> ThreadRelationshipShell {
        func scoped(_ wireID: String) -> String {
            FeatureScopedID.thread(environmentID: environment.id, wireID: wireID)
        }
        let status = shellsByEnvironmentID[environment.id]?.threads
            .first { $0.id == thread.id }?
            .status
            ?? ThreadWorkflows.resolveActiveRun(runs: runs)?.status
            ?? "idle"
        let forkedFromRunThreadID: String? = if case let .run(sourceThreadID, _) = thread.forkedFrom {
            scoped(sourceThreadID)
        } else {
            nil
        }
        return ThreadRelationshipShell(
            id: scoped(thread.id),
            title: thread.title,
            status: status,
            parentThreadID: thread.lineage.parentThreadId.map(scoped),
            relationshipToParent: thread.lineage.relationshipToParent,
            forkedFromRunThreadID: forkedFromRunThreadID,
            archivedAt: thread.archivedAt,
            deletedAt: thread.deletedAt
        )
    }

    /// A run as the handoff rows read it.
    ///
    /// A handoff item persisted before models were stamped carries only instance
    /// ids, so the row recovers the origin model from run history. Empty strings
    /// on an older server are inert: the lookup simply fails to match and falls
    /// back to the instance ids the handoff item itself carries.
    private static func timelineRun(_ run: OrchestrationV2Run) -> LifecycleTimelineRun {
        LifecycleTimelineRun(
            id: run.id,
            ordinal: run.ordinal,
            providerInstanceID: run.providerInstanceId ?? "",
            model: run.modelSelection?.model ?? ""
        )
    }

    /// Renders one turn item as a transcript row.
    ///
    /// Returns nil only for items that are surfaced elsewhere in the UI. Every
    /// other type produces a row — including ones this build has no dedicated
    /// presentation for yet — because a silently dropped item reads to the user
    /// as the agent having done nothing.
    private func mapTurnItem(
        _ item: OrchestrationV2TurnItem,
        environmentID: String
    ) -> FeatureMessage? {
        let createdAt = parseDate(item.base.startedAt ?? item.base.updatedAt)

        func message(
            _ role: FeatureMessageRole,
            _ text: String,
            tool: String? = nil,
            state: FeatureMessageState? = nil
        ) -> FeatureMessage {
            FeatureMessage(
                id: item.id,
                role: role,
                text: text,
                createdAt: createdAt,
                state: state ?? (item.status.isTerminal ? .complete : .streaming),
                toolName: tool
            )
        }

        switch item.payload {
        case let .userMessage(_, _, text, attachments):
            return FeatureMessage(
                id: item.id,
                role: .user,
                text: text,
                createdAt: createdAt,
                state: .complete,
                attachments: attachments.map {
                    FeatureMessageAttachment(
                        id: $0.id,
                        name: $0.name,
                        mimeType: $0.mimeType,
                        sizeBytes: $0.sizeBytes,
                        url: cachedAttachmentURL(for: $0.id, environmentID: environmentID)
                    )
                },
                // Kept so the transcript can tell an agent-sent user message
                // from the reader's own, matching the RN feed.
                createdBy: item.base.createdBy
            )

        case let .assistantMessage(_, text, streaming):
            return message(.assistant, text, state: streaming ? .streaming : .complete)

        case let .reasoning(text, streaming):
            return message(.tool, text, tool: "Thinking", state: streaming ? .streaming : .complete)

        case let .proposedPlan(_, markdown, streaming):
            return message(.assistant, markdown, state: streaming ? .streaming : .complete)

        case let .todoList(_, steps, explanation):
            let rendered = steps.map { step in
                let mark = switch step.status {
                case "completed": "[x]"
                case "running": "[~]"
                default: "[ ]"
                }
                return "\(mark) \(step.text)"
            }
            let body = ([explanation].compactMap { $0 } + rendered).joined(separator: "\n")
            return message(.tool, body, tool: "Plan")

        case let .fileChange(fileName, additions, deletions, diffStr, _, _):
            var header = fileName
            if let additions, let deletions {
                header += "  +\(additions) −\(deletions)"
            }
            return message(.tool, diffStr ?? header, tool: header)

        case let .commandExecution(input, output, exitCode, liveness):
            var label = input
            if liveness.background == true { label = "background · \(label)" }
            if let exitCode, exitCode != 0 { label += "  (exit \(exitCode))" }
            return message(.tool, output ?? "", tool: label)

        case let .fileSearch(pattern, results):
            let body = (results ?? []).map(\.fileName).joined(separator: "\n")
            return message(.tool, body, tool: "Search \(pattern ?? "")")

        case let .webSearch(patterns, results):
            let body = (results ?? []).map { $0.title ?? $0.url ?? "" }.joined(separator: "\n")
            return message(.tool, body, tool: "Web search \((patterns ?? []).joined(separator: ", "))")

        case let .error(failure, _):
            return message(.system, failure.message, tool: failure.failureClass, state: .failed)

        case let .compaction(_, summary, before, after):
            var label = "Compacted history"
            if let before, let after { label += " · \(before) → \(after) tokens" }
            return message(.system, summary ?? "", tool: label)

        case let .checkpoint(_, _, files):
            let body = files
                .map { "\($0.path)  +\($0.additions) −\($0.deletions)" }
                .joined(separator: "\n")
            return message(.tool, body, tool: "Checkpoint · \(files.count) files")

        case let .checkpointRollback(_, _, restoredFileCount, rolledBackRunCount):
            return message(
                .system,
                "Restored \(restoredFileCount) files, discarding \(rolledBackRunCount) runs.",
                tool: "Rolled back"
            )

        case let .runInterruptRequest(text), let .runInterruptResult(text):
            return message(.system, text, tool: "Interrupted")

        case let .handoff(_, _, _, _, _, toModel, strategy, summary):
            let label = toModel.map { "Handoff to \($0)" } ?? "Handoff"
            return message(.system, summary ?? strategy, tool: label)

        case let .fork(_, targetThreadID, _):
            return message(.system, "", tool: "Forked to \(targetThreadID)")

        case let .threadCreated(targetThreadID, _, _, targetModel):
            return message(
                .system, "", tool: "Started \(targetModel) in \(targetThreadID)"
            )

        case let .subagent(_, _, _, _, _, prompt, progress, result):
            return message(.tool, result ?? progress ?? prompt, tool: "Subagent")

        case let .dynamicTool(toolName, _, output):
            return message(.tool, output?.stringValue ?? "", tool: toolName ?? "Tool")

        case let .unknown(type):
            // A type this build predates. Show that something happened rather
            // than leaving a hole in the transcript.
            return message(.system, "", tool: type.replacingOccurrences(of: "_", with: " "))

        case .approvalRequest, .userInputRequest:
            // Rendered as cards above the composer, not as transcript rows.
            return nil
        }
    }

    /// The detail's thread row. The projection's `AppThread` has no run status
    /// of its own — that lives on the runs — so the header's working indicator
    /// comes from the highest-ordinal run.
    private func mapThread(
        _ thread: OrchestrationV2AppThread,
        latestRun: OrchestrationV2Run?,
        environment: Environment
    ) -> FeatureThread {
        let isRunning = latestRun.map { $0.completedAt == nil } ?? false
        return FeatureThread(
            id: FeatureScopedID.thread(environmentID: environment.id, wireID: thread.id),
            wireID: thread.id,
            projectID: FeatureScopedID.project(
                environmentID: environment.id,
                wireID: thread.projectId
            ),
            environmentID: environment.id,
            environmentName: environment.label,
            title: thread.title,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            createdAt: parseDate(thread.createdAt),
            updatedAt: parseDate(thread.updatedAt),
            state: mapThreadState(
                status: latestRun?.status ?? "idle",
                pendingRequestKind: nil
            ),
            providerID: thread.modelSelection.instanceId,
            providerName: threadProviderName(modelSelection: thread.modelSelection),
            modelID: thread.modelSelection.model,
            modelOptions: mapOptionSelections(thread.modelSelection.options),
            isArchived: thread.archivedAt != nil,
            isSettled: isSettled(thread.settledOverride, settledAt: thread.settledAt),
            keepsActive: thread.settledOverride == "active",
            settledAt: thread.settledAt.map(parseDate),
            lastActivityAt: lastActivityDate(
                latestUserMessageAt: nil,
                latestRunCompletedAt: latestRun?.completedAt,
                updatedAt: thread.updatedAt
            ),
            snoozedUntil: thread.snoozedUntil.map(parseDate),
            snoozedAt: thread.snoozedAt.map(parseDate),
            pinnedAt: thread.pinnedAt.map(parseDate),
            supportsPinning: environment.descriptor?.capabilities.threadPinning,
            workInboxRole: thread.workInboxRole,
            relationshipToParent: thread.lineage.relationshipToParent,
            isRegeneratingTitle: thread.titleRegeneration != nil,
            supportsTitleRegeneration: environment.descriptor?.capabilities
                .threadTitleRegeneration,
            attentionAt: latestRun?.status == "failed"
                ? parseDate(latestRun?.completedAt ?? thread.updatedAt)
                : nil,
            workingStartedAt: isRunning
                ? parseDate(latestRun?.startedAt ?? latestRun?.requestedAt ?? thread.updatedAt)
                : nil,
            latestTurnCompletedAt: latestRun?.completedAt.map(parseDate),
            runtimeMode: mapRuntimeMode(thread.runtimeMode),
            interactionMode: mapInteractionMode(thread.interactionMode)
        )
    }

    private func mapApprovalKind(_ requestKind: String) -> FeatureApprovalKind {
        switch requestKind {
        case "command": .command
        case "file-read": .fileRead
        case "file-change": .fileChange
        default: .other
        }
    }

    private func approvalTitle(for requestKind: String) -> String {
        switch requestKind {
        case "command": "Run a command?"
        case "file-read": "Read a file?"
        case "file-change": "Change a file?"
        default: "Approve this action?"
        }
    }

    /// V2 reports how much older history it withheld instead of handing back a
    /// cursor, so "has more" is that count being non-zero.
    private func featurePage(
        truncatedVisibleItemCount: Int?,
        isLoading: Bool = false
    ) -> FeatureThreadPage? {
        FeatureThreadPage(
            beforeCursor: nil,
            hasMore: (truncatedVisibleItemCount ?? 0) > 0,
            isLoading: isLoading
        )
    }

    private func mapThread(
        _ thread: OrchestrationV2ThreadShell,
        environment: Environment
    ) -> FeatureThread {
        FeatureThread(
            id: FeatureScopedID.thread(environmentID: environment.id, wireID: thread.id),
            wireID: thread.id,
            projectID: FeatureScopedID.project(
                environmentID: environment.id,
                wireID: thread.projectId
            ),
            environmentID: environment.id,
            environmentName: environment.label,
            title: thread.title,
            preview: previewText(thread.latestVisibleMessage?.text),
            previewIsFromUser: thread.latestVisibleMessage?.role == "user",
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            createdAt: parseDate(thread.createdAt),
            updatedAt: parseDate(thread.updatedAt),
            state: mapThreadState(
                status: thread.status,
                pendingRequestKind: thread.pendingRuntimeRequest?.kind
            ),
            providerID: thread.modelSelection.instanceId,
            providerName: threadProviderName(modelSelection: thread.modelSelection),
            modelID: thread.modelSelection.model,
            modelOptions: mapOptionSelections(thread.modelSelection.options),
            isArchived: thread.archivedAt != nil,
            isSettled: isSettled(thread.settledOverride, settledAt: thread.settledAt),
            keepsActive: thread.settledOverride == "active",
            settledAt: thread.settledAt.map(parseDate),
            lastActivityAt: lastActivityDate(
                latestUserMessageAt: thread.latestUserMessageAt,
                latestRunCompletedAt: thread.latestRunCompletedAt,
                updatedAt: thread.updatedAt
            ),
            snoozedUntil: thread.snoozedUntil.map(parseDate),
            snoozedAt: thread.snoozedAt.map(parseDate),
            pinnedAt: thread.pinnedAt.map(parseDate),
            supportsPinning: environment.descriptor?.capabilities.threadPinning,
            // The two fields the workspaces sort on: `workInboxRole` is what
            // gives the T3 Work inbox a Main section at all, and
            // `relationshipToParent` is what keeps a subagent's thread out of
            // both lists rather than showing it beside the work that spawned it.
            workInboxRole: thread.workInboxRole,
            relationshipToParent: thread.lineage.relationshipToParent,
            isRegeneratingTitle: thread.titleRegeneration != nil,
            supportsTitleRegeneration: environment.descriptor?.capabilities
                .threadTitleRegeneration,
            // A failed run is the only thing that earns an attention marker; a
            // `lastError` on a run that recovered is history, not a call to act.
            attentionAt: thread.status == "failed"
                ? parseDate(thread.latestRunCompletedAt ?? thread.updatedAt)
                : nil,
            workingStartedAt: thread.activeRunId == nil
                ? nil
                : (thread.latestRunStartedAt ?? thread.latestRunRequestedAt).map(parseDate),
            latestTurnCompletedAt: thread.latestRunCompletedAt.map(parseDate),
            runtimeMode: mapRuntimeMode(thread.runtimeMode),
            interactionMode: mapInteractionMode(thread.interactionMode)
        )
    }



    private func publishActivePageState(threadID: String) {
        guard var detail = latestDetails[threadID] else { return }
        detail.page = activeThreadPage
        publish(detail, threadID: threadID, renderCacheIsSource: true)
    }

    private func clearOlderThreadLoading(threadID: String) {
        activeThreadPage?.isLoading = false
        publishActivePageState(threadID: threadID)
    }


    @discardableResult
















    /// Maps a V2 run status plus any pending runtime request onto the state the
    /// UI renders.
    ///
    /// A pending request outranks the run status: a run sitting in `running`
    /// while it blocks on an approval is, to the person looking at it, waiting
    /// on them.
    private func mapThreadState(
        status: String,
        pendingRequestKind: String?
    ) -> FeatureThreadState {
        switch pendingRequestKind {
        case "user_input":
            return .waitingForInput
        case "command", "file-read", "file-change", "dynamic_tool_call":
            return .waitingForApproval
        // `auth_refresh` blocks the run but has no approval card behind it, so
        // showing "waiting for approval" would point at nothing. Fall through to
        // the run status instead.
        default:
            break
        }

        switch status {
        case "preparing", "queued", "starting": return .queued
        case "running", "waiting": return .working
        case "failed": return .failed
        case "completed": return .completed
        // `interrupted`, `cancelled`, and `rolled_back` all mean the run stopped
        // without finishing its work, which reads as idle rather than as failure.
        default: return .idle
        }
    }


    private func isSettled(_ override: String?, settledAt: String?) -> Bool {
        if override == "active" { return false }
        return override == "settled" || settledAt != nil
    }

    private func mapRuntimeMode(_ mode: RuntimeMode) -> FeatureRuntimeMode {
        switch mode {
        case .approvalRequired, .autoAcceptEdits, .auto: .automatic
        case .fullAccess: .fullAccess
        }
    }

    private func coreRuntimeMode(_ mode: FeatureRuntimeMode) -> RuntimeMode {
        mode.mobileNormalized == .fullAccess ? .fullAccess : .auto
    }

    private func mapInteractionMode(_: InteractionMode) -> FeatureInteractionMode {
        .standard
    }

    private func coreInteractionMode(_: FeatureInteractionMode) -> InteractionMode {
        .default
    }

    /// The mapped catalog for the config-driven branch of mapProviders. Every
    /// publish rebuilds the snapshot, but the catalog only changes when a new
    /// server config arrives, so mapping hundreds of models per publish is
    /// wasted work. Entries are invalidated wherever
    /// serverConfigsByEnvironmentID is written.
    private var providerCatalogCache: [String: [FeatureProvider]] = [:]

    /// Single write path for server configs so the provider catalog cache can
    /// never go stale against the config that feeds it.
    private func setServerConfig(_ config: ServerConfigSnapshot, environmentID: String) {
        serverConfigsByEnvironmentID[environmentID] = config
        providerCatalogCache[environmentID] = nil
    }

    private func mapProviders(
        environmentID: String,
        shell: OrchestrationV2ShellSnapshot,
        config: ServerConfigSnapshot?
    ) -> [FeatureProvider] {
        if let providers = config?.providers, !providers.isEmpty {
            if let cached = providerCatalogCache[environmentID] { return cached }
            let mapped = mapConfigProviders(providers)
            providerCatalogCache[environmentID] = mapped
            return mapped
        }
        return mapShellFallbackProviders(shell)
    }

    private func mapConfigProviders(
        _ providers: [ServerProviderSnapshot]
    ) -> [FeatureProvider] {
        Self.normalizedProviders(providers.map { provider in
                FeatureProvider(
                    id: provider.instanceId,
                    name: provider.displayName ?? providerDisplayName(provider.driver),
                    isAvailable: provider.enabled
                        && provider.installed
                        && provider.status != "disabled"
                        && provider.status != "error"
                        && provider.auth.status != "unauthenticated"
                        && provider.availability != "unavailable",
                    driver: provider.driver,
                    requiresNewThreadForModelChange:
                        provider.requiresNewThreadForModelChange ?? false,
                    models: provider.models.map { model in
                        let options = (model.capabilities?.optionDescriptors ?? [])
                            .map(mapOptionDescriptor)
                        return FeatureModel(
                            id: model.slug,
                            name: model.name,
                            detail: model.subProvider ?? model.shortName,
                            supportsReasoning: options.contains { descriptor in
                                let searchable = "\(descriptor.id) \(descriptor.label)".lowercased()
                                return searchable.contains("reason")
                                    || searchable.contains("effort")
                                    || searchable.contains("thinking")
                            },
                            isDefault: model.isDefault ?? false,
                            isLegacy: model.isLegacy,
                            options: options
                        )
                    },
                    slashCommands: (provider.slashCommands ?? []).map { command in
                        FeatureProviderSlashCommand(
                            name: command.name,
                            description: command.description,
                            inputHint: command.input?.hint
                        )
                    },
                    skills: (provider.skills ?? []).map { skill in
                        FeatureProviderSkill(
                            name: skill.name,
                            displayName: skill.displayName,
                            description: skill.description,
                            shortDescription: skill.shortDescription,
                            path: skill.path,
                            scope: skill.scope,
                            isEnabled: skill.enabled
                        )
                    }
                )
            })
    }

    /// Without a server config the catalog is inferred from selections in the
    /// shell, which is cheap enough to rebuild per publish.
    private func mapShellFallbackProviders(
        _ shell: OrchestrationV2ShellSnapshot
    ) -> [FeatureProvider] {
        var modelsByProvider: [String: Set<String>] = [:]
        for selection in shell.projects.compactMap(\.defaultModelSelection)
            + shell.threads.map(\.modelSelection) {
            modelsByProvider[selection.instanceId, default: []].insert(selection.model)
        }
        if modelsByProvider.isEmpty {
            modelsByProvider["codex"] = ["gpt-5.6-sol"]
        }
        return modelsByProvider.keys.sorted().map { providerID in
            FeatureProvider(
                id: providerID,
                name: providerDisplayName(providerID),
                driver: providerID,
                models: (modelsByProvider[providerID] ?? []).sorted().map {
                    FeatureModel(id: $0, name: $0)
                }
            )
        }
    }

    static func normalizedProviders(
        _ providers: [FeatureProvider]
    ) -> [FeatureProvider] {
        var normalized: [FeatureProvider] = []
        var providerIndexByID: [String: Int] = [:]

        for var provider in providers {
            var seenModelIDs = Set<String>()
            provider.models = provider.models.filter {
                seenModelIDs.insert($0.id).inserted
            }
            if let index = providerIndexByID[provider.id] {
                var existing = normalized[index]
                var existingModelIDs = Set(existing.models.map(\.id))
                existing.models.append(contentsOf: provider.models.filter {
                    existingModelIDs.insert($0.id).inserted
                })
                normalized[index] = existing
            } else {
                providerIndexByID[provider.id] = normalized.count
                normalized.append(provider)
            }
        }
        return normalized
    }

    private func modelSelection(
        _ selection: FeatureSelection?,
        projectID: String,
        environmentID: String,
        shell: OrchestrationV2ShellSnapshot?
    ) -> ModelSelection {
        if let selection {
            return coreModelSelection(selection)
        }
        if let projectDefault = shell?.projects
            .first(where: { $0.id == projectID })?
            .defaultModelSelection {
            return projectDefault
        }
        return fallbackModelSelection(
            environmentID: environmentID,
            projectID: projectID,
            shell: shell
        )
    }

    /// Fallback selection is resolved against the target environment. This
    /// matters when a passive machine exposes a different provider catalogue
    /// than the currently active one.
    private func fallbackModelSelection(
        environmentID: String,
        projectID: String?,
        shell: OrchestrationV2ShellSnapshot?
    ) -> ModelSelection {
        let config = serverConfigsByEnvironmentID[environmentID]
        let appSelection = loadSettings().defaultSelection
        if let selection = appSelection, let config {
            if configSupports(selection, config: config) {
                return coreModelSelection(selection)
            }
        }
        if let configuredDefault = defaultModelSelection(in: config) {
            return configuredDefault
        }
        if let projectID,
           let recentProjectSelection = shell?.threads
            .first(where: { $0.projectId == projectID })?
            .modelSelection {
            return recentProjectSelection
        }
        if let knownSelection = shell?.projects.compactMap(\.defaultModelSelection).first
            ?? shell?.threads.first?.modelSelection {
            return knownSelection
        }
        if let selection = appSelection {
            return coreModelSelection(selection)
        }
        return ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
    }

    private func configSupports(
        _ selection: FeatureSelection,
        config: ServerConfigSnapshot
    ) -> Bool {
        config.providers.contains { provider in
            provider.instanceId == selection.providerID
                && providerCanRun(provider)
                && provider.models.contains { $0.slug == selection.modelID }
        }
    }

    private func defaultModelSelection(
        in config: ServerConfigSnapshot?
    ) -> ModelSelection? {
        guard let providers = config?.providers else { return nil }
        for provider in providers where providerCanRun(provider) {
            if let model = provider.models.first(where: { $0.isDefault == true }) {
                return ModelSelection(instanceId: provider.instanceId, model: model.slug)
            }
        }
        for provider in providers where providerCanRun(provider) {
            if let model = provider.models.first {
                return ModelSelection(instanceId: provider.instanceId, model: model.slug)
            }
        }
        return nil
    }

    private func providerCanRun(_ provider: ServerProviderSnapshot) -> Bool {
        provider.enabled
            && provider.installed
            && provider.status != "disabled"
            && provider.status != "error"
            && provider.auth.status != "unauthenticated"
            && provider.availability != "unavailable"
    }

    private func coreModelSelection(_ selection: FeatureSelection) -> ModelSelection {
        let options = selection.options.map { option in
            ModelSelection.OptionSelection(
                id: option.id,
                value: coreOptionValue(option.value)
            )
        }
        return ModelSelection(
            instanceId: selection.providerID,
            model: selection.modelID,
            options: options.isEmpty ? nil : options
        )
    }

    private func mapSelection(_ selection: ModelSelection) -> FeatureSelection {
        FeatureSelection(
            providerID: selection.instanceId,
            modelID: selection.model,
            options: mapOptionSelections(selection.options)
        )
    }

    private func coreOptionValue(_ value: FeatureModelOptionValue) -> JSONValue {
        switch value {
        case let .string(rawValue):
            return .string(rawValue)
        case let .boolean(rawValue):
            return .bool(rawValue)
        }
    }

    private func mapOptionSelections(
        _ selections: [ModelSelection.OptionSelection]?
    ) -> [FeatureModelOptionSelection] {
        (selections ?? []).compactMap { selection in
            let value: FeatureModelOptionValue
            switch selection.value {
            case let .string(rawValue):
                value = .string(rawValue)
            case let .bool(rawValue):
                value = .boolean(rawValue)
            default:
                return nil
            }
            return FeatureModelOptionSelection(id: selection.id, value: value)
        }
    }

    private func mapOptionDescriptor(
        _ descriptor: ServerProviderOptionDescriptor
    ) -> FeatureModelOptionDescriptor {
        switch descriptor {
        case let .select(value):
            let defaultValue = value.currentValue
                ?? value.options.first(where: { $0.isDefault == true })?.id
            return FeatureModelOptionDescriptor(
                id: value.id,
                label: value.label,
                detail: value.description,
                kind: .select,
                choices: value.options.map {
                    FeatureModelOptionChoice(
                        id: $0.id,
                        label: $0.label,
                        detail: $0.description,
                        isDefault: $0.isDefault ?? false
                    )
                },
                defaultValue: defaultValue.map(FeatureModelOptionValue.string)
            )
        case let .boolean(value):
            return FeatureModelOptionDescriptor(
                id: value.id,
                label: value.label,
                detail: value.description,
                kind: .boolean,
                defaultValue: value.currentValue.map(FeatureModelOptionValue.boolean)
            )
        }
    }

    private func providerDisplayName(_ id: String) -> String {
        switch id {
        case "codex": "Codex"
        case "claudeAgent", "claude": "Claude"
        case "cursor": "Cursor"
        case "grok": "Grok"
        case "opencode": "OpenCode"
        default: id
        }
    }

    /// V2 has no provider session on the thread, so the display name comes from
    /// the model selection's instance and the server's provider catalog.
    private func threadProviderName(modelSelection: ModelSelection) -> String {
        let providerID = modelSelection.instanceId
        if let provider = latestServerConfig?.providers.first(where: {
            $0.instanceId == providerID
        }) {
            return provider.displayName ?? providerDisplayName(provider.driver)
        }
        return providerDisplayName(providerID)
    }

    private func cachedAttachmentURL(
        for id: String,
        environmentID: String? = nil
    ) -> URL? {
        guard let environmentID = environmentID ?? activeEnvironment?.id else {
            return nil
        }
        let key = AttachmentCacheKey(environmentID: environmentID, attachmentID: id)
        guard let cached = attachmentURLs[key] else { return nil }
        guard cached.expiresAt > Date().addingTimeInterval(30) else {
            attachmentURLs[key] = nil
            return nil
        }
        return cached.url
    }

    private func scheduleAttachmentHydration(
        in detail: FeatureThreadDetail,
        threadID: String,
        client: T3Client,
        environmentID: String
    ) {
        guard detail.messages.contains(where: { message in
            message.attachments.contains {
                $0.mimeType.hasPrefix("image/") && $0.url == nil
            }
        }) else {
            return
        }
        // Streaming activity can publish many detail revisions per second. Let the
        // current asset resolution finish instead of continuously restarting it.
        guard attachmentHydrationTasks[threadID] == nil else { return }
        let generation = environmentGeneration
        let workID = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            let hydrated = await self.hydratedAttachmentURLs(
                in: detail,
                client: client,
                environmentID: environmentID,
                generation: generation
            )
            guard self.isKnownClient(
                client,
                environmentID: environmentID,
                generation: generation
            ),
                  self.latestDetails[threadID] == detail,
                  hydrated != detail else {
                self.finishAttachmentHydration(threadID: threadID, workID: workID)
                if let latest = self.latestDetails[threadID], latest != detail {
                    self.scheduleAttachmentHydration(
                        in: latest,
                        threadID: threadID,
                        client: client,
                        environmentID: environmentID
                    )
                }
                return
            }
            self.publish(
                hydrated,
                threadID: threadID
            )
            self.finishAttachmentHydration(threadID: threadID, workID: workID)
        }
        attachmentHydrationTasks[threadID] = (workID, task)
    }

    private func finishAttachmentHydration(threadID: String, workID: UUID) {
        guard attachmentHydrationTasks[threadID]?.id == workID else { return }
        attachmentHydrationTasks[threadID] = nil
    }

    private func hydratedAttachmentURLs(
        in detail: FeatureThreadDetail,
        client: T3Client,
        environmentID: String,
        generation: Int
    ) async -> FeatureThreadDetail {
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            return detail
        }
        let imageIDs = Set(
            detail.messages.flatMap(\.attachments)
                .filter { $0.mimeType.hasPrefix("image/") }
                .map(\.id)
        )
        // Text-only threads refresh every couple of seconds; skip the resolve
        // pass and the full message walk when there is nothing to hydrate.
        guard !imageIDs.isEmpty else { return detail }
        let missingIDs = Array(imageIDs.filter {
            cachedAttachmentURL(for: $0, environmentID: environmentID) == nil
        })

        await withTaskGroup(of: (String, ResolvedAssetURL?).self) { group in
            var iterator = missingIDs.makeIterator()
            for _ in 0..<min(4, missingIDs.count) {
                guard let id = iterator.next() else { break }
                group.addTask {
                    (
                        id,
                        try? await client.resolvedAsset(resource: .attachment(id: id))
                    )
                }
            }
            while let (id, resolved) = await group.next() {
                if let resolved,
                   isKnownClient(
                       client,
                       environmentID: environmentID,
                       generation: generation
                   ) {
                    let key = AttachmentCacheKey(
                        environmentID: environmentID,
                        attachmentID: id
                    )
                    attachmentURLs[key] = CachedAttachmentURL(
                        url: resolved.url,
                        expiresAt: resolved.expiresAt
                    )
                }
                if isKnownClient(
                    client,
                    environmentID: environmentID,
                    generation: generation
                ),
                   let nextID = iterator.next() {
                    group.addTask {
                        (
                            nextID,
                            try? await client.resolvedAsset(
                                resource: .attachment(id: nextID)
                            )
                        )
                    }
                }
            }
        }

        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            return detail
        }
        var hydrated = detail
        for messageIndex in hydrated.messages.indices {
            for attachmentIndex in hydrated.messages[messageIndex].attachments.indices {
                let id = hydrated.messages[messageIndex].attachments[attachmentIndex].id
                hydrated.messages[messageIndex].attachments[attachmentIndex].url =
                    cachedAttachmentURL(for: id, environmentID: environmentID)
            }
        }
        return hydrated
    }

    /// Latest real activity. `updatedAt` is the floor rather than a candidate:
    /// it moves for bookkeeping writes like a visit watermark, so preferring it
    /// would make untouched threads drift to the top of the list.
    private func lastActivityDate(
        latestUserMessageAt: String?,
        latestRunCompletedAt: String?,
        updatedAt: String
    ) -> Date? {
        let activity = [latestUserMessageAt, latestRunCompletedAt]
            .compactMap { $0.flatMap(parseValidDate) }
            .max()
        return activity ?? parseValidDate(updatedAt)
    }

    /// The kind is classified rather than assumed: the contract has separate
    /// `pdf` and `video` attachment branches with their own size caps, and
    /// forcing everything through the image branch rejected every document the
    /// picker could hand back.
    private func makeUploadAttachments(
        _ attachments: [FeatureUploadAttachment]
    ) throws -> [UploadChatAttachment] {
        guard attachments.count <= 8 else {
            throw NativeFeatureClientError.tooManyAttachments
        }
        return try attachments.map {
            try UploadChatAttachment(
                data: $0.data,
                name: $0.name,
                mimeType: $0.mimeType,
                kind: ComposerAttachments.classify(mimeType: $0.mimeType, name: $0.name)
            )
        }
    }

    private func requireScope(_ scope: String, client: T3Client) async throws {
        let session = try await client.authSession()
        guard session.scopes?.contains(scope) == true else {
            throw NativeFeatureClientError.missingScope(scope)
        }
    }

    private static func title(from prompt: String, hasAttachments: Bool) -> String {
        let compact = prompt
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        guard !compact.isEmpty else {
            return hasAttachments ? "Image task" : "New thread"
        }
        guard compact.count > 72 else { return compact }
        return "\(compact.prefix(69).trimmingCharacters(in: .whitespacesAndNewlines))..."
    }

    private func commandIdentity(
        _ identity: FeatureSubmissionIdentity
    ) -> CommandIdentity {
        CommandIdentity(
            commandID: identity.commandID,
            messageID: identity.messageID,
            createdAt: Self.fractionalDateFormatter.string(from: identity.createdAt)
        )
    }

    private static func temporaryWorktreeBranchName(seed: String? = nil) -> String {
        let suffix = seed ?? UUID().uuidString
        return "t3code/\(suffix.prefix(8).lowercased())"
    }

    private func previewText(_ text: String?) -> String? {
        guard let text else { return nil }
        let compact = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !compact.isEmpty else { return nil }
        return compact.count > 160 ? "\(compact.prefix(157))..." : compact
    }

    private func loadSettings() -> FeatureSettings {
        guard let data = settingsStore.data(forKey: Self.settingsKey),
              let settings = try? JSONDecoder().decode(FeatureSettings.self, from: data) else {
            return FeatureSettings()
        }
        return settings
    }

    private func parseDate(_ value: String) -> Date {
        parseValidDate(value) ?? .distantPast
    }

    /// Every publish re-maps every thread, and most timestamps are unchanged
    /// between publishes, so parsed dates are memoized. ISO8601DateFormatter
    /// costs microseconds per call, which adds up to milliseconds per publish
    /// across hundreds of threads during streaming.
    private func parseValidDate(_ value: String) -> Date? {
        if let cached = parsedDates[value] { return cached }
        guard let parsed = Self.fractionalDateFormatter.date(from: value)
            ?? Self.dateFormatter.date(from: value) else { return nil }
        if parsedDates.count >= 4096 { parsedDates.removeAll(keepingCapacity: true) }
        parsedDates[value] = parsed
        return parsed
    }

    private var parsedDates: [String: Date] = [:]

    private static let settingsKey = "swift-ios.feature-settings.v1"
    private static let fractionalDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let dateFormatter = ISO8601DateFormatter()
}




/// Outcome of folding one live event into the cached projection.
enum NativeThreadDetailReductionResult: Equatable {
    case updated(OrchestrationV2ThreadProjection)
    case unchanged
    /// The event changed structure this reducer does not model. Ask the server
    /// for an authoritative projection rather than guessing.
    case refresh
}

struct NativeThreadDetailReduction: Equatable {
    let sequence: Int
    let result: NativeThreadDetailReductionResult
}

/// Folds `subscribeThread` events into the cached V2 projection.
///
/// Only the high-frequency events are reduced in place: an assistant message
/// streaming a long answer emits many `turn-item.updated` events per second, and
/// refetching the projection for each would make the transcript stutter.
/// Everything else — structural changes, rollbacks, anything unrecognized —
/// takes the authoritative-refresh path, which is cheap because it is rare and
/// always correct.
enum NativeThreadDetailReducer {
    static func apply(
        _ event: JSONValue,
        to projection: OrchestrationV2ThreadProjection
    ) -> NativeThreadDetailReduction {
        guard case let .object(object) = event,
              let type = object["type"]?.stringValue,
              let sequence = intValue(object["sequence"]),
              let payload = object["payload"] else {
            return NativeThreadDetailReduction(sequence: -1, result: .refresh)
        }

        switch type {
        case "turn-item.updated":
            guard let item = decode(OrchestrationV2TurnItem.self, from: payload),
                  item.base.threadId == projection.thread.id else {
                return NativeThreadDetailReduction(sequence: -1, result: .refresh)
            }
            return NativeThreadDetailReduction(
                sequence: sequence,
                result: .updated(projection.upserting(item))
            )

        case "run.created", "run.updated":
            guard let run = decode(OrchestrationV2Run.self, from: payload) else {
                return NativeThreadDetailReduction(sequence: -1, result: .refresh)
            }
            return NativeThreadDetailReduction(
                sequence: sequence,
                result: .updated(projection.upserting(run))
            )

        case "thread.created",
             "thread.archived", "thread.unarchived", "thread.deleted",
             "thread.settled", "thread.unsettled",
             "thread.snoozed", "thread.unsnoozed",
             "thread.visited", "thread.marked-unread",
             "thread.metadata-updated", "thread.runtime-mode-updated",
             "thread.interaction-mode-updated", "thread.model-selection-updated",
             "thread.provider-switched":
            guard let thread = decode(OrchestrationV2AppThread.self, from: payload),
                  thread.id == projection.thread.id else {
                return NativeThreadDetailReduction(sequence: -1, result: .refresh)
            }
            return NativeThreadDetailReduction(
                sequence: sequence,
                result: .updated(projection.replacingThread(thread))
            )

        default:
            // Checkpoint rollbacks drop whole runs out of the projection, plan
            // and handoff updates restructure it, and an unrecognized type is by
            // definition unmodeled. All three need the server's version.
            return NativeThreadDetailReduction(sequence: -1, result: .refresh)
        }
    }

    private static func decode<T: Decodable>(_: T.Type, from value: JSONValue) -> T? {
        guard let data = try? JSONEncoder.t3.encode(value) else { return nil }
        return try? JSONDecoder.t3.decode(T.self, from: data)
    }

    private static func intValue(_ value: JSONValue?) -> Int? {
        switch value {
        case let .integer(integer): Int(exactly: integer)
        case let .number(number): Int(exactly: number)
        default: nil
        }
    }
}

extension OrchestrationV2ThreadProjection {
    /// The run `run.interrupt` should target: the newest run that has not
    /// finished. Mirrors the run statuses the server treats as active when it
    /// decides how to dispatch a message.
    var activeRunID: String? {
        runs.last {
            $0.status == "preparing"
                || $0.status == "starting"
                || $0.status == "running"
                || $0.status == "waiting"
        }?.id
    }

    /// Replaces an item in place, preserving transcript order. An item that is
    /// not in the visible window is still recorded so a later full projection
    /// agrees with what was streamed.
    func upserting(_ item: OrchestrationV2TurnItem) -> OrchestrationV2ThreadProjection {
        var items = turnItems
        if let index = items.firstIndex(where: { $0.id == item.id }) {
            items[index] = item
        } else {
            items.append(item)
        }

        var visible = visibleTurnItems
        if let index = visible.firstIndex(where: { $0.sourceItemId == item.id }) {
            visible[index] = OrchestrationV2ProjectedTurnItem(
                position: visible[index].position,
                visibility: visible[index].visibility,
                sourceThreadId: visible[index].sourceThreadId,
                sourceItemId: visible[index].sourceItemId,
                item: item
            )
        } else {
            visible.append(
                OrchestrationV2ProjectedTurnItem(
                    position: (visible.map(\.position).max() ?? -1) + 1,
                    visibility: .local,
                    sourceThreadId: item.base.threadId,
                    sourceItemId: item.id,
                    item: item
                )
            )
        }

        return replacing(turnItems: items, visibleTurnItems: visible)
    }

    func upserting(_ run: OrchestrationV2Run) -> OrchestrationV2ThreadProjection {
        var updated = runs
        if let index = updated.firstIndex(where: { $0.id == run.id }) {
            updated[index] = run
        } else {
            updated.append(run)
        }
        return replacing(runs: updated)
    }

    func replacingThread(_ thread: OrchestrationV2AppThread) -> OrchestrationV2ThreadProjection {
        replacing(thread: thread)
    }
}

private struct AttachmentCacheKey: Hashable {
    let environmentID: String
    let attachmentID: String
}

private struct CachedAttachmentURL {
    let url: URL
    let expiresAt: Date
}

private struct EnvironmentShellLoad: Sendable {
    let environment: Environment
    let client: T3Client
    let shell: OrchestrationV2ShellSnapshot?
    let config: ServerConfigSnapshot?
}

private struct EntityWireOwner: Hashable {
    let environmentID: String
    let wireID: String
}

private struct NativeProjectRoute {
    let uiID: String
    let wireID: String
    let environmentID: String
    let client: T3Client
}


private struct NativeThreadRoute {
    let uiID: String
    let wireID: String
    let environmentID: String
    let client: T3Client
}

/// Folds the per-checkout VCS statuses back into one map the thread list reads.
@MainActor
private final class ChangeRequestAccumulator {
    private var pullRequestsByThreadID: [String: FeaturePullRequest] = [:]

    /// Returns the merged map only when it actually changed. Remote status is
    /// polled, so most events restate what the list already shows, and a row
    /// that re-renders on every poll is a row that drops frames.
    func apply(
        threadIDs: [String],
        branches: [String: String],
        refName: String?,
        pullRequest: FeaturePullRequest?
    ) -> [String: FeaturePullRequest]? {
        var changed = false
        for threadID in threadIDs {
            // The status describes one checkout, so it only speaks for a thread
            // whose branch is the one checked out there. A thread parked on a
            // branch someone else has since switched away from shows no PR
            // rather than the wrong one.
            let checkedOut = refName != nil && refName == branches[threadID]
            let next = checkedOut ? pullRequest : nil
            if pullRequestsByThreadID[threadID] != next {
                pullRequestsByThreadID[threadID] = next
                changed = true
            }
        }
        return changed ? pullRequestsByThreadID : nil
    }
}

private struct ProvisionalThreadRoute {
    let environmentID: String
    let wireID: String
}

private struct PendingRequestRoute {
    let threadID: String
    let wireID: String
}

private struct CommandIdentity: Equatable {
    let commandID: String
    let messageID: String
    let createdAt: String

    init(
        commandID: String = UUID().uuidString,
        messageID: String = UUID().uuidString,
        createdAt: String = OrchestrationCommands.now()
    ) {
        self.commandID = commandID
        self.messageID = messageID
        self.createdAt = createdAt
    }
}

/// Resolves the relational V2 rows that enrich one turn item.
///
/// The Swift stand-in for `useV2ItemSupport`, with the resolution rules ported
/// from packages/client-runtime/src/state/itemSupport.ts. The RN version scans
/// the projection's arrays per item; this indexes them once per projection
/// instead, because the native transcript resolves every visible row on each
/// snapshot rather than one row at a time behind a memo.
///
/// Inherited rows degrade rather than lie: their supporting rows live in the
/// *source* thread's projection, which this client does not hold, so the joins
/// simply miss and the inspector shows the fields the item itself carries.
private struct ProjectionItemSupportIndex {
    private let runs: [String: OrchestrationV2Run]
    private let attemptsByRunID: [String: [OrchestrationV2RunAttempt]]
    private let nodes: [String: OrchestrationV2ExecutionNode]
    private let providerSessions: [String: OrchestrationV2ProviderSession]
    private let providerThreads: [String: OrchestrationV2ProviderThread]
    private let providerTurns: [String: OrchestrationV2ProviderTurn]
    private let runtimeRequests: [String: OrchestrationV2RuntimeRequest]
    private let checkpoints: [String: OrchestrationV2Checkpoint]
    private let subagents: [String: OrchestrationV2Subagent]
    private let contextHandoffs: [String: OrchestrationV2ContextHandoff]
    private let contextTransfers: [String: OrchestrationV2ContextTransfer]

    init(_ projection: OrchestrationV2ThreadProjection) {
        // A duplicate id would mean a malformed projection; keeping the first
        // occurrence matches `Array.find`, which is what the RN client does.
        runs = Self.index(projection.runs)
        attemptsByRunID = Dictionary(grouping: projection.attempts, by: \.runId)
        nodes = Self.index(projection.nodes)
        providerSessions = Self.index(projection.providerSessions)
        providerThreads = Self.index(projection.providerThreads)
        providerTurns = Self.index(projection.providerTurns)
        runtimeRequests = Self.index(projection.runtimeRequests)
        checkpoints = Self.index(projection.checkpoints)
        subagents = Self.index(projection.subagents)
        contextHandoffs = Self.index(projection.contextHandoffs)
        contextTransfers = Self.index(projection.contextTransfers)
    }

    func resolve(_ item: OrchestrationV2TurnItem) -> ThreadActivityItemSupport {
        let node = item.base.nodeId.flatMap { nodes[$0] }
        let providerThread = item.base.providerThreadId.flatMap { providerThreads[$0] }
        let providerSession = providerThread?.providerSessionId
            .flatMap { providerSessions[$0] }

        // An approval or user-input row names its own request; every other row
        // reaches it through the execution node that raised it.
        let requestID: String? = switch item.payload {
        case let .approvalRequest(requestID, _, _): requestID
        case let .userInputRequest(requestID, _): requestID
        default: node?.runtimeRequestId
        }

        var checkpoint: OrchestrationV2Checkpoint?
        if case let .checkpoint(checkpointID, _, _) = item.payload {
            checkpoint = checkpoints[checkpointID]
        }

        var subagent: OrchestrationV2Subagent?
        if case let .subagent(subagentID, _, _, _, _, _, _, _) = item.payload {
            subagent = subagents[subagentID]
        }

        var contextHandoff: OrchestrationV2ContextHandoff?
        if case let .handoff(contextHandoffID, _, _, _, _, _, _, _) = item.payload {
            contextHandoff = contextHandoffs[contextHandoffID]
        }
        let contextTransfer = contextHandoff?.transferId.flatMap { contextTransfers[$0] }

        return ThreadActivityItemSupport(
            run: item.base.runId
                .flatMap { runs[$0] }
                .map { ThreadActivityItemSupport.Run(status: $0.status) },
            attempts: (item.base.runId.flatMap { attemptsByRunID[$0] } ?? []).map {
                ThreadActivityItemSupport.Attempt(
                    attemptOrdinal: $0.attemptOrdinal,
                    status: $0.status,
                    // `reason` is required on the wire; Core keeps it optional
                    // so a value this build predates cannot fail the decode.
                    reason: $0.reason ?? ""
                )
            },
            node: node.map {
                ThreadActivityItemSupport.Node(kind: $0.kind, status: $0.status)
            },
            providerSession: providerSession.map {
                ThreadActivityItemSupport.ProviderSession(
                    status: $0.status,
                    model: $0.model,
                    cwd: $0.cwd ?? ""
                )
            },
            providerThread: providerThread.map {
                ThreadActivityItemSupport.ProviderThread(
                    providerInstanceID: $0.providerInstanceId,
                    status: $0.status
                )
            },
            providerTurn: item.base.providerTurnId
                .flatMap { providerTurns[$0] }
                .map { ThreadActivityItemSupport.ProviderTurn(status: $0.status) },
            runtimeRequest: requestID
                .flatMap { runtimeRequests[$0] }
                .map {
                    ThreadActivityItemSupport.RuntimeRequest(
                        status: $0.status,
                        responseCapabilityType: $0.responseCapability?.type ?? ""
                    )
                },
            checkpoint: checkpoint.map {
                ThreadActivityItemSupport.Checkpoint(
                    id: $0.id,
                    scopeID: $0.scopeId,
                    status: $0.status
                )
            },
            subagent: subagent.map {
                ThreadActivityItemSupport.Subagent(
                    origin: $0.origin,
                    status: $0.status,
                    progress: $0.progress,
                    result: $0.result
                )
            },
            contextHandoff: contextHandoff.map {
                ThreadActivityItemSupport.ContextHandoff(status: $0.status)
            },
            contextTransfer: contextTransfer.map { transfer in
                ThreadActivityItemSupport.ContextTransfer(
                    type: transfer.type,
                    status: transfer.status,
                    // A pending transfer has no resolution yet, and a resolution
                    // this build cannot name has no strategy to show.
                    resolution: transfer.resolution?.strategy.map {
                        ThreadActivityItemSupport.ContextTransfer.Resolution(strategy: $0)
                    }
                )
            }
        )
    }

    private static func index<Row: Identifiable>(
        _ rows: [Row]
    ) -> [String: Row] where Row.ID == String {
        Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }
}

private struct BootstrapSubmissionSignature: Equatable {
    let projectID: String
    let prompt: String
    let model: ModelSelection
    let runtimeMode: RuntimeMode
    let interactionMode: InteractionMode
    let workspaceMode: FeatureWorkspaceMode
    let branch: String?
    let worktreePath: String?
    let startFromOrigin: Bool
    let attachments: [FeatureUploadAttachment]
}

private struct PendingBootstrapSubmission {
    let signature: BootstrapSubmissionSignature
    let threadID: String
    let identity: CommandIdentity
    let worktreeBranchName: String?
}

private struct TurnSubmissionSignature: Equatable {
    let text: String
    let model: ModelSelection?
    let runtimeMode: RuntimeMode
    let interactionMode: InteractionMode
    let attachments: [FeatureUploadAttachment]
}

private struct PendingTurnSubmission {
    let signature: TurnSubmissionSignature
    let identity: CommandIdentity
}

private enum NativeFeatureClientError: LocalizedError {
    case notConnected
    case environmentNotFound
    case projectNotFound
    case threadNotFound
    case workspaceNotFound
    case approvalNotFound
    case inputRequestNotFound
    case invalidProjectPath
    case branchRequired
    case deviceSessionNotFound
    case missingScope(String)
    case tooManyAttachments
    case crossEnvironmentMerge

    var errorDescription: String? {
        switch self {
        case .notConnected: "Connect to a T3 environment first."
        case .environmentNotFound: "That T3 environment is no longer available."
        case .projectNotFound: "The selected project is no longer available."
        case .threadNotFound: "The selected thread is no longer available."
        case .workspaceNotFound: "The thread workspace is no longer available."
        case .approvalNotFound: "The approval request is no longer active."
        case .inputRequestNotFound: "The input request is no longer active."
        case .invalidProjectPath: "Enter a workspace path on the connected environment."
        case .branchRequired: "Choose a base branch for the new worktree."
        case .deviceSessionNotFound: "That device session is no longer active."
        case .missingScope: "This connection does not have permission to manage devices."
        case .tooManyAttachments: "You can attach up to 8 images per message."
        case .crossEnvironmentMerge:
            "These threads are on different environments and cannot be merged."
        }
    }
}

// MARK: - Automations

/// Scheduled tasks are environment state: two paired servers keep independent
/// schedules, and the RPCs (`scheduledTasks.*` in
/// `packages/contracts/src/rpc.ts`) are answered by the environment that owns
/// the row, so every call routes through that environment's client rather than
/// the active one.
extension NativeFeatureClient: FeatureScheduledTaskManaging {
    func loadScheduledTasks(environmentID: String) async throws -> [FeatureScheduledTask] {
        let client = try await environmentClient(id: environmentID)
        return try await client.scheduledTasks().map(Self.mapScheduledTask)
    }

    func upsertScheduledTask(
        environmentID: String,
        input: FeatureScheduledTaskUpsert
    ) async throws -> FeatureScheduledTask {
        let client = try await environmentClient(id: environmentID)
        let record = try await client.upsertScheduledTask(
            ScheduledTaskUpsert(
                id: input.id,
                title: input.title,
                prompt: input.prompt,
                enabled: input.enabled,
                schedule: Self.wireSchedule(input.schedule),
                projectID: input.projectID,
                threadID: input.threadID,
                // The launch settings this form does not edit travel back
                // verbatim, so a mobile edit cannot flatten a worktree strategy
                // an agent or the web client configured.
                workspaceStrategy: input.launch.workspaceStrategy,
                modelSelection: input.launch.modelSelection,
                runtimeMode: input.launch.runtimeMode,
                interactionMode: input.launch.interactionMode,
                creationSource: input.creationSource
            )
        )
        return Self.mapScheduledTask(record)
    }

    func setScheduledTaskEnabled(
        environmentID: String,
        id: String,
        enabled: Bool
    ) async throws -> FeatureScheduledTask {
        let client = try await environmentClient(id: environmentID)
        return Self.mapScheduledTask(
            try await client.setScheduledTaskEnabled(id: id, enabled: enabled)
        )
    }

    func runScheduledTaskNow(
        environmentID: String,
        id: String
    ) async throws -> FeatureScheduledTask {
        let client = try await environmentClient(id: environmentID)
        return Self.mapScheduledTask(try await client.runScheduledTaskNow(id: id))
    }

    func deleteScheduledTask(environmentID: String, id: String) async throws {
        let client = try await environmentClient(id: environmentID)
        try await client.deleteScheduledTask(id: id)
    }

    /// The environment's provider catalogue, cached from the live config
    /// subscription when this is the active environment and fetched once
    /// otherwise — an automation on a second server still needs a model.
    func scheduledTaskModelCatalog(
        environmentID: String
    ) async throws -> ServerConfigSnapshot? {
        if let cached = serverConfigsByEnvironmentID[environmentID] { return cached }
        let client = try await environmentClient(id: environmentID)
        let config = try await client.serverConfig()
        setServerConfig(config, environmentID: environmentID)
        return config
    }

    private static func mapScheduledTask(
        _ record: ScheduledTaskRecord
    ) -> FeatureScheduledTask {
        FeatureScheduledTask(
            id: record.id,
            title: record.title,
            prompt: record.prompt,
            enabled: record.enabled,
            schedule: featureSchedule(record.schedule),
            projectID: record.projectId,
            threadID: record.threadId,
            launch: FeatureScheduledTaskLaunch(
                workspaceStrategy: record.workspaceStrategy,
                modelSelection: record.modelSelection,
                runtimeMode: record.runtimeMode,
                interactionMode: record.interactionMode
            ),
            nextRunAt: record.nextRunAt,
            lastRunAt: record.lastRunAt,
            // A status this build cannot name reads as "never run" rather than
            // failing the whole list.
            lastRunStatus: ScheduledTaskRunStatus(rawValue: record.lastRunStatus) ?? .never,
            lastRunError: record.lastRunError,
            runCount: record.runCount
        )
    }

    private static func featureSchedule(
        _ schedule: ScheduledTaskRecord.Schedule
    ) -> ScheduledTaskSchedule {
        switch schedule {
        case let .interval(everyMs):
            .interval(everyMs: everyMs)
        case let .fixedTime(timeOfDay, weekdays):
            .fixedTime(
                timeOfDay: timeOfDay,
                // Absent weekdays mean every day, which the editor renders as
                // all seven selected. An empty list would mean the opposite, so
                // the distinction is preserved rather than normalized here.
                weekdays: weekdays.map { $0.compactMap(ScheduledTaskWeekday.init(rawValue:)) }
            )
        }
    }

    private static func wireSchedule(
        _ schedule: ScheduledTaskSchedule
    ) -> ScheduledTaskRecord.Schedule {
        switch schedule {
        case let .interval(everyMs):
            .interval(everyMs: everyMs)
        case let .fixedTime(timeOfDay, weekdays):
            .fixedTime(timeOfDay: timeOfDay, weekdays: weekdays?.map(\.rawValue))
        }
    }
}

// MARK: - Hermes proactive inbox

/// Hermes runs nobody asked for are environment state for the same reason
/// automations are: each paired server reaches its own Hermes gateway and
/// answers for its own inbox, so every call routes through that environment's
/// client rather than the active one.
extension NativeFeatureClient: FeatureHermesInboxManaging {
    func hermesInboxUpdates(
        environmentID: String
    ) async -> AsyncThrowingStream<FeatureHermesInbox, Error> {
        AsyncThrowingStream { continuation in
            let task = Task { @MainActor in
                do {
                    let client = try await environmentClient(id: environmentID)
                    for try await snapshot in await client.hermesProactiveInboxEvents() {
                        continuation.yield(Self.mapHermesInbox(snapshot))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func markHermesRuns(
        environmentID: String,
        ids: [String],
        status: FeatureHermesRunStatus
    ) async throws -> FeatureHermesInbox {
        let client = try await environmentClient(id: environmentID)
        let result = try await client.markHermesProactiveNotifications(
            ids: ids,
            status: status.rawValue
        )
        return Self.mapHermesInbox(result.snapshot)
    }

    private static func mapHermesInbox(
        _ snapshot: HermesProactiveInboxSnapshot
    ) -> FeatureHermesInbox {
        FeatureHermesInbox(
            runs: snapshot.notifications.map { notification in
                FeatureHermesRun(
                    id: notification.notificationId,
                    title: notification.title,
                    body: notification.body,
                    threadID: notification.threadId,
                    // A status this build cannot name reads as already-read
                    // rather than failing the list or inflating the badge.
                    status: FeatureHermesRunStatus(rawValue: notification.status) ?? .read,
                    createdAt: notification.createdAt
                )
            },
            unreadCount: snapshot.unreadCount,
            deadLetterCount: snapshot.deadLetterCount
        )
    }
}

// MARK: - Voice Input

/// Voice Input and its OpenRouter credential are *account* state, not
/// environment state: they live on the T3 Connect relay behind the same Clerk
/// bearer the environment list uses (`packages/contracts/src/relay.ts`), and no
/// paired T3 server can answer for them. That is why these calls do not go
/// through `T3Client` the way automations do.
extension NativeFeatureClient: FeatureVoiceTranscribing {
    /// Reads report an unreachable integration as `.unavailable` rather than
    /// throwing, so a build without relay configuration or an account that is
    /// signed out renders the disconnected state instead of an error.
    func openRouterIntegration() async throws -> OpenRouterIntegrationStatus {
        guard let relay = voiceRelay() else {
            return OpenRouterIntegrationStatus(state: .unavailable)
        }
        do {
            return try await relay.openRouterIntegration()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            return OpenRouterIntegrationStatus(state: .unavailable)
        }
    }

    func putOpenRouterCredential(apiKey: String) async throws -> OpenRouterIntegrationStatus {
        try await requireVoiceRelay().putOpenRouterCredential(apiKey: apiKey)
    }

    func validateOpenRouterCredential() async throws -> OpenRouterIntegrationStatus {
        try await requireVoiceRelay().validateOpenRouterCredential()
    }

    func deleteOpenRouterCredential() async throws -> OpenRouterIntegrationStatus {
        try await requireVoiceRelay().deleteOpenRouterCredential()
    }

    func voiceInputSettings() async throws -> VoiceInputSettings {
        guard let relay = voiceRelay() else { return VoiceInputSettings() }
        do {
            return try await relay.voiceInputSettings()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            // The screen still has to render something to edit; the defaults
            // are the same ones the relay seeds a new account with.
            return VoiceInputSettings()
        }
    }

    func patchVoiceInputSettings(
        _ patch: VoiceInputSettingsPatch
    ) async throws -> VoiceInputSettings {
        try await requireVoiceRelay().patchVoiceInputSettings(patch)
    }

    func listOpenRouterAudioModels() async throws -> [OpenRouterModelOption] {
        guard let relay = voiceRelay() else { return [] }
        return try await relay.listOpenRouterModels(capability: "audio")
    }

    /// Ephemeral: the audio is uploaded, transcribed, optionally cleaned up by a
    /// second model, and discarded. Nothing about the recording is persisted,
    /// which is why it is a plain request/response rather than a job.
    func transcribeVoice(
        _ request: VoiceTranscriptionRequest
    ) async throws -> VoiceTranscriptionResponse {
        try await requireVoiceRelay().transcribeVoice(request)
    }

    private func requireVoiceRelay() throws -> NativeVoiceRelayClient {
        guard let relay = voiceRelay() else {
            throw T3ConnectRelayError.invalidConfiguration(
                t3ConnectController.unavailableReason
                    ?? "Sign in to your T3 account to use Voice Input."
            )
        }
        return relay
    }

    private func voiceRelay() -> NativeVoiceRelayClient? {
        guard let configuration = t3ConnectController.resolution.configuration else {
            return nil
        }
        let controller = t3ConnectController
        return NativeVoiceRelayClient(
            baseURL: configuration.relayHTTPURL,
            transport: URLSessionHTTPTransport()
        ) { @MainActor in
            // Routed through the controller rather than ClerkKit directly: the
            // session coalesces concurrent mints and owns the rate-limit
            // backoff, and minting here would sit outside both.
            try await controller.relayToken()
        }
    }
}

/// The relay's account-preferences surface, narrowed to Voice Input.
///
/// Separate from `T3ConnectRelayClient` because that client speaks DPoP for
/// environment operations, while every endpoint here is a plain Clerk bearer
/// call. Kept injectable so its request shapes and decoding can be asserted
/// against `packages/contracts/src/relay.ts` without a Clerk session.
struct NativeVoiceRelayClient: Sendable {
    let baseURL: URL
    let transport: any HTTPTransport
    /// Main-actor isolated because the only source of a relay token is the
    /// Clerk session the T3 Connect controller owns, and that controller is UI
    /// state.
    let bearerToken: @MainActor @Sendable () async throws -> String

    init(
        baseURL: URL,
        transport: any HTTPTransport,
        bearerToken: @escaping @MainActor @Sendable () async throws -> String
    ) {
        self.baseURL = baseURL
        self.transport = transport
        self.bearerToken = bearerToken
    }

    func openRouterIntegration() async throws -> OpenRouterIntegrationStatus {
        try await send(
            path: ["v1", "client", "integrations", "openrouter"],
            method: "GET",
            as: OpenRouterIntegrationStatus.self
        )
    }

    func putOpenRouterCredential(apiKey: String) async throws -> OpenRouterIntegrationStatus {
        try await send(
            path: ["v1", "client", "integrations", "openrouter", "credential"],
            method: "PUT",
            body: try JSONEncoder.t3.encode(PutOpenRouterCredentialRequest(apiKey: apiKey)),
            as: OpenRouterIntegrationStatus.self
        )
    }

    func validateOpenRouterCredential() async throws -> OpenRouterIntegrationStatus {
        try await send(
            path: ["v1", "client", "integrations", "openrouter", "validate"],
            method: "POST",
            as: OpenRouterIntegrationStatus.self
        )
    }

    func deleteOpenRouterCredential() async throws -> OpenRouterIntegrationStatus {
        try await send(
            path: ["v1", "client", "integrations", "openrouter", "credential"],
            method: "DELETE",
            as: OpenRouterIntegrationStatus.self
        )
    }

    func voiceInputSettings() async throws -> VoiceInputSettings {
        try await send(
            path: ["v1", "client", "preferences", "voice-input"],
            method: "GET",
            as: WireVoiceInputSettings.self
        ).feature
    }

    func patchVoiceInputSettings(
        _ patch: VoiceInputSettingsPatch
    ) async throws -> VoiceInputSettings {
        try await send(
            path: ["v1", "client", "preferences", "voice-input"],
            method: "PATCH",
            body: try JSONEncoder.t3.encode(Self.patchPayload(patch)),
            as: WireVoiceInputSettings.self
        ).feature
    }

    /// The audio travels inline as base64 on a plain JSON POST — there is no
    /// upload endpoint for it — so the 12 MB contract cap is enforced before the
    /// request is built rather than discovered as a rejection.
    ///
    /// Failures decode as `RelayVoiceInputError` rather than going through the
    /// generic error path: the composer branches on the machine-readable code
    /// (no speech, rate limited, needs credit) and a flattened message would
    /// make every provider refusal read the same.
    func transcribeVoice(
        _ request: VoiceTranscriptionRequest
    ) async throws -> VoiceTranscriptionResponse {
        guard request.audio.data.count <= VoiceInputLimits.maximumAudioBytes else {
            throw VoiceInputError(code: .audioTooLarge)
        }
        var urlRequest = URLRequest(
            url: try url(path: ["v1", "client", "voice", "transcriptions"])
        )
        urlRequest.httpMethod = "POST"
        urlRequest.httpBody = try JSONEncoder.t3.encode(request)
        urlRequest.setValue(
            "Bearer \(try await bearerToken())",
            forHTTPHeaderField: "Authorization"
        )
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let (data, response) = try await transport.data(
            for: HTTPRequestPolicy.prepare(urlRequest)
        )
        guard (200..<300).contains(response.statusCode) else {
            throw Self.voiceError(from: data)
                ?? T3ConnectRelayError.response(
                    status: response.statusCode,
                    message: "Voice transcription failed.",
                    traceID: nil
                )
        }
        do {
            return try JSONDecoder.t3.decode(VoiceTranscriptionResponse.self, from: data)
        } catch {
            throw T3ConnectRelayError.invalidResponse
        }
    }

    /// `RelayVoiceInputError` from packages/contracts/src/relay.ts. An
    /// unrecognized code stays nil so the caller falls back to the generic relay
    /// error rather than inventing a category.
    static func voiceError(from data: Data) -> VoiceInputError? {
        guard let body = try? JSONDecoder.t3.decode(RelayVoiceErrorBody.self, from: data),
              let code = body.code.flatMap(VoiceInputErrorCode.init(rawValue:)) else {
            return nil
        }
        return VoiceInputError(code: code, message: body.detail)
    }

    struct RelayVoiceErrorBody: Decodable, Sendable {
        let code: String?
        /// Sanitized upstream provider error text, when one was returned.
        let detail: String?
    }

    func listOpenRouterModels(capability: String) async throws -> [OpenRouterModelOption] {
        try await send(
            path: ["v1", "client", "integrations", "openrouter", "models"],
            method: "GET",
            queryItems: [URLQueryItem(name: "capability", value: capability)],
            as: WireOpenRouterModels.self
        ).models.map {
            OpenRouterModelOption(
                id: $0.id,
                name: $0.name,
                providerName: $0.providerName,
                // Absent means the relay did not say; a model the account
                // cannot call still has to list, so the optimistic reading is
                // the one that keeps another client's selection visible.
                available: $0.available ?? true
            )
        }
    }

    /// `VoiceInputSettingsPatch`. Only the keys the user actually changed are
    /// sent, so two screens editing different fields cannot overwrite each
    /// other — and `language` distinguishes absent (leave it) from explicit
    /// null (detect the spoken language).
    static func patchPayload(_ patch: VoiceInputSettingsPatch) -> JSONValue {
        var payload: [String: JSONValue] = [:]
        if let model = patch.model { payload["model"] = .string(model) }
        switch patch.language {
        case .none: break
        case .automatic: payload["language"] = .null
        case let .explicit(language): payload["language"] = .string(language)
        }
        if let cleanupEnabled = patch.cleanupEnabled {
            payload["cleanup"] = .object(["enabled": .bool(cleanupEnabled)])
        }
        if let dictionary = patch.dictionary {
            payload["dictionary"] = .array(dictionary.map(JSONValue.string))
        }
        return .object(payload)
    }

    private func url(path: [String], queryItems: [URLQueryItem] = []) throws -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.query = nil
        components?.fragment = nil
        components?.path = "/" + path.joined(separator: "/")
        if !queryItems.isEmpty { components?.queryItems = queryItems }
        guard let url = components?.url else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The T3 Connect relay URL is invalid."
            )
        }
        return url
    }

    private func send<Result: Decodable & Sendable>(
        path: [String],
        method: String,
        queryItems: [URLQueryItem] = [],
        body: Data? = nil,
        as type: Result.Type
    ) async throws -> Result {
        var request = URLRequest(url: try url(path: path, queryItems: queryItems))
        request.httpMethod = method
        request.httpBody = body
        request.setValue("Bearer \(try await bearerToken())", forHTTPHeaderField: "Authorization")
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await transport.data(
            for: HTTPRequestPolicy.prepare(request)
        )
        guard (200..<300).contains(response.statusCode) else {
            let error = try? JSONDecoder.t3.decode(RelayErrorBody.self, from: data)
            throw T3ConnectRelayError.response(
                status: response.statusCode,
                message: error?.message ?? error?.reason ?? error?.code
                    ?? "T3 Connect request failed.",
                traceID: error?.traceId
            )
        }
        do {
            return try JSONDecoder.t3.decode(type, from: data)
        } catch {
            throw T3ConnectRelayError.invalidResponse
        }
    }

    private struct PutOpenRouterCredentialRequest: Encodable {
        let apiKey: String
    }

    private struct RelayErrorBody: Decodable {
        let message: String?
        let reason: String?
        let code: String?
        let traceId: String?
    }

    /// The wire spells cleanup as a nested object; the feature model flattens it
    /// to one toggle, which is all the screen exposes.
    private struct WireVoiceInputSettings: Decodable, Sendable {
        struct Cleanup: Decodable, Sendable { let enabled: Bool }

        let model: String
        let language: String?
        let cleanup: Cleanup?
        let dictionary: [String]?

        var feature: VoiceInputSettings {
            VoiceInputSettings(
                model: model,
                language: language,
                cleanupEnabled: cleanup?.enabled ?? true,
                dictionary: dictionary ?? []
            )
        }
    }

    private struct WireOpenRouterModels: Decodable, Sendable {
        struct Model: Decodable, Sendable {
            let id: String
            let name: String
            let providerName: String
            let available: Bool?
        }

        let models: [Model]
    }
}
