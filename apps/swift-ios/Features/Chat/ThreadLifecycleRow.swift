import SwiftUI

// Ported from apps/mobile/src/features/threads/ThreadLifecycleRow.tsx. The
// presentation itself is already ported in ThreadLifecycle.swift; this is the
// row that renders it.

/// `bare` drops the card surface so a merged group can supply its own.
enum RelatedThreadCardChrome: Equatable {
    case card
    case bare
}

/// First-class timeline row for a V2 lifecycle item: system dividers (interrupt
/// request/result, compaction, handoff, fork) and related-thread cards (thread
/// created, subagent).
struct ThreadLifecycleRow: View {
    let row: OrchestrationV2ProjectedTurnItem
    /// Handoff rows recover origin models from the thread's run history.
    var runs: [LifecycleTimelineRun] = []
    /// Live projection support beats the item snapshot for a subagent's child
    /// thread id: provider-native subagents backfill it after the item is first
    /// persisted.
    var liveChildThreadID: String?
    var chrome: RelatedThreadCardChrome = .card
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
                RelatedThreadCard(
                    presentation: presentation,
                    threadID: row.item.type == "subagent"
                        ? (liveChildThreadID ?? presentation.threadID)
                        : presentation.threadID,
                    chrome: chrome,
                    onOpenThread: onOpenThread
                )
            }
        }
    }
}

private struct RelatedThreadCard: View {
    let presentation: LifecyclePresentation.RelatedThread
    let threadID: String?
    let chrome: RelatedThreadCardChrome
    let onOpenThread: (String) -> Void

    private var canOpen: Bool { threadID != nil }

    var body: some View {
        Group {
            if chrome == .bare {
                content
            } else {
                content
                    .background(relatedThreadCardSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .padding(.bottom, ChatTimelineStyle.entrySpacing)
            }
        }
    }

    private var content: some View {
        Button {
            guard let threadID else { return }
            onOpenThread(threadID)
        } label: {
            HStack(spacing: 12) {
                leadingGlyph

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(verbatim: presentation.title)
                            .font(T3Typography.homeTitle)
                            .foregroundStyle(T3Colors.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Text(verbatim: presentation.badge.uppercased())
                            .font(ChatTimelineStyle.microStrong)
                            .tracking(0.5)
                            .foregroundStyle(badgeColor)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                    // Strictly one line: a fan-out of agents is scanned, not
                    // read, and a card that grows a second line for one agent
                    // breaks the column.
                    if let detail = presentation.detail, !detail.isEmpty {
                        Text(verbatim: detail)
                            .font(ChatTimelineStyle.body)
                            .foregroundStyle(T3Colors.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .shimmering(presentation.orbState == .active)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if canOpen {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(T3Colors.textTertiary)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canOpen)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            canOpen ? "Open \(presentation.title)" : "\(presentation.title) details"
        )
    }

    @ViewBuilder
    private var leadingGlyph: some View {
        if let seed = presentation.orbSeed {
            AgentOrb(seed: seed, size: 26, state: orbState)
        } else {
            Image(systemName: presentation.symbol)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(T3Colors.textTertiary)
                .frame(width: 26, height: 26)
        }
    }

    private var orbState: AgentOrbState {
        switch presentation.orbState {
        case .active: .active
        case .failed: .failed
        case .done, nil: .done
        }
    }

    private var badgeColor: Color {
        switch presentation.badgeTone {
        case .neutral: T3Colors.textSecondary
        case .success: T3Colors.success
        case .danger: T3Colors.danger
        }
    }
}

/// Shared by the standalone card and the grouped container so a merged run
/// keeps exactly the radius and fill a single card would have had.
private var relatedThreadCardSurface: some View {
    RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(T3Colors.surface)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(T3Colors.border, lineWidth: 1)
        )
}

/// Agents fanned out side by side read as one list, not as a stack of separate
/// boxes: a run of adjacent related-thread cards shares a single card surface,
/// with a hairline between each agent.
struct ThreadLifecycleCardGroup: View {
    let rows: [OrchestrationV2ProjectedTurnItem]
    var runs: [LifecycleTimelineRun] = []
    var liveChildThreadIDs: [String: String] = [:]
    var onOpenThread: (String) -> Void = { _ in }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 {
                    Rectangle()
                        .fill(ChatTimelineStyle.hairline)
                        .frame(height: 1)
                        .accessibilityHidden(true)
                }
                ThreadLifecycleRow(
                    row: row,
                    runs: runs,
                    liveChildThreadID: liveChildThreadIDs[row.id],
                    chrome: .bare,
                    onOpenThread: onOpenThread
                )
            }
        }
        .background(relatedThreadCardSurface)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.bottom, ChatTimelineStyle.entrySpacing)
    }
}
