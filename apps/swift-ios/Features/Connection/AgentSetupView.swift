import SwiftUI

/// Optional setup after pairing, also reachable from Settings on existing installations.
struct AgentSetupView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    var onFinished: (() -> Void)?
    @State private var step = 0
    @State private var selectedComputers = Set<String>()
    @State private var scans: [String: AgentSessionScanResult] = [:]
    @State private var scanErrors: [String: String] = [:]
    @State private var scanning = Set<String>()
    @State private var selectedPaths: [String: Set<String>] = [:]
    @State private var attemptedProjects: [String: String] = [:]
    @State private var completedImports = Set<String>()
    @State private var generation = UUID()
    @State private var importing = false
    @State private var importSummary: String?
    @State private var showingConnection = false
    private struct TerminalPresentation: Identifiable {
        let id = UUID()
        let session: any FeatureAgentSetupTerminal
    }
    @State private var setupTerminal: TerminalPresentation?
    @State private var providers: [String: [ServerProviderSnapshot]] = [:]
    @State private var providerError: String?
    @State private var openingTerminal = false
    private let stages = ["Computers", "Agents", "Projects"]
    private var importer: (any FeatureAgentSessionImporting)? { model.client as? any FeatureAgentSessionImporting }
    private var environments: [FeatureEnvironment] { model.snapshot.environments.filter { selectedComputers.contains($0.id) } }
    private var selectedCount: Int {
        environments.reduce(0) { count, environment in
            count + (scans[environment.id]?.candidates ?? []).filter { selectedPaths[environment.id]?.contains($0.path) == true }.count
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    progress
                    switch step {
                    case 0: computers
                    case 1: agents
                    default: projects
                    }
                }.padding(.horizontal, 18).padding(.vertical, 18)
            }
            .background(T3Colors.background)
            .navigationTitle("Set up T3 Code")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Skip setup") { finish() }.disabled(importing)
                }
            }
            .safeAreaInset(edge: .bottom) { footer }
        }
        .interactiveDismissDisabled(importing)
        .onAppear {
            if selectedComputers.isEmpty { selectedComputers = Set(model.snapshot.environments.map(\.id)) }
        }
        .task(id: step) { if step == 2 { await scan() }; if step == 1 { await refreshProviders() } }
        .onDisappear { generation = UUID() }
        .sheet(item: $setupTerminal, onDismiss: { Task { await refreshProviders() } }) { presentation in
            AgentSetupTerminalView(session: presentation.session)
        }
        .sheet(isPresented: $showingConnection) {
            ConnectionOnboardingView(model: model, onConnected: {
                showingConnection = false
                selectedComputers.formUnion(model.snapshot.environments.map(\.id))
            }, onCancel: { showingConnection = false })
        }
    }

    private var progress: some View {
        HStack(spacing: 6) {
            ForEach(Array(stages.enumerated()), id: \.offset) { index, title in
                Button { step = index } label: {
                    VStack(spacing: 6) {
                        Image(systemName: index < step ? "checkmark.circle.fill" : "\(index + 1).circle.fill")
                        Text(title).font(T3Typography.supportingStrong).lineLimit(1).minimumScaleFactor(0.8)
                    }.frame(maxWidth: .infinity).padding(.vertical, 10)
                        .foregroundStyle(index == step ? T3Colors.accent : T3Colors.textSecondary)
                        .background(index == step ? T3Colors.accent.opacity(0.09) : Color.clear, in: RoundedRectangle(cornerRadius: 12))
                }.buttonStyle(.plain).disabled(index >= step || importing).accessibilityLabel("\(title), step \(index + 1)")
            }
        }
    }

    private var computers: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connect your computers").font(.title2.weight(.semibold))
            Text("Choose where your agents and code live. You can set up several computers together.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
            ForEach(model.snapshot.environments) { environment in
                Toggle(isOn: Binding(get: { selectedComputers.contains(environment.id) }, set: { selected in
                    if selected { selectedComputers.insert(environment.id) } else { selectedComputers.remove(environment.id) }
                })) {
                    Label { VStack(alignment: .leading, spacing: 3) {
                        Text(environment.name).font(T3Typography.supportingStrong)
                        Text(environment.connectionDetail ?? environment.endpoint).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).lineLimit(2)
                    } } icon: { Image(systemName: environment.machineSymbol) }
                }.frame(minHeight: T3Metrics.minimumTapTarget)
            }
            Button { showingConnection = true } label: { Label("Add a computer", systemImage: "plus.circle") }
                .frame(minHeight: T3Metrics.minimumTapTarget)
        }
    }

    private var agents: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Your agents").font(.title2.weight(.semibold))
            Text("Review the provider accounts on each computer, then choose which projects to import.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
            if let providerError { Text(providerError).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary) }
            if let settings = model.client as? any FeatureServerSettingsManaging {
                ForEach(environments) { environment in
                    Label(environment.name, systemImage: environment.machineSymbol).font(T3Typography.supportingStrong)
                    ForEach((providers[environment.id] ?? []).filter { $0.driver == "codex" || $0.driver == "claudeAgent" }) { provider in
                        HStack(spacing: 12) {
                            ProviderIcon(driver: provider.driver, providerID: provider.instanceId, fallbackName: provider.driver, size: 22)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(provider.displayName ?? (provider.driver == "claudeAgent" ? "Claude Code" : "Codex")).font(T3Typography.supportingStrong)
                                Text(provider.enabled ? provider.status : "Disabled").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                            }
                            Spacer()
                            if provider.enabled && (!provider.installed || provider.auth.status == "unauthenticated") {
                                Button(provider.installed ? "Sign in" : "Install") { Task { await openTerminal(environmentID: environment.id, providerID: provider.instanceId) } }.disabled(openingTerminal)
                            } else if provider.enabled && provider.status == "ready" {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(T3Colors.accent).accessibilityLabel("Ready")
                            }
                        }.padding(.vertical, 9)
                    }
                    NavigationLink {
                        SettingsAgentsView(serverSettings: settings, environmentID: environment.id, preferences: nil, environments: [environment])
                    } label: {
                        HStack {
                            Label(environment.name, systemImage: environment.machineSymbol)
                            Spacer()
                            Text("Configure").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                            Image(systemName: "chevron.right").font(.caption)
                        }.padding(.vertical, 12)
                    }.buttonStyle(.plain)
                }
            }
        }
    }

    private var projects: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Choose your projects").font(.title2.weight(.semibold))
            Text("Import Claude Code and Codex conversations from the last 30 days. Imported history starts in Settled, ready to resume.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
            HStack {
                Text("\(selectedCount) selected").font(T3Typography.supporting)
                Spacer()
                Button("All") { for environment in environments { selectedPaths[environment.id] = Set((scans[environment.id]?.candidates ?? []).map(\.path)) } }
                Button("None") { selectedPaths = [:] }
            }.disabled(importing)
            ForEach(environments) { environment in
                VStack(alignment: .leading, spacing: 12) {
                    Label(environment.name, systemImage: environment.machineSymbol).font(T3Typography.supportingStrong)
                    if scanning.contains(environment.id) { ProgressView("Looking for projects…") }
                    if let error = scanErrors[environment.id] {
                        Text(error).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                        Button("Retry") { Task { await scan(only: environment.id) } }.disabled(importing || !scanning.isEmpty)
                    }
                    if let result = scans[environment.id] {
                        if result.truncated == true { Text("Scan limit reached. Some projects or conversations may be missing.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary) }
                        if result.candidates.isEmpty { Text("No Claude Code or Codex projects found.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary) }
                        candidateList(result.candidates, environmentID: environment.id)
                    }
                }.padding(.vertical, 6)
            }
            if let importSummary { Text(importSummary).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).accessibilityAddTraits(.updatesFrequently) }
        }
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
                    HStack {
                        Text(first.git?.repository ?? first.title).font(T3Typography.supportingStrong)
                        Spacer()
                        Button(selectedRows(rows, environmentID: environmentID) ? "Deselect" : "Select all") {
                            let select = !selectedRows(rows, environmentID: environmentID)
                            for row in rows { toggle(row.path, environmentID: environmentID, selected: select) }
                        }.font(T3Typography.supporting)
                    }
                }
            }
        }
        let folders = candidates.filter { $0.reportsGitIdentity && $0.git == nil }
        if !folders.isEmpty {
            DisclosureGroup("Other folders (\(folders.count))") {
                ForEach(folders) { candidateRow($0, environmentID: environmentID) }
            }.font(T3Typography.supporting)
        }
    }

    private func candidateRow(_ candidate: AgentSessionProjectCandidate, environmentID: String) -> some View {
        Toggle(isOn: Binding(get: { selectedPaths[environmentID]?.contains(candidate.path) == true }, set: { toggle(candidate.path, environmentID: environmentID, selected: $0) })) {
            VStack(alignment: .leading, spacing: 5) {
                Text(candidate.git?.repository ?? candidate.title).font(T3Typography.supportingStrong).foregroundStyle(T3Colors.textPrimary)
                Text(candidate.path).font(.caption.monospaced()).foregroundStyle(T3Colors.textSecondary).lineLimit(2)
                HStack(spacing: 7) {
                    ForEach(candidate.sources, id: \.self) { driver in ProviderIcon(driver: driver, providerID: driver, fallbackName: driver, size: 13) }
                    Text("\(candidate.threadCount) conversations").font(.caption)
                    if let activity = candidate.lastActiveAt, let date = AgentSessionProjectCandidate.activityDate(activity) { Text(date, style: .relative).font(.caption) }
                }.foregroundStyle(T3Colors.textTertiary)
            }.padding(.vertical, 7)
        }.disabled(importing).frame(minHeight: T3Metrics.minimumTapTarget)
    }

    private var footer: some View {
        HStack {
            if step > 0 { Button("Back") { step -= 1 }.disabled(importing) }
            Spacer()
            if step == 2 {
                Button(importSummary == nil ? "Skip import" : "Continue") { finish() }.disabled(importing)
                Button(importing ? "Importing…" : "Import \(selectedCount)") { Task { await importSelected() } }
                    .buttonStyle(.borderedProminent).disabled(importing || selectedCount == 0 || !scanning.isEmpty)
            } else {
                Button("Continue") { step += 1 }.buttonStyle(.borderedProminent).disabled(selectedComputers.isEmpty)
            }
        }.padding(16).background(T3Colors.background)
    }

    private func selectedRows(_ rows: [AgentSessionProjectCandidate], environmentID: String) -> Bool { rows.allSatisfy { selectedPaths[environmentID]?.contains($0.path) == true } }
    private func toggle(_ path: String, environmentID: String, selected: Bool) {
        if selected { selectedPaths[environmentID, default: []].insert(path) }
        else { selectedPaths[environmentID]?.remove(path) }
    }
    @MainActor private func refreshProviders() async {
        guard let service = model.client as? any FeatureAgentSetupTerminalProviding else { return }
        providerError = nil
        for environment in environments {
            do { providers[environment.id] = try await service.refreshSetupProviders(environmentID: environment.id) }
            catch { if !Task.isCancelled { providerError = error.localizedDescription } }
        }
    }
    @MainActor private func openTerminal(environmentID: String, providerID: String) async {
        guard !openingTerminal, let service = model.client as? any FeatureAgentSetupTerminalProviding else { return }
        openingTerminal = true
        defer { openingTerminal = false }
        do {
            let session = try await service.makeAgentSetupTerminal(environmentID: environmentID, providerInstanceID: providerID)
            guard step == 1 else { await session.close(); return }
            setupTerminal = TerminalPresentation(session: session)
        } catch { providerError = error.localizedDescription }
    }

    private func finish() { onFinished?(); dismiss() }

    @MainActor private func scan(only: String? = nil) async {
        guard let importer else { importSummary = "Project import is unavailable in this client."; return }
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
        importing = true; importSummary = nil
        defer { importing = false }
        let request = generation
        var count = 0; var skipped = 0; var failed = 0
        for environment in environments {
            for candidate in scans[environment.id]?.candidates ?? [] where selectedPaths[environment.id]?.contains(candidate.path) == true {
                guard generation == request, !Task.isCancelled else { return }
                let key = environment.id + "\u{0}" + candidate.path
                if completedImports.contains(key) { continue }
                let projectID = attemptedProjects[key] ?? UUID().uuidString
                attemptedProjects[key] = projectID
                do {
                    let result = try await importer.importAgentSessions(environmentID: environment.id, candidate: candidate, proposedProjectID: projectID)
                    guard generation == request, !Task.isCancelled else { return }
                    count += result.importedCount; skipped += result.skippedCount
                    if result.skippedCount == 0 { completedImports.insert(key) }
                } catch {
                    guard generation == request, !Task.isCancelled else { return }
                    failed += 1
                }
            }
        }
        if skipped == 0 && failed == 0 { finish() }
        else { importSummary = "Imported \(count) conversations. \(skipped) conversations and \(failed) projects could not be imported. Retry, or continue without the rest." }
    }
}
