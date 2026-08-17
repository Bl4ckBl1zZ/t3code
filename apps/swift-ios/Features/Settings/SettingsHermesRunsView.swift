import SwiftUI

// The native counterpart of the "Runs you did not start" section in
// apps/web/src/components/settings/HermesCronSettings.tsx.

/// Hermes runs nobody in T3 asked for: scheduled jobs firing, and prompts from
/// other Hermes clients on the same session. Each one already reached its
/// thread; this is the list that says so, and the way back into that thread.
public struct SettingsHermesRunsView: View {
    private let model: FeatureRootModel
    private let manager: any FeatureHermesInboxManaging
    private let store: HermesInboxStore
    private let onOpenThread: (String, String) -> Void

    @State private var showsDismissed = false
    /// Sampled per appearance rather than per frame: the timestamps are
    /// relative, and a live clock would rebuild every row every second for no
    /// new information.
    @State private var now = Date.now

    public init(
        model: FeatureRootModel,
        manager: any FeatureHermesInboxManaging,
        store: HermesInboxStore,
        onOpenThread: @escaping (String, String) -> Void
    ) {
        self.model = model
        self.manager = manager
        self.store = store
        self.onOpenThread = onOpenThread
    }

    private var environments: [FeatureEnvironment] {
        model.snapshot.environments
    }

    private var showsEnvironmentLabels: Bool {
        environments.count > 1
    }

    private var hasAnyVisibleRun: Bool {
        environments.contains { environment in
            !store.inbox(for: environment.id).visibleRuns(includingDismissed: showsDismissed).isEmpty
        }
    }

    private var totalDismissedCount: Int {
        environments.reduce(0) { $0 + store.inbox(for: $1.id).dismissedCount }
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if environments.isEmpty {
                    emptyEnvironmentsState
                } else {
                    ForEach(environments) { environment in
                        environmentRuns(environment)
                    }

                    if !hasAnyVisibleRun, !store.isLoading {
                        emptyInboxState
                    }

                    if let warning = HermesRunLabels.deadLetterWarning(
                        count: store.totalDeadLetterCount
                    ) {
                        SettingsErrorBanner(message: warning)
                    }

                    if totalDismissedCount > 0 || showsDismissed {
                        dismissedToggle
                    }

                    SettingsFootnote(
                        """
                        Hermes keeps running its schedule while T3 is closed. Runs it finished \
                        without T3 watching are listed here; open one to read it in its thread. \
                        Touch and hold a row to mark it unread or dismiss it.
                        """
                    )
                }
            }
            .padding(.vertical, 18)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .navigationTitle("Hermes Runs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Mark All Read", action: markAllRead)
                    .font(T3Typography.supportingStrong)
                    .disabled(store.totalUnreadCount == 0)
            }
        }
        .overlay {
            if store.isLoading, !hasAnyVisibleRun {
                ProgressView()
                    .accessibilityLabel("Loading Hermes runs")
            }
        }
        .onAppear { now = .now }
        .alert(
            "Couldn’t update run",
            isPresented: Binding(
                get: { store.actionFailure != nil },
                set: { if !$0 { store.actionFailure = nil } }
            )
        ) {
            Button("OK") { store.actionFailure = nil }
        } message: {
            Text(store.actionFailure ?? "Something went wrong.")
        }
    }

    private var emptyEnvironmentsState: some View {
        ContentUnavailableView {
            Label("No environments", systemImage: "clock.arrow.circlepath")
        } description: {
            Text("Connect an environment running Hermes to see its scheduled runs.")
        }
        .frame(maxWidth: .infinity)
    }

    private var emptyInboxState: some View {
        ContentUnavailableView {
            Label("Nothing has run on its own", systemImage: "moon.zzz")
        } description: {
            Text("Scheduled Hermes jobs and other Hermes clients show up here when they finish.")
        }
        .frame(maxWidth: .infinity)
    }

    private var dismissedToggle: some View {
        SettingsActionButton(
            title: showsDismissed
                ? "Hide Dismissed"
                : "Show \(totalDismissedCount) Dismissed",
            systemImage: showsDismissed ? "eye.slash" : "eye",
            tone: .secondary
        ) {
            showsDismissed.toggle()
        }
        .padding(.horizontal, SettingsMetrics.cardInset)
    }

    @ViewBuilder
    private func environmentRuns(_ environment: FeatureEnvironment) -> some View {
        let runs = store.inbox(for: environment.id).visibleRuns(includingDismissed: showsDismissed)

        if let failure = store.failures[environment.id] {
            SettingsErrorBanner(
                message: "Could not follow Hermes runs on \(environment.name). \(failure)"
            )
        } else if !runs.isEmpty {
            SettingsSection(title: showsEnvironmentLabels ? environment.name : "Recent") {
                VStack(spacing: 0) {
                    ForEach(Array(runs.enumerated()), id: \.element.id) { index, run in
                        if index > 0 {
                            SettingsRowDivider(isInsetForIcon: false)
                        }
                        HermesRunRow(
                            run: run,
                            now: now,
                            isBusy: store.isBusy(run.id),
                            onOpen: { open(run, environmentID: environment.id) },
                            onToggleRead: {
                                mark(
                                    [run.id],
                                    environmentID: environment.id,
                                    status: HermesRunLabels.readToggleTarget(run.status)
                                )
                            },
                            onToggleDismissed: {
                                mark(
                                    [run.id],
                                    environmentID: environment.id,
                                    status: HermesRunLabels.dismissToggleTarget(run.status)
                                )
                            }
                        )
                    }
                }
            }
        }
    }

    // MARK: - Actions

    /// Opening is also reading it: the reader is about to see the run in full,
    /// so leaving the row bold afterwards would be a lie.
    private func open(_ run: FeatureHermesRun, environmentID: String) {
        if run.isUnread {
            mark([run.id], environmentID: environmentID, status: .read)
        }
        guard let threadID = run.threadID else { return }
        onOpenThread(environmentID, threadID)
    }

    private func mark(
        _ ids: [String],
        environmentID: String,
        status: FeatureHermesRunStatus
    ) {
        Task {
            await store.mark(
                environmentID: environmentID,
                ids: ids,
                status: status,
                manager: manager
            )
        }
    }

    private func markAllRead() {
        for environment in environments {
            let ids = store.inbox(for: environment.id).unreadIDs
            guard !ids.isEmpty else { continue }
            mark(ids, environmentID: environment.id, status: .read)
        }
    }
}

