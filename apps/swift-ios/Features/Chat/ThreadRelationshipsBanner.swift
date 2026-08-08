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
    /// Returns whether the merge committed, which decides whether the sheet
    /// navigates to the target thread.
    let onMerge: () async -> Bool
    let onDetach: () async -> Void

    @State private var isSheetPresented = false
    @State private var decay = ThreadRelationshipDecay()
    @State private var visibleRows: [ThreadRelationshipRow] = []
    @State private var archivedRows: [ThreadRelationshipRow] = []
    @State private var showsArchived = false
    @State private var busyAction: BusyAction?

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
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(minHeight: 44)
        .background(T3Colors.surface, in: collapsedShape)
        .overlay { collapsedShape.stroke(T3Colors.border, lineWidth: 1) }
        .contentShape(collapsedShape)
    }

    private func agentRow(_ summary: ThreadSubagentSummary) -> some View {
        HStack(spacing: 8) {
            // Negative spacing overlaps the orbs; the halo behind each one is
            // the banner's own fill, so it cuts the orb behind it the way the
            // desktop stack's ring does.
            HStack(spacing: -5) {
                ForEach(summary.orbRows) { row in
                    ThreadRelationshipOrb(
                        seed: orbSeed(for: row),
                        size: 16,
                        state: ThreadRelationships.subagentOrbState(row.edge.status)
                    )
                    .background { Circle().fill(T3Colors.surface).padding(-1.5) }
                }
            }
            .fixedSize()

            HStack(spacing: 0) {
                Text(summary.primaryLabel)
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(
                        summary.isSettled ? T3Colors.textSecondary : T3Colors.textPrimary
                    )
                if let failedLabel = summary.secondaryFailedLabel {
                    Text(" · \(failedLabel)")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.danger)
                }
            }
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity, alignment: .leading)

            if let doneLabel = summary.trailingDoneLabel {
                Text(doneLabel)
                    .font(T3Typography.supporting)
                    .monospacedDigit()
                    .foregroundStyle(T3Colors.textTertiary)
                    .fixedSize()
            }

            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(T3Colors.textTertiary)
        }
    }

    private var lineageRow: some View {
        HStack(spacing: 8) {
            if let primaryRow = model.primaryRow, primaryRow.edge.kind == .subagent {
                ThreadRelationshipOrb(
                    seed: orbSeed(for: primaryRow),
                    size: 16,
                    state: ThreadRelationships.subagentOrbState(primaryRow.edge.status)
                )
            } else {
                Image(systemName: model.primaryRow.map(collapsedSymbol) ?? "link")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(T3Colors.textTertiary)
            }

            Text(model.summary)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)

            if model.rows.count > 1 {
                Text("+\(model.rows.count - 1)")
                    .font(T3Typography.supporting)
                    .monospacedDigit()
                    .foregroundStyle(T3Colors.textTertiary)
            }

            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(T3Colors.textTertiary)
        }
    }

    private var collapsedAccessibilityLabel: String {
        let summary = model.subagentSummary
        guard !summary.isEmpty else {
            return "\(model.summary). Show thread relationships"
        }
        let parts = [
            summary.primaryLabel,
            summary.secondaryFailedLabel,
            summary.trailingDoneLabel,
        ].compactMap { $0 }
        return "Agents: \(parts.joined(separator: ", ")). Show thread relationships"
    }

    private var collapsedShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
    }

    private func collapsedSymbol(_ row: ThreadRelationshipRow) -> String {
        ThreadRelationships.symbol(row.edge)
    }

    // MARK: Sheet

    private var lineageSheet: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(visibleRows) { row in
                        relationshipRow(row)
                    }

                    if !archivedRows.isEmpty {
                        doneGroupToggle
                        if showsArchived {
                            ForEach(archivedRows) { row in
                                relationshipRow(row)
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }
            .background(T3Colors.background)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                sheetActions
            }
            .navigationTitle("Thread lineage")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text("Thread lineage")
                            .font(T3Typography.navigationTitle)
                            .foregroundStyle(T3Colors.textPrimary)
                        Text(relatedCountLabel)
                            .font(T3Typography.navigationMetadata)
                            .foregroundStyle(T3Colors.textTertiary)
                    }
                    .accessibilityElement(children: .combine)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { isSheetPresented = false }
                        .accessibilityLabel("Close thread lineage")
                }
            }
        }
    }

    private var relatedCountLabel: String {
        "\(model.rows.count) related \(model.rows.count == 1 ? "thread" : "threads")"
    }

    private func relationshipRow(_ row: ThreadRelationshipRow) -> some View {
        let availability = model.availability(for: row.threadID)
        let isArchivedThread = availability == "Archived"
        let disabled = availability == "Unavailable" || availability == "Deleted"
        let subagent = model.subagent(for: row.threadID)

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
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(width: 32, height: 32)
                        .background(T3Colors.subtle, in: Circle())
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(
                        ThreadRelationships.label(
                            row.edge, currentThreadID: model.currentThreadID
                        )
                        .uppercased()
                    )
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)

                    Text(model.title(for: row.threadID))
                        .font(T3Typography.control)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)

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
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(T3Colors.textTertiary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(minHeight: 56)
            .background(T3Colors.surface, in: rowShape)
            .overlay { rowShape.stroke(T3Colors.border, lineWidth: 1) }
            .contentShape(rowShape)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.55 : 1)
    }

    private var rowShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
    }

    private var doneGroupToggle: some View {
        Button {
            showsArchived.toggle()
        } label: {
            HStack(spacing: 8) {
                Text("Done · \(archivedRows.count)")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textTertiary)
                Spacer(minLength: 0)
                Image(systemName: showsArchived ? "chevron.up" : "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(T3Colors.textTertiary)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .overlay { rowShape.stroke(T3Colors.border, lineWidth: 1) }
            .contentShape(rowShape)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            "\(archivedRows.count) finished \(archivedRows.count == 1 ? "subagent" : "subagents")"
        )
        .accessibilityValue(showsArchived ? "Expanded" : "Collapsed")
    }

    @ViewBuilder
    private var sheetActions: some View {
        if model.canMerge || model.canDetach {
            VStack(spacing: 8) {
                if model.canMerge {
                    Button {
                        Task { await merge() }
                    } label: {
                        HStack(spacing: 6) {
                            if busyAction == .merge {
                                ProgressView().controlSize(.small).tint(
                                    T3Colors.primaryActionForeground)
                            } else {
                                Image(systemName: "arrow.triangle.merge")
                                    .font(.system(size: 13, weight: .semibold))
                            }
                            Text("Merge back to source")
                                .font(T3Typography.control)
                        }
                        .foregroundStyle(T3Colors.primaryActionForeground)
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                        .background(
                            T3Colors.primaryAction,
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(busyAction != nil)
                    .opacity(busyAction != nil ? 0.6 : 1)
                    .accessibilityIdentifier("thread-merge-back")
                }

                if model.canDetach {
                    Button {
                        Task { await detach() }
                    } label: {
                        HStack(spacing: 6) {
                            if busyAction == .detach {
                                ProgressView().controlSize(.small)
                            }
                            Text("Disconnect agent session")
                                .font(T3Typography.control)
                        }
                        .foregroundStyle(T3Colors.textPrimary)
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(T3Colors.inputBorder, lineWidth: 1)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(busyAction != nil)
                    .opacity(busyAction != nil ? 0.6 : 1)
                    .accessibilityIdentifier("thread-detach-session")
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)
            .background(.bar)
        }
    }

    // MARK: Actions

    private func merge() async {
        guard model.canMerge, busyAction == nil else { return }
        busyAction = .merge
        let merged = await onMerge()
        busyAction = nil
        guard merged, let targetThreadID = model.mergeTargetThreadID else { return }
        isSheetPresented = false
        onOpenThread(targetThreadID, false)
    }

    private func detach() async {
        guard model.canDetach, busyAction == nil else { return }
        busyAction = .detach
        await onDetach()
        busyAction = nil
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
