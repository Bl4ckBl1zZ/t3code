import SwiftUI

// Ported from apps/mobile/src/features/settings/SettingsAutomationsRouteScreen.tsx
// and automations/AutomationRow.tsx. Laid out like Alarms: tap a row to edit
// it, toggle it inline, swipe for Run Now and Delete.

/// Which automation the editor is open on. `task == nil` is a new automation on
/// that environment.
struct AutomationEditorTarget: Identifiable, Equatable {
    let environmentID: String
    let task: FeatureScheduledTask?

    var id: String { "\(environmentID)|\(task?.id ?? "new")" }
}

public struct SettingsAutomationsView: View {
    private let model: FeatureRootModel
    private let manager: any FeatureScheduledTaskManaging
    private let onAddServer: (() -> Void)?

    @State private var tasksByEnvironment: [String: [FeatureScheduledTask]] = [:]
    @State private var loadFailures: [String: String] = [:]
    @State private var busyTaskIDs: Set<String> = []
    @State private var editorTarget: AutomationEditorTarget?
    @State private var deletionTarget: FeatureScheduledTask?
    @State private var actionFailure: String?
    @State private var toggleFailure: String?
    @State private var hasLoaded = false
    /// Sampled per load rather than per frame: the next-run labels are relative,
    /// and a live clock would rebuild every row every second for no new
    /// information — which is also what React Native does with `Date.now()`.
    @State private var now = Date.now

    public init(
        model: FeatureRootModel,
        manager: any FeatureScheduledTaskManaging,
        onAddServer: (() -> Void)? = nil
    ) {
        self.model = model
        self.manager = manager
        self.onAddServer = onAddServer
    }

    private var environments: [FeatureEnvironment] {
        AutomationEnvironmentChoice.ordered(model.snapshot.environments)
    }

    private var hasAnyAutomation: Bool {
        tasksByEnvironment.values.contains { !$0.isEmpty }
    }

