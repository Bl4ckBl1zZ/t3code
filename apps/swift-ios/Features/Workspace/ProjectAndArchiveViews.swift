import SwiftUI

/// Adds a project to an environment, either from a folder already on that
/// machine or by cloning a repository into a new one. Presented as a sheet
/// from Home; the commit lives in the toolbar.
public struct AddProjectView: View {
    private struct PendingCloneRegistration: Equatable {
        let environmentID: String
        let remoteURL: String
        let destinationPath: String
        let clonedPath: String
    }

    private enum ProjectMode: String, CaseIterable, Identifiable {
        case folder
        case repository

        var id: String { rawValue }
        var label: String { self == .folder ? "Folder" : "Clone" }
    }

    private enum Field: Hashable {
        case localPath
        case repository
        case destination
    }

    private static let clonedButNotAddedMessage =
        "Repository cloned. Try again to finish adding the project."

    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel

    @State private var selectedEnvironmentID: String?
    @State private var mode = ProjectMode.folder
    @State private var localPath = "~/"
    @State private var source = ProjectRemoteSource.url
    @State private var repositoryInput = ""
    @State private var destinationPath = "~/"
    @State private var resolvedRepository: SourceControlRepositoryInfo?
    @State private var didEditDestination = false
    @State private var pendingCloneRegistration: PendingCloneRegistration?

    @State private var browsePath = "~/"
    @State private var browseResult: FilesystemBrowseResult?
    @State private var isBrowsing = false
    @State private var browseError: String?
    @State private var browseRequestID: UUID?

    @State private var discovery: SourceControlDiscoveryResult?
    @State private var isDiscovering = false
    @State private var discoveryError: String?
    @State private var discoveryRequestID: UUID?

    @State private var isLookingUp = false
    @State private var lookupRequestID: UUID?

    @State private var isSubmitting = false
    @State private var isReconnecting = false
    @State private var errorMessage: String?
    @State private var cloneRequestID: UUID?
    @FocusState private var focusedField: Field?

    public init(model: FeatureRootModel) {
        self.model = model
    }

    public var body: some View {
        NavigationStack {
            Group {
                if let environment = selectedEnvironment {
                    form(environment)
                } else {
                    unavailableView
                }
            }
            .background(T3Colors.background)
            .navigationTitle("Add Project")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(
                .cancel,
                confirm: selectedEnvironment.map(confirmation),
                hasChanges: isSubmitting
            )
        }
        .onAppear(perform: selectEnvironmentIfNeeded)
        .onChange(of: model.snapshot.environments) {
            selectEnvironmentIfNeeded()
        }
        .onChange(of: model.snapshot.connection.state) {
            selectEnvironmentIfNeeded()
        }
        .onChange(of: mode) {
            focusedField = nil
            errorMessage = nil
        }
        .onChange(of: localPath) {
            errorMessage = nil
        }
        .onChange(of: source) {
            clearRepositoryResolution()
        }
        .onChange(of: repositoryInput) {
            clearRepositoryResolution()
        }
        .task(id: selectedEnvironmentID) {
            guard selectedEnvironmentID != nil else { return }
            resetEnvironmentState()
            await loadDirectory(browsePath, updateSelection: false)
            await loadDiscovery()
        }
    }

    private var projectClient: (any FeatureProjectCreationClient)? {
        model.client as? any FeatureProjectCreationClient
    }

