import SwiftUI

/// Optional setup after pairing, also reachable from Settings on existing
/// installations: choose computers, check their agents, import projects.
/// Each step is a pushed page; closing at any point means "Set Up Later".
struct AgentSetupView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    var onFinished: (() -> Void)?
    @State private var path: [AgentSetupPage] = []
    @State private var selectedComputers = Set<String>()
    @State private var scans: [String: AgentSessionScanResult] = [:]
    @State private var scanErrors: [String: String] = [:]
    @State private var scanning = Set<String>()
    @State private var selectedPaths: [String: Set<String>] = [:]
    @State private var attemptedProjects: [String: String] = [:]
    @State private var completedImports = Set<String>()
    @State private var importStatuses: [String: AgentImportStatus] = [:]
    @State private var importProgress: (done: Int, total: Int)?
    @State private var generation = UUID()
    @State private var importSummary: AgentImportSummary?
    private struct TerminalPresentation: Identifiable {
        let id = UUID()
        let session: any FeatureAgentSetupTerminal
        let title: String
        let machineName: String
    }
    @State private var setupTerminal: TerminalPresentation?
    @State private var providers: [String: [ServerProviderSnapshot]] = [:]
    @State private var providerErrors: [String: String] = [:]
    @State private var loadingProviders = Set<String>()
    @State private var openingTerminal = false
    private var importer: (any FeatureAgentSessionImporting)? { model.client as? any FeatureAgentSessionImporting }
    private var environments: [FeatureEnvironment] { model.snapshot.environments.filter { selectedComputers.contains($0.id) } }
    private var importing: Bool { importProgress != nil }
    private var selectedCount: Int {
        environments.reduce(0) { count, environment in
            count + candidates(environment.id).filter { isSelected($0.path, environmentID: environment.id) }.count
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            computersPage
                .navigationDestination(for: AgentSetupPage.self) { page in
                    switch page {
                    case .agents: agentsPage
                    case .projects: projectsPage
                    case .addComputer:
                        ConnectionOnboardingView(model: model, onConnected: {
                            selectedComputers.formUnion(model.snapshot.environments.map(\.id))
                        })
                    }
                }
        }
        .interactiveDismissDisabled(importing)
        .onAppear {
            if selectedComputers.isEmpty {
                selectedComputers = Set(model.snapshot.environments.filter { !$0.isUnreachable }.map(\.id))
            }
        }
        .onDisappear {
            generation = UUID()
            // Swiping the sheet away is the same "Set Up Later" as the close button.
            onFinished?()
        }
        .sheet(item: $setupTerminal, onDismiss: { Task { await refreshProviders() } }) { presentation in
            AgentSetupTerminalView(
                session: presentation.session,
                title: presentation.title,
                machineName: presentation.machineName
            )
        }
    }

    // MARK: - Step 1: computers

    private var computersPage: some View {
        List {
            AgentSetupHeader(
                systemImage: "laptopcomputer",
                title: "Choose Your Computers",
                message: "Where your agents and code live. You can set up several together."
            )
            Section {
                ForEach(model.snapshot.environments) { environment in
                    Button {
                        if selectedComputers.contains(environment.id) { selectedComputers.remove(environment.id) }
                        else { selectedComputers.insert(environment.id) }
                    } label: {
                        HStack(spacing: 12) {
                            AgentSetupCheckmark(state: selectedComputers.contains(environment.id) ? .on : .off)
                            Image(systemName: environment.machineSymbol)
                                .foregroundStyle(T3Colors.textSecondary)
                                .frame(width: 26)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(environment.name).foregroundStyle(T3Colors.textPrimary)
                                if environment.isUnreachable {
                                    Text("Unreachable").font(T3Typography.supporting).foregroundStyle(T3Colors.warning)
                                } else {
                                    Text(environment.connectionDetail ?? environment.endpoint)
                                        .font(T3Typography.supporting)
                                        .foregroundStyle(T3Colors.textTertiary)
                                        .lineLimit(2)
                                }
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .accessibilityAddTraits(selectedComputers.contains(environment.id) ? .isSelected : [])
                }
                NavigationLink(value: AgentSetupPage.addComputer) {
                    Label("Add Computer…", systemImage: "plus")
                        .foregroundStyle(T3Colors.accent)
                }
            }
            .t3GroupedRow()
        }
        .agentSetupPageChrome(step: 1)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                if #available(iOS 26, *) {
                    Button(role: .close) { dismiss() }
                        .accessibilityLabel("Set Up Later")
                } else {
                    Button("Set Up Later") { dismiss() }
                }
            }
        }
        .t3BottomBar {
            Button {
                path.append(.agents)
            } label: {
                Text("Continue").frame(maxWidth: .infinity)
            }
            .t3ProminentButtonStyle()
            .controlSize(.large)
            .disabled(selectedComputers.isEmpty)
        }
    }

    // MARK: - Step 2: agents

    private var agentsPage: some View {
        List {
            AgentSetupHeader(
                systemImage: "sparkles",
                title: "Your Agents",
                message: "Each computer needs a signed-in Codex or Claude Code."
            )
            ForEach(environments) { environment in
                agentSection(environment)
            }
        }
        .agentSetupPageChrome(step: 2)
        .task { await refreshProviders() }
        .t3BottomBar {
            Button {
                path.append(.projects)
            } label: {
                Text("Continue").frame(maxWidth: .infinity)
            }
            .t3ProminentButtonStyle()
            .controlSize(.large)
        }
    }

    private func agentSection(_ environment: FeatureEnvironment) -> some View {
        let loaded = providers[environment.id].map { $0.filter(\.isSetupAgent) }
        return Section {
            if let error = providerErrors[environment.id] {
                AgentSetupErrorRow(message: error) {
                    Task { await refreshProviders(only: environment.id) }
                }
            }
            if let loaded {
                ForEach(loaded) { provider in
                    providerRow(provider, environment: environment)
                }
            } else if loadingProviders.contains(environment.id) {
                ForEach(0..<2, id: \.self) { _ in
                    AgentSetupPlaceholderRow()
                }
            }
        } header: {
            Label(environment.name, systemImage: environment.machineSymbol)
        } footer: {
            if loaded?.isEmpty == true {
                Text("No Codex or Claude Code on this computer.")
            } else {
                Text("Other agents and account settings are in T3 Code on your computer.")
            }
        }
        .t3GroupedRow()
    }

    private func providerRow(_ provider: ServerProviderSnapshot, environment: FeatureEnvironment) -> some View {
        let state = AgentSetupProviderState(provider)
        let name = provider.displayName ?? (provider.driver == "claudeAgent" ? "Claude Code" : "Codex")
        return HStack(spacing: 12) {
            ProviderIcon(driver: provider.driver, providerID: provider.instanceId, fallbackName: provider.driver, size: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).foregroundStyle(T3Colors.textPrimary)
                Text(state.label).font(T3Typography.supporting).foregroundStyle(state.tone.color)
            }
            Spacer(minLength: 8)
            if let action = state.action {
                Button(action.title) {
                    Task {
                        await openTerminal(
                            environment: environment,
                            providerID: provider.instanceId,
                            title: "\(action.title) \(name)"
                        )
                    }
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .tint(T3Colors.accent)
                .disabled(openingTerminal)
            }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Step 3: projects

    private var projectsPage: some View {
        List {
            AgentSetupHeader(
                systemImage: nil,
                title: "Choose Your Projects",
                message: "Import Claude Code and Codex conversations from the last 30 days. Imported history starts in Settled, ready to resume."
            )
            if let importSummary {
                Section {
                    Label {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(importSummary.title).font(.subheadline.weight(.semibold)).foregroundStyle(T3Colors.textPrimary)
                            Text(importSummary.message).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                        }
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(T3Colors.warning)
                    }
                    .accessibilityElement(children: .combine)
                }
                .t3GroupedRow()
            }
            if importer == nil {
                Section {
                    ContentUnavailableView {
                        Label("Project Import Unavailable", systemImage: "tray.and.arrow.down")
                    } description: {
                        Text("Project import is unavailable in this client.")
                    } actions: {
                        Button("Skip") { dismiss() }
                            .t3SecondaryButtonStyle()
                    }
                }
                .listRowBackground(Color.clear)
            } else {
                ForEach(environments) { environment in
                    projectSection(environment)
                }
            }
        }
        .agentSetupPageChrome(step: 3)
        .navigationBarBackButtonHidden(importing)
        .toolbar {
            if importer != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button(allSelected ? "Deselect All" : "Select All") {
                        let select = !allSelected
                        for environment in environments {
                            selectedPaths[environment.id] = select ? Set(candidates(environment.id).map(\.path)) : []
                        }
                    }
                    .disabled(importing || environments.allSatisfy { candidates($0.id).isEmpty })
                }
            }
        }
        .task {
            guard !importing else { return }
            await scan()
        }
        .t3BottomBar { projectsActions }
    }

    @ViewBuilder
    private var projectsActions: some View {
        if let importProgress {
            VStack(alignment: .leading, spacing: 8) {
                Text("Importing \(min(importProgress.done + 1, importProgress.total)) of \(importProgress.total) projects…")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textPrimary)
                ProgressView(value: Double(importProgress.done), total: Double(max(importProgress.total, 1)))
                    .tint(T3Colors.primaryAction)
            }
            .frame(maxWidth: .infinity)
        } else if importer != nil {
            ViewThatFits {
                HStack(spacing: 12) { projectButtons }
                VStack(spacing: 12) { projectButtons }
            }
        }
    }

    @ViewBuilder
    private var projectButtons: some View {
        Button(importSummary == nil ? "Skip" : "Continue") { dismiss() }
            .t3SecondaryButtonStyle()
            .controlSize(.large)
        Button {
            Task { await importSelected() }
        } label: {
            Group {
                if importSummary != nil {
                    Text("Retry ^[\(pendingCount) Project](inflect: true)")
                } else {
                    Text("Import ^[\(selectedCount) Project](inflect: true)")
                }
            }
            .frame(maxWidth: .infinity)
        }
        .t3ProminentButtonStyle()
        .controlSize(.large)
        .disabled(selectedCount == 0 || !scanning.isEmpty || (importSummary != nil && pendingCount == 0))
    }

    private func projectSection(_ environment: FeatureEnvironment) -> some View {
        let result = scans[environment.id]
        let all = result?.candidates ?? []
        let selected = all.filter { isSelected($0.path, environmentID: environment.id) }.count
        return Section {
            if scanning.contains(environment.id) {
                ProgressView("Looking for projects…")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let error = scanErrors[environment.id] {
                AgentSetupErrorRow(message: error) {
                    Task { await scan(only: environment.id) }
                }
                .disabled(importing || !scanning.isEmpty)
            }
            if !all.isEmpty {
                candidateList(all, environmentID: environment.id)
            }
        } header: {
            if all.isEmpty {
                Text(environment.name)
            } else {
                Text("\(environment.name) · \(selected) of \(all.count)")
            }
        } footer: {
            if let result {
                if result.candidates.isEmpty {
                    Text("No Claude Code or Codex projects found.")
                } else if result.truncated == true {
                    Text("Scan limit reached. Some projects or conversations may be missing.")
                }
            }
        }
        .t3GroupedRow()
    }

    @ViewBuilder private func candidateList(_ candidates: [AgentSessionProjectCandidate], environmentID: String) -> some View {
        let repositories = candidates.filter { !$0.reportsGitIdentity || $0.git != nil }
        let groups = Dictionary(grouping: repositories) { $0.git?.remoteKey ?? "path:\($0.path)" }
        let ordered = groups.keys.sorted { left, right in
            let a = groups[left]?.compactMap(\.lastActiveAt).max() ?? ""
            let b = groups[right]?.compactMap(\.lastActiveAt).max() ?? ""
            return a == b ? left < right : a > b
        }
        ForEach(ordered, id: \.self) { key in
            let rows = groups[key] ?? []
            if rows.count == 1, let row = rows.first { candidateRow(row, environmentID: environmentID) }
            else if let first = rows.first {
                DisclosureGroup {
                    ForEach(rows) { candidateRow($0, environmentID: environmentID) }
                } label: {
                    HStack(spacing: 12) {
                        Button {
                            let select = selectionState(rows, environmentID: environmentID) != .on
                            for row in rows { toggle(row.path, environmentID: environmentID, selected: select) }
                        } label: {
                            AgentSetupCheckmark(state: selectionState(rows, environmentID: environmentID))
                        }
                        .buttonStyle(.borderless)
                        .disabled(importing)
                        .accessibilityLabel(selectionState(rows, environmentID: environmentID) == .on ? "Deselect all" : "Select all")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(first.git?.repository ?? first.title).foregroundStyle(T3Colors.textPrimary)
                            Text("\(rows.count) worktrees · ^[\(rows.reduce(0) { $0 + $1.threadCount }) conversation](inflect: true)")
                                .font(.caption)
                                .foregroundStyle(T3Colors.textTertiary)
                        }
                    }
                }
            }
        }
        let folders = candidates.filter { $0.reportsGitIdentity && $0.git == nil }
        if !folders.isEmpty {
            DisclosureGroup("Other Folders (\(folders.count))") {
                ForEach(folders) { candidateRow($0, environmentID: environmentID) }
            }
            .foregroundStyle(T3Colors.textPrimary)
        }
    }

    private func candidateRow(_ candidate: AgentSessionProjectCandidate, environmentID: String) -> some View {
        let selected = isSelected(candidate.path, environmentID: environmentID)
        let status = importStatuses[importKey(environmentID, candidate.path)]
        return Button {
            toggle(candidate.path, environmentID: environmentID, selected: !selected)
        } label: {
            HStack(alignment: .top, spacing: 12) {
                AgentImportStatusIcon(status: status, isSelected: selected)
                VStack(alignment: .leading, spacing: 3) {
                    Text(candidate.git?.repository ?? candidate.title).foregroundStyle(T3Colors.textPrimary)
                    Text(candidate.path).font(.caption.monospaced()).foregroundStyle(T3Colors.textTertiary).lineLimit(2)
                    if let status, let text = status.text {
                        Text(text).font(.caption).foregroundStyle(status.tone.color)
                    } else {
                        Text(candidateSummary(candidate)).font(.caption).foregroundStyle(T3Colors.textTertiary)
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .disabled(importing)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func candidateSummary(_ candidate: AgentSessionProjectCandidate) -> AttributedString {
        let sources = candidate.sources.map(AgentSetupProviderState.sourceName).joined(separator: ", ")
        var summary = AttributedString(localized: "^[\(candidate.threadCount) conversation](inflect: true)")
        if !sources.isEmpty { summary = AttributedString("\(sources) · ") + summary }
        if let activity = candidate.lastActiveAt, let date = AgentSessionProjectCandidate.activityDate(activity) {
            // A static relative date: a live timer would re-render every row each second.
            summary += AttributedString(" · \(date.formatted(.relative(presentation: .named)))")
        }
        return summary
    }

    // MARK: - Selection

    private func candidates(_ environmentID: String) -> [AgentSessionProjectCandidate] {
        scans[environmentID]?.candidates ?? []
    }

    private var allSelected: Bool {
        let all = environments.flatMap { environment in candidates(environment.id).map { (environment.id, $0.path) } }
        return !all.isEmpty && all.allSatisfy { isSelected($0.1, environmentID: $0.0) }
    }

    /// Selected projects not yet fully imported, which is what Retry re-runs.
    private var pendingCount: Int {
        environments.reduce(0) { count, environment in
            count + candidates(environment.id).filter {
                isSelected($0.path, environmentID: environment.id)
                    && !completedImports.contains(importKey(environment.id, $0.path))
            }.count
        }
    }

    private func isSelected(_ path: String, environmentID: String) -> Bool {
        selectedPaths[environmentID]?.contains(path) == true
    }

    private func selectionState(_ rows: [AgentSessionProjectCandidate], environmentID: String) -> AgentSetupCheckmark.State {
        let count = rows.filter { isSelected($0.path, environmentID: environmentID) }.count
        return count == 0 ? .off : count == rows.count ? .on : .mixed
    }

    private func toggle(_ path: String, environmentID: String, selected: Bool) {
        if selected { selectedPaths[environmentID, default: []].insert(path) }
        else { selectedPaths[environmentID]?.remove(path) }
    }

    private func importKey(_ environmentID: String, _ path: String) -> String {
        environmentID + "\u{0}" + path
    }

    // MARK: - Work

    @MainActor private func refreshProviders(only environmentID: String? = nil) async {
        guard let service = model.client as? any FeatureAgentSetupTerminalProviding else { return }
        let targets = environments.filter { environmentID == nil || $0.id == environmentID }
        for environment in targets {
            providerErrors[environment.id] = nil
            loadingProviders.insert(environment.id)
            do {
                providers[environment.id] = try await service.refreshSetupProviders(
                    environmentID: environment.id,
                    refreshModels: false
                )
            }
            catch { if !Task.isCancelled { providerErrors[environment.id] = error.localizedDescription } }
            loadingProviders.remove(environment.id)
        }
    }

    @MainActor private func openTerminal(environment: FeatureEnvironment, providerID: String, title: String) async {
        guard !openingTerminal, let service = model.client as? any FeatureAgentSetupTerminalProviding else { return }
        openingTerminal = true
        defer { openingTerminal = false }
        do {
            let session = try await service.makeAgentSetupTerminal(environmentID: environment.id, providerInstanceID: providerID)
            guard path.last == .agents else { await session.close(); return }
            setupTerminal = TerminalPresentation(session: session, title: title, machineName: environment.name)
        } catch { providerErrors[environment.id] = error.localizedDescription }
    }

    @MainActor private func scan(only: String? = nil) async {
        guard let importer else { return }
        let request = UUID(); generation = request
        let targets = environments.filter { only == nil || $0.id == only }
        scanning = Set(targets.map(\.id))
        for environment in targets {
            do {
                let result = try await importer.scanAgentSessions(environmentID: environment.id)
                guard !Task.isCancelled, generation == request else { return }
                scans[environment.id] = result
                scanErrors[environment.id] = nil
                if selectedPaths[environment.id] == nil {
                    selectedPaths[environment.id] = Set(result.candidates.filter { $0.selectedByDefault() }.map(\.path))
                } else {
                    selectedPaths[environment.id]?.formIntersection(result.candidates.map(\.path))
                }
            } catch {
                guard !Task.isCancelled, generation == request else { return }
                scanErrors[environment.id] = error.localizedDescription
            }
            scanning.remove(environment.id)
        }
    }

    @MainActor private func importSelected() async {
        guard !importing, let importer else { return }
        let request = generation
        let queue = environments.flatMap { environment in
            candidates(environment.id)
                .filter { isSelected($0.path, environmentID: environment.id) && !completedImports.contains(importKey(environment.id, $0.path)) }
                .map { (environment.id, $0) }
        }
        for (environmentID, candidate) in queue { importStatuses[importKey(environmentID, candidate.path)] = .waiting }
        importProgress = (0, queue.count)
        importSummary = nil
        defer { importProgress = nil }
        var summary = AgentImportSummary()
        for (environmentID, candidate) in queue {
            guard generation == request, !Task.isCancelled else { return }
            let key = importKey(environmentID, candidate.path)
            let projectID = attemptedProjects[key] ?? UUID().uuidString
            attemptedProjects[key] = projectID
            importStatuses[key] = .importing
            do {
                let result = try await importer.importAgentSessions(environmentID: environmentID, candidate: candidate, proposedProjectID: projectID)
                guard generation == request, !Task.isCancelled else { return }
                summary.imported += result.importedCount
                summary.skipped += result.skippedCount
                if result.skippedCount == 0 {
                    completedImports.insert(key)
                    importStatuses[key] = .imported(result.importedCount)
                } else {
                    importStatuses[key] = .incomplete(imported: result.importedCount, skipped: result.skippedCount)
                }
            } catch {
                guard generation == request, !Task.isCancelled else { return }
                summary.failedProjects += 1
                importStatuses[key] = .failed
            }
            importProgress?.done += 1
        }
        if summary.isComplete {
            PlatformHapticEngine.shared.play(.success)
            dismiss()
        } else {
            PlatformHapticEngine.shared.play(.warning)
            importSummary = summary
        }
    }
}

// MARK: - Pages and rows

enum AgentSetupPage: Hashable {
    case agents
    case projects
    case addComputer
}

private extension View {
    /// Shared chrome for the setup pages: the "Step N of 3" subtitle, which is
    /// a real navigation subtitle on iOS 26 and a principal title stack before.
    @ViewBuilder
    func agentSetupPageChrome(step: Int) -> some View {
        let page = listStyle(.insetGrouped)
            .t3GroupedListBackground()
            .navigationTitle("Set Up T3 Code")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
        if #available(iOS 26, *) {
            page.navigationSubtitle("Step \(step) of 3")
        } else {
            page.toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text("Set Up T3 Code").font(T3Typography.navigationTitle)
                        Text("Step \(step) of 3").font(.caption).foregroundStyle(T3Colors.textTertiary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

private struct AgentSetupHeader: View {
    let systemImage: String?
    let title: String
    let message: String

    var body: some View {
        Section {
            VStack(spacing: 8) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.largeTitle)
                        .foregroundStyle(T3Colors.accent)
                        .padding(.bottom, 4)
                }
                Text(title)
                    .font(.title2.bold())
                    .foregroundStyle(T3Colors.textPrimary)
                Text(message)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
        }
        .listRowBackground(Color.clear)
    }
}

private struct AgentSetupCheckmark: View {
    enum State { case on, off, mixed }
    let state: State

    var body: some View {
        Image(systemName: state == .on ? "checkmark.circle.fill" : state == .mixed ? "minus.circle.fill" : "circle")
            .font(.title3)
            .foregroundStyle(state == .off ? T3Colors.textTertiary : T3Colors.accent)
            .accessibilityHidden(true)
    }
}

private struct AgentSetupErrorRow: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.danger)
            Spacer(minLength: 8)
            Button("Retry", action: retry)
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .tint(T3Colors.accent)
        }
    }
}

/// A static stand-in row while a computer's providers load.
private struct AgentSetupPlaceholderRow: View {
    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(T3Colors.subtleStrong)
                .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text("Claude Code")
                Text("Checking").font(T3Typography.supporting)
            }
        }
        .redacted(reason: .placeholder)
        .accessibilityLabel("Loading agents")
    }
}

