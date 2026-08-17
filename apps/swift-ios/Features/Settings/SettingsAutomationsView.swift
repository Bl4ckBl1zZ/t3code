import SwiftUI

// Ported from apps/mobile/src/features/settings/SettingsAutomationsRouteScreen.tsx
// and automations/AutomationRow.tsx.

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

    @State private var tasksByEnvironment: [String: [FeatureScheduledTask]] = [:]
    @State private var loadFailures: [String: String] = [:]
    @State private var busyTaskIDs: Set<String> = []
    @State private var editorTarget: AutomationEditorTarget?
    @State private var deletionTarget: FeatureScheduledTask?
    @State private var deletionEnvironmentID: String?
    @State private var actionFailure: String?
    @State private var isLoading = true
    /// Sampled per load rather than per frame: the next-run labels are relative,
    /// and a live clock would rebuild every row every second for no new
    /// information — which is also what React Native does with `Date.now()`.
    @State private var now = Date.now

    public init(model: FeatureRootModel, manager: any FeatureScheduledTaskManaging) {
        self.model = model
        self.manager = manager
    }

    private var environments: [FeatureEnvironment] {
        model.snapshot.environments
    }

    private var showsEnvironmentLabels: Bool {
        environments.count > 1
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if environments.isEmpty {
                    emptyState
                } else {
                    ForEach(environments) { environment in
                        environmentAutomations(environment)
                    }

                    if let first = environments.first {
                        newAutomationButton(environmentID: first.id)
                    }

                    SettingsFootnote(
                        """
                        Automations run on their environment's schedule and post results into \
                        their bound thread. Touch and hold a row to delete it.
                        """
                    )
                }
            }
            .padding(.vertical, 18)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .navigationTitle("Automations")
        .navigationBarTitleDisplayMode(.inline)
        .overlay {
            if isLoading, tasksByEnvironment.isEmpty {
                ProgressView()
                    .accessibilityLabel("Loading automations")
            }
        }
        .task { await reload() }
        .refreshable { await reload() }
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
            "Delete automation?",
            isPresented: Binding(
                get: { deletionTarget != nil },
                set: { if !$0 { deletionTarget = nil } }
            ),
            presenting: deletionTarget
        ) { task in
            Button("Delete", role: .destructive) {
                Task { await delete(task) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { task in
            Text("“\(task.title)” and its schedule will be removed. Threads it already created stay.")
        }
        .alert(
            "Couldn’t update automation",
            isPresented: Binding(
                get: { actionFailure != nil },
                set: { if !$0 { actionFailure = nil } }
            )
        ) {
            Button("OK") { actionFailure = nil }
        } message: {
            Text(actionFailure ?? "Something went wrong.")
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No environments", systemImage: "calendar.badge.clock")
        } description: {
            Text("Connect an environment to schedule automations on it.")
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func environmentAutomations(_ environment: FeatureEnvironment) -> some View {
        let tasks = tasksByEnvironment[environment.id] ?? []

        if let failure = loadFailures[environment.id] {
            SettingsErrorBanner(
                message: "Could not load automations for \(environment.name). \(failure)"
            )
        } else if !tasks.isEmpty {
            if showsEnvironmentLabels {
                SettingsFieldLabel(environment.name)
            }

            // Active before paused, so the schedules that will actually fire are
            // never buried under ones that will not.
            automationSection(
                title: "Active",
                environmentID: environment.id,
                tasks: tasks.filter(\.enabled)
            )
            automationSection(
                title: "Paused",
                environmentID: environment.id,
                tasks: tasks.filter { !$0.enabled }
            )
        }
    }

    @ViewBuilder
    private func automationSection(
        title: String,
        environmentID: String,
        tasks: [FeatureScheduledTask]
    ) -> some View {
        if !tasks.isEmpty {
            SettingsSection(title: title) {
                VStack(spacing: 0) {
                    ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                        if index > 0 {
                            SettingsRowDivider(isInsetForIcon: false)
                        }
                        AutomationRow(
                            task: task,
                            now: now,
                            isBusy: busyTaskIDs.contains(task.id),
                            onEdit: {
                                editorTarget = AutomationEditorTarget(
                                    environmentID: environmentID,
                                    task: task
                                )
                            },
                            onRun: { Task { await run(task, environmentID: environmentID) } },
                            onSetEnabled: { enabled in
                                Task {
                                    await setEnabled(
                                        task,
                                        environmentID: environmentID,
                                        enabled: enabled
                                    )
                                }
                            },
                            onDelete: {
                                deletionEnvironmentID = environmentID
                                deletionTarget = task
                            }
                        )
                    }
                }
            }
        }
    }

    private func newAutomationButton(environmentID: String) -> some View {
        SettingsActionButton(
            title: "New Automation",
            systemImage: "plus",
            tone: .primary
        ) {
            editorTarget = AutomationEditorTarget(environmentID: environmentID, task: nil)
        }
        .padding(.horizontal, SettingsMetrics.cardInset)
    }

    // MARK: - Requests

    @MainActor
    private func reload() async {
        isLoading = true
        defer { isLoading = false }
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
    }

    @MainActor
    private func run(_ task: FeatureScheduledTask, environmentID: String) async {
        await mutate(task) {
            try await manager.runScheduledTaskNow(environmentID: environmentID, id: task.id)
        }
    }

    @MainActor
    private func setEnabled(
        _ task: FeatureScheduledTask,
        environmentID: String,
        enabled: Bool
    ) async {
        await mutate(task) {
            try await manager.setScheduledTaskEnabled(
                environmentID: environmentID,
                id: task.id,
                enabled: enabled
            )
        }
    }

    /// Replaces just the mutated task in place. Reloading the whole environment
    /// would reorder rows under the reader's finger when a toggle moves a task
    /// between the Active and Paused sections.
    @MainActor
    private func mutate(
        _ task: FeatureScheduledTask,
        _ operation: @MainActor () async throws -> FeatureScheduledTask
    ) async {
        guard !busyTaskIDs.contains(task.id) else { return }
        busyTaskIDs.insert(task.id)
        defer { busyTaskIDs.remove(task.id) }
        do {
            let updated = try await operation()
            now = .now
            for (environmentID, tasks) in tasksByEnvironment {
                guard let index = tasks.firstIndex(where: { $0.id == updated.id }) else { continue }
                tasksByEnvironment[environmentID]?[index] = updated
            }
        } catch {
            actionFailure = error.localizedDescription
        }
    }

    @MainActor
    private func delete(_ task: FeatureScheduledTask) async {
        guard let environmentID = deletionEnvironmentID else { return }
        deletionTarget = nil
        deletionEnvironmentID = nil
        do {
            try await manager.deleteScheduledTask(environmentID: environmentID, id: task.id)
            tasksByEnvironment[environmentID]?.removeAll { $0.id == task.id }
        } catch {
            actionFailure = error.localizedDescription
        }
    }
}

/// One scheduled task: status dot, title, schedule subtitle, and the inline
/// run-now and enable controls. The row body and the two controls are separate
/// hit targets so tapping "Run" cannot open the editor by accident.
private struct AutomationRow: View {
    let task: FeatureScheduledTask
    let now: Date
    let isBusy: Bool
    let onEdit: () -> Void
    let onRun: () -> Void
    let onSetEnabled: (Bool) -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                    Text(task.title)
                        .font(T3Typography.homeTitle)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                }
                Text(ScheduledTaskLabels.subtitle(for: task.summary, now: now))
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture(perform: onEdit)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Edit this automation")

            Button(action: onRun) {
                Text("Run")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.accent)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 30)
                    .background(T3Colors.subtle, in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            // A run already in flight has nothing useful to start.
            .disabled(isBusy || task.isRunning)
            .opacity(isBusy || task.isRunning ? 0.4 : 1)
            .accessibilityLabel("Run \(task.title) now")

            Toggle(
                task.enabled ? "Pause \(task.title)" : "Resume \(task.title)",
                isOn: Binding(get: { task.enabled }, set: onSetEnabled)
            )
            .labelsHidden()
            .tint(T3Colors.accent)
            .disabled(isBusy)
        }
        .padding(.horizontal, SettingsMetrics.rowPadding)
        .frame(minHeight: 62)
        .contextMenu {
            Button(role: .destructive, action: onDelete) {
                Label("Delete automation", systemImage: "trash")
            }
        }
    }

    private var statusColor: Color {
        switch ScheduledTaskLabels.statusTone(task.lastRunStatus) {
        case .dormant: T3Colors.textTertiary
        case .running: T3Colors.statusRunning
        case .success: T3Colors.success
        case .danger: T3Colors.danger
        }
    }
}