    private var environments: [FeatureEnvironment] {
        model.snapshot.environments.sorted { lhs, rhs in
            if lhs.isActive != rhs.isActive { return lhs.isActive }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    private var selectedEnvironment: FeatureEnvironment? {
        environments.first { $0.id == selectedEnvironmentID && canCreateProject(in: $0) }
    }

    private var sourceOptions: [ProjectRemoteSourceOption] {
        ProjectRemoteSourceOptions.options(discovery: discovery)
    }

    private var needsRepositoryLookup: Bool {
        source.provider != nil && resolvedRepository == nil
    }

    /// Folder browsing needs the project-creation client; without it the
    /// path can still be typed.
    private var canBrowse: Bool {
        projectClient != nil
    }

    private var showsFolderBrowser: Bool {
        canBrowse && (mode == .folder || !needsRepositoryLookup)
    }

    private var repositoryName: String {
        ProjectCreationPath.repositoryName(
            from: resolvedRepository?.nameWithOwner ?? repositoryInput
        )
    }

    private var remoteURL: String {
        resolvedRepository?.sshUrl
            ?? repositoryInput.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Form

    private func form(_ environment: FeatureEnvironment) -> some View {
        Form {
            if environments.count > 1 {
                Section {
                    environmentPicker
                }
                .t3GroupedRow()
            }
            Section {
                Picker("Add from", selection: $mode) {
                    ForEach(ProjectMode.allCases) { candidate in
                        Text(candidate.label).tag(candidate)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            switch mode {
            case .folder:
                locationSection(environment)
            case .repository:
                repositorySection(environment)
                if !needsRepositoryLookup {
                    destinationSection(environment)
                }
            }
            if showsFolderBrowser {
                folderBrowser
            }
        }
        .t3GroupedListBackground()
        .scrollDismissesKeyboard(.interactively)
        // Edits would orphan the request in flight; its result is only
        // applied while the inputs still match.
        .disabled(isSubmitting)
        .refreshable {
            await loadDirectory(browsePath, updateSelection: false)
            if mode == .repository {
                await loadDiscovery()
            }
        }
    }

    private var environmentPicker: some View {
        Picker("Environment", selection: $selectedEnvironmentID) {
            ForEach(environments) { option in
                environmentOption(option)
                    .tag(Optional(option.id))
                    .disabled(!canCreateProject(in: option))
            }
        }
        .pickerStyle(.menu)
    }

    /// Menu items read a second text as the item's subtitle.
    @ViewBuilder
    private func environmentOption(_ option: FeatureEnvironment) -> some View {
        if canCreateProject(in: option) {
            Text(option.name)
        } else {
            VStack(alignment: .leading) {
                Text(option.name)
                Text("Unreachable")
            }
        }
    }

    private func locationSection(_ environment: FeatureEnvironment) -> some View {
        Section {
            HStack(spacing: 8) {
                pathField("Path", prompt: "~/projects/my-app", text: $localPath, field: .localPath)
                    .onSubmit(browseEnteredPath)
                if canBrowse {
                    Button(action: browseEnteredPath) {
                        Image(systemName: "folder")
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(T3Colors.accent)
                    .accessibilityLabel("Browse entered path")
                }
            }
        } header: {
            Text("Location")
        } footer: {
            if let problem = errorMessage
                ?? message(for: pathIssue(localPath, in: environment), in: environment, target: "folder") {
                errorFooter(problem)
            } else if canBrowse {
                Text("A folder on \(environment.name). Type a path or pick one below.")
            } else {
                Text("Folder browsing is unavailable. You can still enter a path directly.")
            }
        }
        .t3GroupedRow()
    }

    private func repositorySection(_ environment: FeatureEnvironment) -> some View {
        Section {
            Picker("Source", selection: $source) {
                ForEach(sourceOptions) { option in
                    sourceOption(option)
                        .tag(option.source)
                        .disabled(!option.isReady)
                }
            }
            .pickerStyle(.menu)

            HStack(spacing: 8) {
                TextField(
                    source == .url ? "Remote URL" : "Repository",
                    text: $repositoryInput,
                    prompt: Text(source.prompt)
                )
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(source == .url ? .URL : .default)
                .submitLabel(needsRepositoryLookup ? .search : .next)
                .focused($focusedField, equals: .repository)
                .onSubmit {
                    if needsRepositoryLookup {
                        Task { await resolveRepository(environment) }
                    } else {
                        focusedField = .destination
                    }
                }
                if isLookingUp {
                    ProgressView()
                        .accessibilityLabel("Looking up repository")
                }
            }

            if let resolvedRepository {
                resolvedRepositoryRow(resolvedRepository)
            }
        } header: {
            HStack(spacing: 6) {
                Text("Repository")
                if isDiscovering {
                    ProgressView().controlSize(.small)
                }
            }
        } footer: {
            if needsRepositoryLookup, let errorMessage {
                errorFooter(errorMessage)
            } else if let discoveryError {
                Text(discoveryError)
            } else if needsRepositoryLookup {
                Text("Tap Search to look up the repository on \(source.label).")
            }
        }
        .t3GroupedRow()
    }

    @ViewBuilder
    private func sourceOption(_ option: ProjectRemoteSourceOption) -> some View {
        if let detail = option.detail {
            VStack(alignment: .leading) {
                Text(option.source.label)
                Text(detail)
            }
        } else {
            Text(option.source.label)
        }
    }

    private func resolvedRepositoryRow(_ repository: SourceControlRepositoryInfo) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title3)
                .foregroundStyle(T3Colors.success)
                .accessibilityLabel("Found")
            VStack(alignment: .leading, spacing: 2) {
                Text(repository.nameWithOwner)
                    .foregroundStyle(T3Colors.textPrimary)
                Text(repository.sshUrl)
                    .font(T3Typography.supporting.monospaced())
                    .foregroundStyle(T3Colors.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func destinationSection(_ environment: FeatureEnvironment) -> some View {
        Section {
            pathField(
                "Destination",
                prompt: "~/projects/\(repositoryName)",
                text: destinationBinding,
                field: .destination
            )
        } header: {
            Text("Destination")
        } footer: {
            if let problem = errorMessage
                ?? message(for: pathIssue(destinationPath, in: environment), in: environment, target: "destination") {
                errorFooter(problem)
            } else if pendingCloneRegistration != nil {
                Text(Self.clonedButNotAddedMessage)
            } else {
                Text("Cloned on \(environment.name).")
            }
        }
        .t3GroupedRow()
    }

    private var folderBrowser: some View {
        Section {
            if let parentPath = ProjectCreationPath.parentBrowsePath(of: browsePath) {
                Button {
                    openFolder(parentPath)
                } label: {
                    Label("Parent Folder", systemImage: "arrow.up")
                }
                .disabled(isBrowsing)
            }
            if let entries = browseResult?.entries, !entries.isEmpty {
                ForEach(entries, id: \.fullPath) { entry in
                    Button {
                        openFolder(ProjectCreationPath.directoryBrowsePath(entry.fullPath))
                    } label: {
                        HStack(spacing: 12) {
                            Label {
                                Text(entry.name)
                                    .foregroundStyle(T3Colors.textPrimary)
                                    .lineLimit(1)
                            } icon: {
                                Image(systemName: "folder.fill")
                                    .foregroundStyle(T3Colors.accent)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(T3Colors.textTertiary)
                                .accessibilityHidden(true)
                        }
                        .contentShape(Rectangle())
                    }
                    .disabled(isBrowsing)
                }
            } else if browseResult != nil, !isBrowsing, browseError == nil {
                Text("No Folders")
                    .foregroundStyle(T3Colors.textSecondary)
            }
        } header: {
            HStack(spacing: 6) {
                Text(ProjectCreationPath.abbreviatingHome(browsePath))
                    .font(T3Typography.supporting.monospaced())
                    .textCase(nil)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .accessibilityLabel("Folders in \(ProjectCreationPath.abbreviatingHome(browsePath))")
                if isBrowsing {
                    ProgressView().controlSize(.small)
                }
            }
        } footer: {
            if let browseError {
                Text(browseError)
            }
        }
        .t3GroupedRow()
    }

    private var unavailableView: some View {
        ContentUnavailableView {
            Label("Environment Unavailable", systemImage: "server.rack")
        } description: {
            Text("Reconnect a T3 environment before adding a project.")
        } actions: {
            Button(isReconnecting ? "Reconnecting…" : "Reconnect") {
                Task { await reconnect() }
            }
            .t3SecondaryButtonStyle()
            .disabled(isReconnecting)
        }
    }

    private func pathField(
        _ title: String,
        prompt: String,
        text: Binding<String>,
        field: Field
    ) -> some View {
        TextField(title, text: text, prompt: Text(prompt))
            .font(.body.monospaced())
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .focused($focusedField, equals: field)
    }

    private func errorFooter(_ message: String) -> some View {
        Text(message)
            .foregroundStyle(T3Colors.danger)
    }

    private func confirmation(_ environment: FeatureEnvironment) -> T3SheetConfirmation {
        let commit = switch mode {
        case .folder:
            AddProjectCommit.folder(pathIssue: pathIssue(localPath, in: environment))
        case .repository:
            AddProjectCommit.clone(
                remoteURL: remoteURL,
                needsLookup: needsRepositoryLookup,
                destinationIssue: pathIssue(destinationPath, in: environment),
                hasClonedCopy: pendingCloneRegistration != nil
            )
        }
        return T3SheetConfirmation(
            title: commit.title,
            isEnabled: commit.isEnabled,
            isBusy: isSubmitting
        ) {
            focusedField = nil
            Task {
                switch mode {
                case .folder: await addLocalProject(environment)
                case .repository: await cloneProject(environment)
                }
            }
        }
    }

    private var destinationBinding: Binding<String> {
        Binding(
            get: { destinationPath },
            set: { value in
                didEditDestination = true
                destinationPath = value
                pendingCloneRegistration = nil
                cloneRequestID = nil
                errorMessage = nil
            }
        )
    }

    // MARK: - Validation

    private func pathIssue(_ path: String, in environment: FeatureEnvironment) -> ProjectPathIssue? {
        ProjectCreationPath.issue(
            for: path,
            serverPath: browseResult?.parentPath,
            environmentID: environment.id,
            projects: model.snapshot.projects
        )
    }

    /// Footer copy for a path issue. `target` names what the path is for.
    private func message(
        for issue: ProjectPathIssue?,
        in environment: FeatureEnvironment,
        target: String
    ) -> String? {
        switch issue {
        case nil, .empty:
            nil
        case let .malformed(message):
            message
        case .foreignFilesystem:
            "Use a path that matches \(environment.name)’s filesystem."
        case let .alreadyUsed(projectName):
            "\(projectName) already uses this \(target)."
        }
    }

    private func canCreateProject(in environment: FeatureEnvironment) -> Bool {
        let state = environment.isActive
            ? model.snapshot.connection.state
            : environment.connectionState
        return state != .disconnected
    }

    // MARK: - Actions

    private func selectEnvironmentIfNeeded() {
        if let selectedEnvironmentID,
           environments.contains(where: {
               $0.id == selectedEnvironmentID && canCreateProject(in: $0)
           }) {
            return
        }
        selectedEnvironmentID = environments.first(where: canCreateProject)?.id
    }

    private func reconnect() async {
        isReconnecting = true
        defer { isReconnecting = false }
        await model.reload(reason: "add-project-reconnect")
        selectEnvironmentIfNeeded()
    }

    private func clearRepositoryResolution() {
        resolvedRepository = nil
        lookupRequestID = nil
        isLookingUp = false
        pendingCloneRegistration = nil
        cloneRequestID = nil
        updateSuggestedDestination()
        errorMessage = nil
    }

    private func resetEnvironmentState() {
        browsePath = "~/"
        browseResult = nil
        browseError = nil
        browseRequestID = nil
        discovery = nil
        discoveryError = nil
        discoveryRequestID = nil
        source = .url
        resolvedRepository = nil
        lookupRequestID = nil
        isLookingUp = false
        pendingCloneRegistration = nil
        cloneRequestID = nil
        didEditDestination = false
        localPath = "~/"
        destinationPath = repositoryInput.isEmpty
            ? "~/"
            : ProjectCreationPath.appending(repositoryName, to: "~/")
        errorMessage = nil
    }

    private func browseEnteredPath() {
        focusedField = nil
        Task {
            await loadDirectory(
                ProjectCreationPath.directoryBrowsePath(localPath),
                updateSelection: false
            )
        }
    }

    private func openFolder(_ path: String) {
        focusedField = nil
        Task { await loadDirectory(path, updateSelection: true) }
    }

    private func loadDiscovery() async {
        guard let environmentID = selectedEnvironmentID,
              let projectClient else {
            discoveryError = "Git URL cloning is available. Provider discovery is unavailable."
            return
        }
        let requestID = UUID()
        discoveryRequestID = requestID
        isDiscovering = true
        defer {
            if discoveryRequestID == requestID {
                isDiscovering = false
            }
        }
        do {
            let result = try await projectClient.discoverProjectSources(
                environmentID: environmentID
            )
            guard discoveryRequestID == requestID,
                  selectedEnvironmentID == environmentID else {
                return
            }
            discovery = result
            discoveryError = nil
        } catch is CancellationError {
            return
        } catch {
            guard discoveryRequestID == requestID,
                  selectedEnvironmentID == environmentID else {
                return
            }
            discovery = nil
            discoveryError = "Provider discovery unavailable. Git URL still works."
        }
    }

    private func loadDirectory(_ path: String, updateSelection: Bool) async {
        // Without a project client the browser is hidden and the Location
        // footer says so.
        guard let environmentID = selectedEnvironmentID,
              let projectClient else {
            return
        }
        let requestedPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !requestedPath.isEmpty else { return }
        let requestID = UUID()
        browseRequestID = requestID
        isBrowsing = true
        browseError = nil
        defer {
            if browseRequestID == requestID {
                isBrowsing = false
            }
        }
        do {
            let result = try await projectClient.browseProjectFolders(
                environmentID: environmentID,
                partialPath: requestedPath
            )
            guard browseRequestID == requestID,
                  selectedEnvironmentID == environmentID else {
                return
            }
            let selectedDirectory = result.parentPath
            browsePath = ProjectCreationPath.directoryBrowsePath(selectedDirectory)
            browseResult = result
            if updateSelection {
                switch mode {
                case .folder:
                    localPath = selectedDirectory
                case .repository:
                    if !didEditDestination {
                        pendingCloneRegistration = nil
                        destinationPath = ProjectCreationPath.appending(
                            repositoryName,
                            to: selectedDirectory
                        )
                    }
                }
            }
        } catch is CancellationError {
            return
        } catch {
            guard browseRequestID == requestID,
                  selectedEnvironmentID == environmentID else {
                return
            }
            browseError = "Couldn’t browse that folder. Direct path entry still works."
        }
    }

    private func addLocalProject(_ environment: FeatureEnvironment) async {
        guard pathIssue(localPath, in: environment) == nil else { return }
        let path = localPath.trimmingCharacters(in: .whitespacesAndNewlines)

        errorMessage = nil
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            if let projectClient {
                try await projectClient.addProject(
                    environmentID: environment.id,
                    path: path
                )
                finish()
            } else if environment.isActive, await model.addProject(path: path) {
                finish()
            } else {
                // Shown in the sheet, so the root alert stays quiet.
                let message = model.errorMessage ?? "The project could not be added."
                model.errorMessage = nil
                fail(message)
            }
        } catch is CancellationError {
            return
        } catch {
            fail(projectErrorMessage(error))
        }
    }

    private func resolveRepository(_ environment: FeatureEnvironment) async {
        guard let provider = source.provider else { return }
        let repository = repositoryInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !repository.isEmpty else {
            errorMessage = "Enter a repository name."
            return
        }
        guard let projectClient else {
            errorMessage = "Repository lookup is unavailable on this connection."
            return
        }

        errorMessage = nil
        let requestID = UUID()
        lookupRequestID = requestID
        isLookingUp = true
        defer {
            if lookupRequestID == requestID {
                isLookingUp = false
            }
        }
        do {
            let result = try await projectClient.lookupProjectRepository(
                environmentID: environment.id,
                provider: provider,
                repository: repository
            )
            guard lookupRequestIsCurrent(
                requestID,
                environmentID: environment.id,
                provider: provider,
                repository: repository
            ) else {
                return
            }
            resolvedRepository = result
            updateSuggestedDestination()
            focusedField = .destination
        } catch is CancellationError {
            return
        } catch {
            guard lookupRequestIsCurrent(
                requestID,
                environmentID: environment.id,
                provider: provider,
                repository: repository
            ) else {
                return
            }
            fail(projectErrorMessage(error))
        }
    }

    private func lookupRequestIsCurrent(
        _ requestID: UUID,
        environmentID: String,
        provider: SourceControlProviderKind,
        repository: String
    ) -> Bool {
        lookupRequestID == requestID
            && selectedEnvironmentID == environmentID
            && source.provider == provider
            && repositoryInput.trimmingCharacters(in: .whitespacesAndNewlines) == repository
    }

    private func cloneProject(_ environment: FeatureEnvironment) async {
        let remoteURL = self.remoteURL
        guard !remoteURL.isEmpty,
              pathIssue(destinationPath, in: environment) == nil else {
            return
        }
        let validatedDestination = destinationPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let projectClient else {
            fail("Repository cloning is unavailable on this connection.")
            return
        }

        errorMessage = nil
        let requestID = UUID()
        cloneRequestID = requestID
        isSubmitting = true
        defer {
            isSubmitting = false
            if cloneRequestID == requestID {
                cloneRequestID = nil
            }
        }
        do {
            let clonedPath: String
            if let pending = pendingCloneRegistration,
               pending.environmentID == environment.id,
               pending.remoteURL == remoteURL,
               pending.destinationPath == validatedDestination {
                clonedPath = pending.clonedPath
            } else {
                let result = try await projectClient.cloneProjectRepository(
                    environmentID: environment.id,
                    remoteURL: remoteURL,
                    destinationPath: validatedDestination
                )
                guard cloneRequestIsCurrent(
                    requestID,
                    environmentID: environment.id,
                    remoteURL: remoteURL,
                    destinationPath: validatedDestination
                ) else {
                    return
                }
                clonedPath = result.cwd
                pendingCloneRegistration = PendingCloneRegistration(
                    environmentID: environment.id,
                    remoteURL: remoteURL,
                    destinationPath: validatedDestination,
                    clonedPath: result.cwd
                )
            }
            guard cloneRequestIsCurrent(
                requestID,
                environmentID: environment.id,
                remoteURL: remoteURL,
                destinationPath: validatedDestination
            ) else {
                return
            }
            try await projectClient.addProject(
                environmentID: environment.id,
                path: clonedPath
            )
            guard cloneRequestIsCurrent(
                requestID,
                environmentID: environment.id,
                remoteURL: remoteURL,
                destinationPath: validatedDestination
            ) else {
                return
            }
            pendingCloneRegistration = nil
            finish()
        } catch is CancellationError {
            return
        } catch {
            guard cloneRequestIsCurrent(
                requestID,
                environmentID: environment.id,
                remoteURL: remoteURL,
                destinationPath: validatedDestination
            ) else {
                return
            }
            fail(
                pendingCloneRegistration != nil
                    ? Self.clonedButNotAddedMessage
                    : projectErrorMessage(error)
            )
        }
    }

    private func cloneRequestIsCurrent(
        _ requestID: UUID,
        environmentID: String,
        remoteURL: String,
        destinationPath: String
    ) -> Bool {
        cloneRequestID == requestID
            && selectedEnvironmentID == environmentID
            && self.remoteURL == remoteURL
            && self.destinationPath.trimmingCharacters(in: .whitespacesAndNewlines)
                == destinationPath
    }

    private func updateSuggestedDestination() {
        guard !didEditDestination, !repositoryInput.isEmpty else { return }
        destinationPath = ProjectCreationPath.appending(repositoryName, to: browsePath)
    }

    private func finish() {
        PlatformHapticEngine.shared.play(.success)
        dismiss()
    }

    private func fail(_ message: String) {
        errorMessage = message
        PlatformHapticEngine.shared.play(.error)
    }

    private func projectErrorMessage(_ error: Error) -> String {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? "The server could not complete that request." : message
    }
}