private struct AgentImportStatusIcon: View {
    let status: AgentImportStatus?
    let isSelected: Bool

    var body: some View {
        Group {
            switch status {
            case .importing:
                ProgressView()
            case .imported:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(T3Colors.success)
            case .incomplete, .failed:
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(T3Colors.danger)
            case .waiting, nil:
                AgentSetupCheckmark(state: isSelected ? .on : .off)
            }
        }
        .font(.title3)
        .frame(width: 24)
    }
}

enum AgentImportStatus: Equatable {
    case waiting
    case importing
    case imported(Int)
    case incomplete(imported: Int, skipped: Int)
    case failed

    var text: String? {
        switch self {
        case .waiting: "Waiting"
        case .importing: "Importing…"
        case let .imported(count): count == 1 ? "1 conversation imported" : "\(count) conversations imported"
        case let .incomplete(_, skipped): skipped == 1 ? "1 conversation couldn’t be imported" : "\(skipped) conversations couldn’t be imported"
        case .failed: "Couldn’t import"
        }
    }

    var tone: AgentSetupTone {
        switch self {
        case .waiting, .importing, .imported: .tertiary
        case .incomplete, .failed: .danger
        }
    }
}

/// What an import left behind, shown as the banner at the top of Projects.
struct AgentImportSummary: Equatable {
    var imported = 0
    var skipped = 0
    var failedProjects = 0