/// One run: unread dot, title, the first part of what the agent said, and how
/// long ago it landed. The row body and the swipe actions are separate hit
/// targets so a deliberate dismiss cannot be mistaken for a tap.
private struct HermesRunRow: View {
    let run: FeatureHermesRun
    let now: Date
    let isBusy: Bool
    let onOpen: () -> Void
    let onToggleRead: () -> Void
    let onToggleDismissed: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 10) {
                Circle()
                    .fill(run.isUnread ? T3Colors.accent : .clear)
                    .frame(width: 7, height: 7)
                    .padding(.top, 6)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    Text(run.title)
                        .font(T3Typography.homeTitle)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Text(run.body)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 6) {
                        Text(HermesRunLabels.relativeTime(run.createdAt, now: now))
                        if run.threadID == nil {
                            Text("· no thread in T3")
                        }
                    }
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                }

                Spacer(minLength: 8)

                if run.threadID != nil {
                    Image(systemName: "chevron.right")
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textTertiary)
                        .padding(.top, 2)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, SettingsMetrics.rowPadding)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
        .opacity(isBusy ? 0.5 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(HermesRunLabels.accessibilityStatus(run.status)). \(run.title)")
        .accessibilityHint(run.threadID == nil ? "No thread to open" : "Opens the thread this run landed in")
        // Long press rather than swipe: this list is a LazyVStack, matching the
        // automations screen, and `swipeActions` only fires inside a `List`.
        .contextMenu {
            Button(HermesRunLabels.readToggleTitle(run.status), systemImage: "envelope", action: onToggleRead)
            Button(
                HermesRunLabels.dismissToggleTitle(run.status),
                systemImage: run.status == .dismissed ? "arrow.uturn.backward" : "xmark.bin",
                action: onToggleDismissed
            )
        }
    }
}