    public var body: some View {
        content
            .navigationTitle("Automations")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !environments.isEmpty {
                    ToolbarItem(placement: .primaryAction) { newAutomationControl(prominent: false) }
                }
            }
            .task { await reload() }
            .sheet(item: $editorTarget) { target in
                AutomationEditSheet(
                    model: model,
                    manager: manager,
                    environmentID: target.environmentID,
                    task: target.task,
                    onSaved: {
                        editorTarget = nil
                        Task { await reload() }
                    },
                    onCancel: { editorTarget = nil }
                )
            }
            .alert(
                "Couldn't Run Automation",
                isPresented: Binding(get: { actionFailure != nil }, set: { if !$0 { actionFailure = nil } })
            ) {
                Button("OK") { actionFailure = nil }
            } message: {
                Text(actionFailure ?? "")
            }
    }

    @ViewBuilder
    private var content: some View {
        if environments.isEmpty {
            ContentUnavailableView {
                Label("No Servers", systemImage: "calendar.badge.clock")
            } description: {
                Text("Connect a server to schedule automations on it.")
            } actions: {
                if let onAddServer {
                    Button("Connect a Server", action: onAddServer)
                        .t3ProminentButtonStyle()
                }
            }
            .background(T3Colors.background)
        } else if hasLoaded, !hasAnyAutomation, loadFailures.isEmpty {
            ContentUnavailableView {
                Label("No Automations", systemImage: "calendar.badge.clock")
            } description: {
                Text(environments.count == 1
                    ? "Schedule a prompt to run on \(environments[0].name) and post the result into a thread."
                    : "Schedule a prompt to run on one of your servers and post the result into a thread.")
            } actions: {
                newAutomationControl(prominent: true)
            }
            .background(T3Colors.background)
            .refreshable { await reload() }
        } else {
            SettingsForm {
                if !hasLoaded {
                    Section { SettingsPlaceholderRows(count: 3) }
                } else if environments.count == 1, let environment = environments.first {
                    singleServerSections(environment)
                } else {
                    ForEach(environments) { environment in
                        serverSection(environment)
                    }
                }
            }
            .refreshable { await reload() }
        }
    }

    /// With one server, rows split into Active and Paused, like Alarms.
    @ViewBuilder
    private func singleServerSections(_ environment: FeatureEnvironment) -> some View {
        if let failure = loadFailures[environment.id] {
            failureSection(environment, failure: failure)
        } else {
            let tasks = tasksByEnvironment[environment.id] ?? []
            let active = tasks.filter(\.enabled)
            let paused = tasks.filter { !$0.enabled }
            if !active.isEmpty {
                Section {
                    ForEach(active) { row($0, environmentID: environment.id) }
                } header: {
                    Text("Active")
                } footer: {
                    if paused.isEmpty, let toggleFailure { Text(toggleFailure).foregroundStyle(T3Colors.danger) }
                }
            }
            if !paused.isEmpty {
                Section {
                    ForEach(paused) { row($0, environmentID: environment.id) }
                } header: {
                    Text("Paused")
                } footer: {
                    if let toggleFailure { Text(toggleFailure).foregroundStyle(T3Colors.danger) }
                }
            }
        }
    }

    /// With several servers, one section per server; active rows lead.
    @ViewBuilder
    private func serverSection(_ environment: FeatureEnvironment) -> some View {
        if let failure = loadFailures[environment.id] {
            failureSection(environment, failure: failure)
        } else {
            let tasks = tasksByEnvironment[environment.id] ?? []
            Section {
                if tasks.isEmpty {
                    Text("None scheduled").foregroundStyle(T3Colors.textSecondary)
                }
                ForEach(tasks.filter(\.enabled) + tasks.filter { !$0.enabled }) {
                    row($0, environmentID: environment.id)
                }
            } header: {
                Text(environment.name)
            } footer: {
                if environment.id == environments.last?.id, let toggleFailure {
                    Text(toggleFailure).foregroundStyle(T3Colors.danger)
                }
            }
        }
    }

    private func failureSection(_ environment: FeatureEnvironment, failure: String) -> some View {
        Section {
            HStack(spacing: 12) {
                Label("Couldn't load.", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(T3Colors.warning)
                Spacer(minLength: 8)
                Button("Retry") { Task { await reload() } }
                    .buttonStyle(.bordered)
                    .tint(T3Colors.accent)
            }
        } header: {
            Text(environment.name)
        } footer: {
            Text(failure)
        }
    }

    private func row(_ task: FeatureScheduledTask, environmentID: String) -> some View {
        AutomationRow(
            task: task,
            now: now,
            isBusy: busyTaskIDs.contains(task.id),
            onEdit: { editorTarget = AutomationEditorTarget(environmentID: environmentID, task: task) },
            onSetEnabled: { enabled in
                Task { await setEnabled(task, environmentID: environmentID, enabled: enabled) }
            }
        )
        .swipeActions(edge: .leading) {
            Button("Run Now", systemImage: "play.fill") {
                Task { await run(task, environmentID: environmentID) }
            }
            .tint(T3Colors.accent)
            .disabled(task.isRunning || busyTaskIDs.contains(task.id))
        }
        .swipeActions(edge: .trailing) {
            Button("Delete", systemImage: "trash", role: .destructive) { deletionTarget = task }
        }
        .contextMenu {
            Button("Run Now", systemImage: "play") {
                Task { await run(task, environmentID: environmentID) }
            }
            .disabled(task.isRunning)
            Button("Delete Automation", systemImage: "trash", role: .destructive) { deletionTarget = task }
        }
        .confirmationDialog(
            "Delete automation?",
            isPresented: Binding(
                get: { deletionTarget?.id == task.id },
                set: { if !$0 { deletionTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete Automation", role: .destructive) {
                Task { await delete(task, environmentID: environmentID) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("“\(task.title)” and its schedule will be removed. Threads it already created stay.")
        }
    }

    /// New Automation: straight to the editor with one server, a menu of
    /// servers with several, so any of them can be the one it runs on.
    @ViewBuilder
    private func newAutomationControl(prominent: Bool) -> some View {
        if environments.count > 1 {
            Menu {
                Section("New Automation On") {
                    ForEach(environments) { environment in
                        Button(environment.name, systemImage: environment.machineSymbol) {
                            openNewAutomation(on: environment.id)
                        }
                    }
                }
            } label: {
                if prominent {
                    Text("New Automation")
                } else {
                    Label("New Automation", systemImage: "plus")
                }
            }
            .modifier(ProminentIf(isOn: prominent))
        } else if prominent {
            Button("New Automation") { openNewAutomation(on: nil) }
                .t3ProminentButtonStyle()
        } else {
            Button("New Automation", systemImage: "plus") { openNewAutomation(on: nil) }
        }
    }

    private func openNewAutomation(on requested: String?) {
        guard let environmentID = AutomationEnvironmentChoice.initialEnvironmentID(
            requested: requested,
            environments: model.snapshot.environments
        ) else { return }
        editorTarget = AutomationEditorTarget(environmentID: environmentID, task: nil)
    }

    // MARK: - Requests

    @MainActor
    private func reload() async {
        now = .now
        for environment in environments {
            do {
                tasksByEnvironment[environment.id] = try await manager.loadScheduledTasks(
                    environmentID: environment.id
                )
                loadFailures[environment.id] = nil
            } catch {
                // One unreachable environment must not blank the others, so the
                // failure is recorded against its own section.
                loadFailures[environment.id] = error.localizedDescription
            }
        }
        hasLoaded = true
    }

    @MainActor
    private func run(_ task: FeatureScheduledTask, environmentID: String) async {
        do {
            try await mutate(task) {
                try await manager.runScheduledTaskNow(environmentID: environmentID, id: task.id)
            }
            PlatformHapticEngine.shared.play(.success)
        } catch {
            PlatformHapticEngine.shared.play(.error)
            actionFailure = error.localizedDescription
        }
    }

    /// The switch reads the task, so a failed write leaves it where it was;
    /// the reason goes under the list rather than into an alert.
    @MainActor
    private func setEnabled(_ task: FeatureScheduledTask, environmentID: String, enabled: Bool) async {
        toggleFailure = nil
        do {
            try await mutate(task) {
                try await manager.setScheduledTaskEnabled(environmentID: environmentID, id: task.id, enabled: enabled)
            }
        } catch {
            PlatformHapticEngine.shared.play(.error)
            toggleFailure = "Couldn't \(enabled ? "resume" : "pause") “\(task.title)”. \(error.localizedDescription)"
        }
    }

    /// Replaces just the mutated task in place. Reloading the whole environment
    /// would reorder rows under the reader's finger when a toggle moves a task
    /// between the Active and Paused sections.
    @MainActor
    private func mutate(
        _ task: FeatureScheduledTask,
        _ operation: @MainActor () async throws -> FeatureScheduledTask
    ) async throws {
        guard !busyTaskIDs.contains(task.id) else { return }
        busyTaskIDs.insert(task.id)
        defer { busyTaskIDs.remove(task.id) }
        let updated = try await operation()
        now = .now
        for (environmentID, tasks) in tasksByEnvironment {
            guard let index = tasks.firstIndex(where: { $0.id == updated.id }) else { continue }
            tasksByEnvironment[environmentID]?[index] = updated
        }
    }

    @MainActor
    private func delete(_ task: FeatureScheduledTask, environmentID: String) async {
        deletionTarget = nil
        do {
            try await manager.deleteScheduledTask(environmentID: environmentID, id: task.id)
            tasksByEnvironment[environmentID]?.removeAll { $0.id == task.id }
        } catch {
            PlatformHapticEngine.shared.play(.error)
            actionFailure = error.localizedDescription
        }
    }
}

private struct ProminentIf: ViewModifier {
    let isOn: Bool

    func body(content: Content) -> some View {
        if isOn { content.t3ProminentButtonStyle() } else { content }
    }
}

/// One scheduled task: title, schedule subtitle and an inline enable switch.
/// The row body opens the editor; the switch is its own hit target.
private struct AutomationRow: View {
    let task: FeatureScheduledTask
    let now: Date
    let isBusy: Bool
    let onEdit: () -> Void
    let onSetEnabled: (Bool) -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onEdit) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.title)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    Text(ScheduledTaskLabels.subtitle(for: task.summary, now: now))
                        .font(T3Typography.supporting)
                        .foregroundStyle(subtitleColor)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Edit this automation")

            if isBusy {
                ProgressView()
            } else {
                Toggle(
                    task.enabled ? "Pause \(task.title)" : "Resume \(task.title)",
                    isOn: Binding(get: { task.enabled }, set: onSetEnabled)
                )
                .labelsHidden()
            }
        }
    }

    private var subtitleColor: Color {
        switch ScheduledTaskLabels.statusTone(task.lastRunStatus) {
        case .running: T3Colors.statusRunning
        case .danger: T3Colors.danger
        case .dormant, .success: T3Colors.textSecondary
        }
    }
}