    var isComplete: Bool { skipped == 0 && failedProjects == 0 }

    var title: String {
        failedProjects > 0
            ? (failedProjects == 1 ? "1 project couldn’t be imported" : "\(failedProjects) projects couldn’t be imported")
            : "Some conversations couldn’t be imported"
    }

    var message: String {
        "Imported \(imported) conversations. \(skipped) conversations and \(failedProjects) projects could not be imported. Retry, or continue without the rest."
    }
}

enum AgentSetupTone: Equatable {
    case success
    case warning
    case danger
    case tertiary

    var color: Color {
        switch self {
        case .success: T3Colors.success
        case .warning: T3Colors.warning
        case .danger: T3Colors.danger
        case .tertiary: T3Colors.textTertiary
        }
    }
}

/// A provider's setup state in words, with the action that fixes it.
struct AgentSetupProviderState: Equatable {
    enum Action: Equatable {
        case install
        case signIn

        var title: String {
            self == .install ? "Install" : "Sign In"
        }
    }

    let label: String
    let tone: AgentSetupTone
    let action: Action?

    init(_ provider: ServerProviderSnapshot) {
        self.init(
            enabled: provider.enabled,
            installed: provider.installed,
            status: provider.status,
            authStatus: provider.auth.status
        )
    }

    init(enabled: Bool, installed: Bool, status: String, authStatus: String) {
        if !enabled {
            (label, tone, action) = ("Disabled", .tertiary, nil)
        } else if !installed {
            (label, tone, action) = ("Not installed", .warning, .install)
        } else if authStatus == "unauthenticated" {
            (label, tone, action) = ("Signed out", .warning, .signIn)
        } else {
            switch status {
            case "ready": (label, tone, action) = ("Ready", .success, nil)
            case "warning": (label, tone, action) = ("Needs attention", .warning, nil)
            case "error": (label, tone, action) = ("Error", .danger, nil)
            case "disabled": (label, tone, action) = ("Disabled", .tertiary, nil)
            default: (label, tone, action) = (status.capitalized, .tertiary, nil)
            }
        }
    }

    /// The short provider name for a scanned project's source list.
    static func sourceName(_ driver: String) -> String {
        switch driver {
        case "codex": "Codex"
        case "claudeAgent", "claude", "claudeCode": "Claude"
        default: driver.capitalized
        }
    }
}

private extension ServerProviderSnapshot {
    var isSetupAgent: Bool { driver == "codex" || driver == "claudeAgent" }
}

private extension FeatureEnvironment {
    var isUnreachable: Bool { connectionState == .disconnected }
}
