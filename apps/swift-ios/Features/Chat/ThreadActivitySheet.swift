import SwiftUI

// What the activity pill opens: the agents this thread is running, the work it
// left in the background, and every parent, fork and transfer it is related to,
// with the merge-back / disconnect actions.
//
// Ports the sheet of apps/mobile/src/features/threads/ThreadRelationshipsBanner.tsx,
// with the background tasks folded in so the pill has one destination.
//
// All derivation lives in ThreadRelationshipRows.swift; this file is the view.

/// A subagent's identity orb, taking the pure layer's orb state.
///
/// `AgentOrb` (owned by the timeline work) has its own view-level state enum, so
/// the mapping lives here exactly as `ThreadLifecycleRow` does it rather than
/// leaking a SwiftUI type into `ThreadRelationshipRows`.
struct ThreadRelationshipOrb: View {
    let seed: String
    let size: CGFloat
    let state: LifecyclePresentation.RelatedThread.OrbState

    var body: some View {
        AgentOrb(seed: seed, size: size, state: orbState)
    }

    private var orbState: AgentOrbState {
        switch state {
        case .active: .active
        case .failed: .failed
        case .done: .done
        }
    }
}

struct ThreadActivitySheet: View {
    /// Nil when the thread has only background work to show.
    let model: ThreadRelationshipsModel?
    /// The model's rows, split by the pill so a finished agent collapses into
    /// Done on the same clock whether or not the sheet is open.
    let visibleRows: [ThreadRelationshipRow]
    let archivedRows: [ThreadRelationshipRow]
    let backgroundProcesses: [ThreadDetailsBackgroundProcess]
    /// `isArchived` tells the caller to route to the archive rather than the
    /// thread stack, which cannot show an archived thread.
    let onOpenThread: (_ threadID: String, _ isArchived: Bool) -> Void
    /// Throws when the server refuses; the sheet says so and stays put.
    /// Returning means the merge committed, so the sheet moves to the target.
    let onMerge: () async throws -> Void
    let onDetach: () async throws -> Void
    /// Interrupts a subagent's child thread. Throws when the server refuses;
    /// the sheet says so. Nil hides Stop.
    var onStopSubagent: ((_ childThreadID: String) async throws -> Void)? = nil
    /// Keyed by subagent id, the same metadata the timeline rows read.
    var subagentMetadata: [String: SubagentRowMetadata] = [:]

    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var showsArchived = false
    @State private var busyAction: BusyAction?
    @State private var isConfirmingDetach = false
    @State private var stoppingThreadID: String?
    @State private var failure: ActionFailure?

    private struct ActionFailure: Equatable {
        let title: String
        let message: String
    }

    private enum BusyAction: Equatable {
        case merge
        case detach
    }

