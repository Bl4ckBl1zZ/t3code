import SwiftUI

// The lineage banner above the transcript.
//
// Ports apps/mobile/src/features/threads/ThreadRelationshipsBanner.tsx: a single
// collapsed line summarising what this thread is related to, opening a sheet
// that lists every parent, fork, transfer and subagent with live orb state,
// availability, and the merge-back / disconnect actions.
//
// All derivation lives in ThreadRelationshipRows.swift; this file is the view.

/// A subagent's identity orb, taking the pure layer's orb state.
///
/// `AgentOrb` (owned by the timeline work) has its own view-level state enum, so
/// the mapping lives here exactly as `ThreadLifecycleRow` does it rather than
/// leaking a SwiftUI type into `ThreadRelationshipRows`.
private struct ThreadRelationshipOrb: View {
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

struct ThreadRelationshipsBanner: View {
    let model: ThreadRelationshipsModel
    /// `isArchived` tells the caller to route to the archive rather than the
    /// thread stack, which cannot show an archived thread.
    let onOpenThread: (_ threadID: String, _ isArchived: Bool) -> Void
    /// Throws when the server refuses; the sheet says so and stays put.
    /// Returning means the merge committed, so the sheet moves to the target.
    let onMerge: () async throws -> Void
    let onDetach: () async throws -> Void

    @State private var isSheetPresented = false
    @State private var decay = ThreadRelationshipDecay()
    @State private var visibleRows: [ThreadRelationshipRow] = []
    @State private var archivedRows: [ThreadRelationshipRow] = []
    @State private var showsArchived = false
    @State private var busyAction: BusyAction?
    @State private var isConfirmingDetach = false
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
        if !model.isEmpty {
            Button {
                isSheetPresented = true
            } label: {
                collapsedLabel
            }
            .buttonStyle(.plain)
            .accessibilityLabel(collapsedAccessibilityLabel)
            .accessibilityIdentifier("thread-relationships-banner")
            .task(id: model.rows) {
                await trackDecay()
            }
            .sheet(isPresented: $isSheetPresented) {
                lineageSheet
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
    }

    // MARK: Collapsed

    private var collapsedLabel: some View {
        Group {
            // Lineage is the fallback, not the headline: a thread with agents
            // running has something to report, and where it was forked from
            // does not change while you read it.
            if model.subagentSummary.isEmpty {
                lineageRow
            } else {
                agentRow(model.subagentSummary)
            }
        }
        .overlay(alignment: .trailing) { disclosureChevron }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(minHeight: 48)
        // `.regular`, matching the composer pill: the banner reads as the same
        // family of surface, solid enough that the transcript scrolling under
        // it never competes with the orbs. Interactive, because the capsule is
        // the button; the rim only draws where glass has no edge of its own.
        .t3GlassEffect(.regular, interactive: true, in: collapsedShape)
        .t3GlassRim(in: collapsedShape)
        .contentShape(collapsedShape)
    }

    private func agentRow(_ summary: ThreadSubagentSummary) -> some View {
        HStack(spacing: 8) {
            // Negative spacing overlaps the orbs; the halo behind each one is
            // the banner's own fill, so it cuts the orb behind it the way the
            // desktop stack's ring does.
            HStack(spacing: -8) {
                ForEach(summary.orbRows) { row in
                    ThreadRelationshipOrb(
                        seed: orbSeed(for: row),
                        size: 26,
                        state: ThreadRelationships.subagentOrbState(row.edge.status)
                    )
                    .background { Circle().fill(T3Colors.surface).padding(-2) }
                }
            }
            .fixedSize()

            HStack(spacing: 0) {
                Text(summary.primaryLabel)
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textPrimary)
                if let failedLabel = summary.secondaryFailedLabel {
                    Text(" · \(failedLabel)")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.danger)
                }
            }
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.8)

