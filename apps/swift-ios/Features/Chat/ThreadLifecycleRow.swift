import SwiftUI

// Ported from apps/mobile/src/features/threads/ThreadLifecycleRow.tsx. The
// presentation itself is already ported in ThreadLifecycle.swift; this is the
// row that renders it.

/// First-class timeline row for a V2 lifecycle item: system dividers (interrupt
/// request/result, compaction, handoff, fork) and related-thread rows (thread
/// created, subagent).
struct ThreadLifecycleRow: View {
    let row: OrchestrationV2ProjectedTurnItem
    /// Handoff rows recover origin models from the thread's run history.
    var runs: [LifecycleTimelineRun] = []
    /// Live projection support beats the item snapshot for a subagent's child
    /// thread id: provider-native subagents backfill it after the item is first
    /// persisted.
    var liveChildThreadID: String?
    /// Drops a related-thread row's own bottom spacing so a merged run can
    /// supply it once.
    var grouped = false
    var onOpenThread: (String) -> Void = { _ in }

    var body: some View {
        if let presentation = ThreadLifecycle.resolvePresentation(row.item, runs: runs) {
            switch presentation {
            case let .divider(divider):
                TimelineSystemDivider(
                    label: divider.label,
                    detail: divider.detail,
                    tone: divider.tone == .danger ? .danger : .neutral,
                    symbol: divider.symbol,
                    layout: divider.layout == .stacked ? .stacked : .inline,
                    busy: divider.busy,
                    accessibilityActionLabel: divider.actionLabel,
                    action: divider.openThreadID.map { threadID in
                        { onOpenThread(threadID) }
                    }
                )

            case let .relatedThread(presentation):
                RelatedThreadRow(
                    presentation: presentation,
                    threadID: row.item.type == "subagent"
                        ? (liveChildThreadID ?? presentation.threadID)
                        : presentation.threadID,
                    onOpenThread: onOpenThread
                )
                .padding(.bottom, grouped ? 0 : ChatTimelineStyle.entrySpacing)
            }
        }
    }
}

/// A subagent or created thread, drawn as an ordinary work-log row: orb or
/// icon, the agent's name with its task muted after it, the latest progress or
/// result underneath, and a status glyph. Tapping opens the thread.
private struct RelatedThreadRow: View {
    let presentation: LifecyclePresentation.RelatedThread
    let threadID: String?
    let onOpenThread: (String) -> Void

    private var canOpen: Bool { threadID != nil }

    var body: some View {
        Button {
            guard let threadID else { return }
            onOpenThread(threadID)
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    leadingGlyph
                        .frame(width: 20, height: 20)

                    heading
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    HStack(spacing: 1) {
                        if let meta = presentation.meta {
                            Text(verbatim: meta)
                                .font(ChatTimelineStyle.small)
                                .foregroundStyle(T3Colors.textTertiary)
                                .padding(.trailing, 4)
                        }
                        WorkRowStatusGlyph(status: presentation.status)
                        if canOpen {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(T3Colors.textTertiary)
                                .frame(width: 16, height: 16)
                        }
                    }
                }
                .frame(minHeight: 36)

                // Strictly one line: a fan-out of agents is scanned, not read.
                // Plain text even while the agent runs, since that can be minutes.
                if let detail = presentation.detail {
                    Text(verbatim: detail)
                        .font(ChatTimelineStyle.small)
                        .foregroundStyle(T3Colors.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.leading, 26)
                        .padding(.top, -6)
                        .padding(.bottom, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canOpen)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(canOpen ? .isButton : [])
    }

    private var heading: Text {
        let title = Text(verbatim: presentation.title)
            .font(ChatTimelineStyle.bodyStrong)
            .foregroundStyle(T3Colors.textPrimary)
        guard let preview = presentation.preview else { return title }
        return title
            + Text(verbatim: " \(preview)")
            .font(ChatTimelineStyle.body)
            .foregroundStyle(T3Colors.textTertiary)
    }

    @ViewBuilder
    private var leadingGlyph: some View {
        if let seed = presentation.orbSeed {
            AgentOrb(seed: seed, size: 16, state: orbState)
        } else {
            Image(systemName: presentation.symbol)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(T3Colors.textTertiary)
                .accessibilityHidden(true)
        }
    }

    private var accessibilityLabel: String {
        let description = [
            presentation.title,
            presentation.preview,
            presentation.meta,
            presentation.status?.accessibilityLabel,
            presentation.detail,
        ]
        .compactMap { $0 }
        .joined(separator: ", ")
        return canOpen ? "Open \(description)" : description
    }

    private var orbState: AgentOrbState {
        switch presentation.orbState {
        case .active: .active
        case .failed: .failed
        case .done, nil: .done
        }
    }
}

/// Agents fanned out side by side read as one list: a run of adjacent
/// lifecycle rows stacks as tightly as a work log, with the entry spacing
/// supplied once for the run.
struct ThreadLifecycleRowGroup: View {
    let rows: [OrchestrationV2ProjectedTurnItem]
    var runs: [LifecycleTimelineRun] = []
    var liveChildThreadIDs: [String: String] = [:]
    var onOpenThread: (String) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(rows, id: \.id) { row in
                ThreadLifecycleRow(
                    row: row,
                    runs: runs,
                    liveChildThreadID: liveChildThreadIDs[row.id],
                    grouped: true,
                    onOpenThread: onOpenThread
                )
            }
        }
        .padding(.bottom, ChatTimelineStyle.entrySpacing)
    }
}