    var body: some View {
        NavigationStack {
            List {
                if let model {
                    agentAndLineageSections(model)
                }
                if !backgroundProcesses.isEmpty {
                    Section("Background") {
                        ForEach(backgroundProcesses, id: \.id) { process in
                            ThreadDetailsBackgroundTaskRow(process: process)
                                .t3GroupedRow()
                        }
                    }
                }
                if let model {
                    actionSections(model)
                }
            }
            .listStyle(.insetGrouped)
            .t3GroupedListBackground()
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(.close)
            .confirmationDialog(
                "Disconnect the agent session?",
                isPresented: $isConfirmingDetach,
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) { Task { await detach() } }
            } message: {
                Text("The agent stops. The thread and its history stay.")
            }
            .alert(
                failure?.title ?? "",
                isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
            ) {
                Button("OK") { failure = nil }
            } message: {
                Text(failure?.message ?? "")
            }
        }
    }

    // MARK: Sections

    /// Agents lead: they are what the pill counted. Where the thread came from
    /// follows, then the agents that finished.
    @ViewBuilder
    private func agentAndLineageSections(_ model: ThreadRelationshipsModel) -> some View {
        let agentRows = visibleRows.filter { isSubagentChild($0, in: model) }
        let lineageRows = visibleRows.filter { !isSubagentChild($0, in: model) }
        if !agentRows.isEmpty {
            Section("Agents") {
                ForEach(agentRows) { relationshipRow($0, in: model) }
            }
        }
        if !lineageRows.isEmpty {
            Section("Source") {
                ForEach(lineageRows) { relationshipRow($0, in: model) }
            }
        }
        if !archivedRows.isEmpty {
            Section {
                if showsArchived {
                    ForEach(archivedRows) { relationshipRow($0, in: model) }
                }
            } header: {
                doneGroupHeader
            }
        }
    }

    @ViewBuilder
    private func actionSections(_ model: ThreadRelationshipsModel) -> some View {
        if model.canMerge {
            Section {
                Button {
                    Task { await merge(model) }
                } label: {
                    HStack(spacing: 8) {
                        if busyAction == .merge {
                            ProgressView()
                        } else {
                            Image(systemName: "arrow.triangle.merge")
                        }
                        Text("Merge Back to Source")
                    }
                    .frame(maxWidth: .infinity)
                }
                .t3ProminentButtonStyle()
                .controlSize(.large)
                .disabled(busyAction != nil)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                .accessibilityIdentifier("thread-merge-back")
            } footer: {
                Text("Brings this fork's latest work into the thread it came from.")
            }
        }
        if model.canDetach {
            Section {
                Button(role: .destructive) {
                    isConfirmingDetach = true
                } label: {
                    HStack {
                        Text("Disconnect Agent Session")
                        if busyAction == .detach {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(busyAction != nil)
                .t3GroupedRow()
                .accessibilityIdentifier("thread-detach-session")
            } footer: {
                Text("Stops the agent processes behind this thread. Its history stays.")
            }
        }
    }

    private func isSubagentChild(_ row: ThreadRelationshipRow, in model: ThreadRelationshipsModel) -> Bool {
        row.edge.kind == .subagent && row.edge.sourceThreadID == model.currentThreadID
    }

    private func relationshipRow(_ row: ThreadRelationshipRow, in model: ThreadRelationshipsModel) -> some View {
        let canStop = onStopSubagent != nil && model.canStopSubagent(row)

        // Two buttons, not one: Stop sits beside the row's open target rather
        // than inside it, so stopping never also opens the thread.
        return HStack(spacing: 4) {
            openButton(row, in: model, showsChevron: !canStop)

            if canStop {
                SubagentStopButton(isStopping: stoppingThreadID == row.threadID) {
                    Task { await stopSubagent(row.threadID) }
                }
                .disabled(stoppingThreadID != nil)
            }
        }
        .t3GroupedRow()
        .contextMenu {
            if canStop {
                Button("Stop Subagent", systemImage: "stop.fill", role: .destructive) {
                    Task { await stopSubagent(row.threadID) }
                }
                .disabled(stoppingThreadID != nil)
            }
        }
    }

    private func openButton(
        _ row: ThreadRelationshipRow,
        in model: ThreadRelationshipsModel,
        showsChevron: Bool
    ) -> some View {
        let availability = model.availability(for: row.threadID)
        let isArchivedThread = availability == "Archived"
        let disabled = availability == "Unavailable" || availability == "Deleted"
        let subagent = model.subagent(for: row.threadID)
        let metadata = subagent.flatMap { subagentMetadata[$0.id] }
        let status = row.edge.kind == .subagent ? WorkRowStatus(agentStatus: row.edge.status) : nil
        // The orb already carries status, so a finished agent with a known
        // time shows only that; a failed one keeps "Failed".
        let elapsed = row.edge.kind == .subagent ? subagent?.settledElapsed(status: row.edge.status) : nil
        let relationshipLabel = ThreadRelationships.label(row.edge, currentThreadID: model.currentThreadID)

        return Button {
            dismiss()
            onOpenThread(row.threadID, isArchivedThread)
        } label: {
            HStack(spacing: 12) {
                if row.edge.kind == .subagent {
                    ThreadRelationshipOrb(
                        seed: Self.orbSeed(for: row, in: model),
                        size: 32,
                        state: ThreadRelationships.subagentOrbState(row.edge.status)
                    )
                } else {
                    Image(systemName: ThreadRelationships.symbol(row.edge))
                        .font(.body)
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(width: 32, height: 32)
                        .accessibilityHidden(true)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: model.title(for: row.threadID))
                        .font(T3Typography.control)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    (metadata?.modelSummary(after: relationshipLabel) ?? Text(verbatim: relationshipLabel))
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                        .lineLimit(1)
                    if row.edge.kind == .subagent {
                        AgentWorkflowProgressView(
                            workflow: subagent?.workflow,
                            usage: subagent?.usage
                        )
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let availability {
                    Text(availability)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                } else {
                    if let elapsed {
                        Text(verbatim: elapsed)
                            .font(T3Typography.supporting)
                            .monospacedDigit()
                            .foregroundStyle(T3Colors.textTertiary)
                    } else if let status {
                        Text(status.accessibilityLabel)
                            .font(T3Typography.supporting)
                            .foregroundStyle(status == .failed ? T3Colors.danger : T3Colors.textTertiary)
                    }
                    // Stop takes the trailing slot while it shows; the row
                    // still opens on tap.
                    if showsChevron {
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(T3Colors.textTertiary)
                            .accessibilityHidden(true)
                    }
                }
            }
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityValue(availability ?? elapsed.map { "Finished in \($0)" } ?? status?.accessibilityLabel ?? "")
    }

    private var doneGroupHeader: some View {
        Button {
            withAnimation(.snappy) { showsArchived.toggle() }
        } label: {
            HStack(spacing: 8) {
                Text("Done (\(archivedRows.count))")
                Spacer(minLength: 0)
                TimelineDisclosureChevron(isExpanded: showsArchived)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            "\(archivedRows.count) finished \(archivedRows.count == 1 ? "subagent" : "subagents")"
        )
        .accessibilityValue(showsArchived ? "Expanded" : "Collapsed")
    }

    // MARK: Actions

    private func merge(_ model: ThreadRelationshipsModel) async {
        guard model.canMerge, busyAction == nil else { return }
        busyAction = .merge
        defer { busyAction = nil }
        do {
            try await onMerge()
        } catch {
            PlatformHapticEngine.shared.play(.error)
            failure = ActionFailure(title: "Couldn't Merge Back", message: error.localizedDescription)
            return
        }
        guard let targetThreadID = model.mergeTargetThreadID else { return }
        PlatformHapticEngine.shared.play(.success)
        dismiss()
        onOpenThread(targetThreadID, false)
    }

    private func detach() async {
        guard model?.canDetach == true, busyAction == nil else { return }
        busyAction = .detach
        defer { busyAction = nil }
        do {
            try await onDetach()
        } catch {
            PlatformHapticEngine.shared.play(.error)
            failure = ActionFailure(title: "Couldn't Detach", message: error.localizedDescription)
        }
    }

    /// Interrupts the child thread's live turn; the row follows the
    /// subagent's status as the stop lands.
    private func stopSubagent(_ threadID: String) async {
        guard let onStopSubagent, stoppingThreadID == nil else { return }
        stoppingThreadID = threadID
        defer { stoppingThreadID = nil }
        do {
            try await onStopSubagent(threadID)
        } catch {
            PlatformHapticEngine.shared.play(.error)
            failure = ActionFailure(title: "Couldn't Stop Subagent", message: error.localizedDescription)
        }
    }

    static func orbSeed(for row: ThreadRelationshipRow, in model: ThreadRelationshipsModel) -> String {
        // The child thread id is the seed the timeline already uses, and the
        // relationship graph is keyed by thread id, so a subagent keeps one
        // colour across both surfaces without extra plumbing.
        model.subagent(for: row.threadID)?.orbSeed ?? row.threadID
    }
}

/// The trailing Stop on a running subagent's lineage row: a stop square in a
/// tinted circle, a spinner while the interrupt is in flight.
struct SubagentStopButton: View {
    let isStopping: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(T3Colors.danger.opacity(0.14))
                if isStopping {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(T3Colors.danger)
                }
            }
            .frame(width: 28, height: 28)
            .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        // Borderless keeps this tap its own inside a List row.
        .buttonStyle(.borderless)
        .accessibilityLabel("Stop subagent")
        .accessibilityValue(isStopping ? "Stopping" : "")
    }
}