            chevronSpacer
        }
    }

    private var disclosureChevron: some View {
        Image(systemName: "chevron.right")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(T3Colors.textTertiary)
            .accessibilityHidden(true)
    }

    /// Reserves the chevron's width inside each row so the overlay never sits
    /// on top of a label.
    private var chevronSpacer: some View {
        disclosureChevron.hidden()
    }

    private var lineageRow: some View {
        HStack(spacing: 8) {
            if let primaryRow = model.primaryRow, primaryRow.edge.kind == .subagent {
                ThreadRelationshipOrb(
                    seed: orbSeed(for: primaryRow),
                    size: 26,
                    state: ThreadRelationships.subagentOrbState(primaryRow.edge.status)
                )
            } else {
                Image(systemName: model.primaryRow.map(collapsedSymbol) ?? "link")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(T3Colors.textTertiary)
            }

            Text(model.summary)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)

            if model.rows.count > 1 {
                Text("+\(model.rows.count - 1)")
                    .font(T3Typography.supporting)
                    .monospacedDigit()
                    .foregroundStyle(T3Colors.textTertiary)
            }

            chevronSpacer
        }
    }

    private var collapsedAccessibilityLabel: String {
        let summary = model.subagentSummary
        guard !summary.isEmpty else {
            return "\(model.summary). Show thread relationships"
        }
        let parts = [summary.primaryLabel, summary.secondaryFailedLabel].compactMap { $0 }
        return "Agents: \(parts.joined(separator: ", ")). Show thread relationships"
    }

    private var collapsedShape: Capsule {
        Capsule(style: .continuous)
    }

    private func collapsedSymbol(_ row: ThreadRelationshipRow) -> String {
        ThreadRelationships.symbol(row.edge)
    }

    // MARK: Sheet

    private var lineageSheet: some View {
        NavigationStack {
            List {
                let lineageRows = visibleRows.filter { !isSubagentChild($0) }
                let agentRows = visibleRows.filter(isSubagentChild)
                if !lineageRows.isEmpty {
                    Section("Source") {
                        ForEach(lineageRows) { relationshipRow($0) }
                    }
                }
                if !agentRows.isEmpty {
                    Section("Agents") {
                        ForEach(agentRows) { relationshipRow($0) }
                    }
                }
                if !archivedRows.isEmpty {
                    Section {
                        if showsArchived {
                            ForEach(archivedRows) { relationshipRow($0) }
                        }
                    } header: {
                        doneGroupHeader
                    }
                }
                if model.canMerge {
                    Section {
                        Button {
                            Task { await merge() }
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
            .listStyle(.insetGrouped)
            .t3GroupedListBackground()
            .navigationTitle("Thread Lineage")
            .navigationBarTitleDisplayMode(.inline)
            .modifier(LineageSubtitle(subtitle: relatedCountLabel))
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

    private func isSubagentChild(_ row: ThreadRelationshipRow) -> Bool {
        row.edge.kind == .subagent && row.edge.sourceThreadID == model.currentThreadID
    }

    private var relatedCountLabel: String {
        "\(model.rows.count) related \(model.rows.count == 1 ? "thread" : "threads")"
    }

    private func relationshipRow(_ row: ThreadRelationshipRow) -> some View {
        let availability = model.availability(for: row.threadID)
        let isArchivedThread = availability == "Archived"
        let disabled = availability == "Unavailable" || availability == "Deleted"
        let subagent = model.subagent(for: row.threadID)
        let status = row.edge.kind == .subagent ? WorkRowStatus(agentStatus: row.edge.status) : nil

        return Button {
            isSheetPresented = false
            onOpenThread(row.threadID, isArchivedThread)
        } label: {
            HStack(spacing: 12) {
                if row.edge.kind == .subagent {
                    ThreadRelationshipOrb(
                        seed: orbSeed(for: row),
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
                    Text(verbatim: ThreadRelationships.label(row.edge, currentThreadID: model.currentThreadID))
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
                    if let status {
                        Text(status.accessibilityLabel)
                            .font(T3Typography.supporting)
                            .foregroundStyle(status == .failed ? T3Colors.danger : T3Colors.textTertiary)
                    }
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(T3Colors.textTertiary)
                        .accessibilityHidden(true)
                }
            }
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .t3GroupedRow()
        .accessibilityValue(status?.accessibilityLabel ?? availability ?? "")
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

    private func merge() async {
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
        isSheetPresented = false
        onOpenThread(targetThreadID, false)
    }

    private func detach() async {
        guard model.canDetach, busyAction == nil else { return }
        busyAction = .detach
        defer { busyAction = nil }
        do {
            try await onDetach()
        } catch {
            PlatformHapticEngine.shared.play(.error)
            failure = ActionFailure(title: "Couldn't Detach", message: error.localizedDescription)
        }
    }

    private func orbSeed(for row: ThreadRelationshipRow) -> String {
        // The child thread id is the seed the timeline already uses, and the
        // relationship graph is keyed by thread id, so a subagent keeps one
        // colour across both surfaces without extra plumbing.
        model.subagent(for: row.threadID)?.orbSeed ?? row.threadID
    }

    /// Re-splits the rows when one is due to collapse into the Done group.
    /// One scheduled wake-up rather than a ticker: a finished subagent is a
    /// minute away from collapsing, and nothing else changes in between.
    private func trackDecay() async {
        while !Task.isCancelled {
            let split = decay.split(rows: model.rows)
            visibleRows = split.visible
            archivedRows = split.archived
            guard let nextRefresh = split.nextRefresh else { return }
            let delay = nextRefresh.timeIntervalSinceNow + 0.05
            guard delay > 0 else { continue }
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                return
            }
        }
    }
}

/// The related-thread count under the lineage title, where iOS 26 has a
/// subtitle to put it in.
private struct LineageSubtitle: ViewModifier {
    let subtitle: String

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.navigationSubtitle(subtitle)
        } else {
            content
        }
    }
}
