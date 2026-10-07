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
    /// What a subagent runs on and where; nil for created threads and for a
    /// subagent whose projection row has not arrived.
    var subagentMetadata: SubagentRowMetadata?
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
                    metadata: row.item.type == "subagent" ? subagentMetadata : nil,
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
    let metadata: SubagentRowMetadata?
    let onOpenThread: (String) -> Void

    private var canOpen: Bool { threadID != nil }

    var body: some View {
        Button {
            guard let threadID else { return }
            onOpenThread(threadID)
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    leadingGlyph
                        .frame(width: 20, height: 20)

                    heading
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    HStack(spacing: 6) {
                        if let meta = presentation.meta {
                            Text(verbatim: meta)
                                .font(ChatTimelineStyle.small)
                                .foregroundStyle(T3Colors.textTertiary)
                        }
                        // Words, not a glyph: "Failed" and "Working" are what a
                        // fan-out of agents is scanned for.
                        if let status = presentation.status {
                            Text(verbatim: status == .running ? "Working" : status.accessibilityLabel)
                                .font(ChatTimelineStyle.small)
                                .foregroundStyle(status == .failed ? T3Colors.danger : T3Colors.textTertiary)
                        }
                        if canOpen {
                            Image(systemName: "chevron.right")
                                .font(ChatTimelineStyle.small.weight(.semibold))
                                .foregroundStyle(T3Colors.textTertiary)
                        }
                    }
                }
                .frame(minHeight: T3Metrics.minimumTapTarget)

                if let metadata {
                    SubagentMetadataLine(metadata: metadata)
                        .padding(.leading, 28)
                        .padding(.bottom, 2)
                }

                // At most three lines: enough to read where the agent got to,
                // short enough that a fan-out still scans. Plain text even while
                // the agent runs, since that can be minutes.
                if let detail = presentation.detail {
                    Text(verbatim: detail)
                        .font(ChatTimelineStyle.small)
                        .foregroundStyle(presentation.status == .failed ? T3Colors.danger : T3Colors.textTertiary)
                        .lineLimit(3)
                        .truncationMode(.tail)
                        .padding(.leading, 28)
                        .padding(.bottom, 6)
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
                .font(ChatTimelineStyle.bodyStrong)
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
            metadata?.accessibilityText,
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

/// "Model · Effort · ⚡ Fast · ● Account · ⎇ branch": what a subagent runs
/// on, then only where it differs from the parent.
private struct SubagentMetadataLine: View {
    let metadata: SubagentRowMetadata

    var body: some View {
        HStack(spacing: 4) {
            Text(verbatim: metadata.modelLabel)
                .layoutPriority(1)
            if let effort = metadata.traits?.effort {
                separator
                Text(verbatim: effort)
                    .fixedSize()
            }
            if let speed = metadata.traits?.speed {
                separator
                speed.text
                    .fixedSize()
            }
            if let account = metadata.account {
                separator
                if let accent = metadata.accentColor.flatMap(ProviderAccountBadge.color) {
                    Circle()
                        .fill(accent)
                        .frame(width: 6, height: 6)
                }
                Text(verbatim: account)
            }
            ForEach(metadata.workspace, id: \.label) { entry in
                separator
                Image(systemName: entry.label == "Branch" ? "arrow.triangle.branch" : "folder")
                    .imageScale(.small)
                Text(verbatim: entry.value)
            }
        }
        .font(ChatTimelineStyle.small)
        .foregroundStyle(T3Colors.textTertiary)
        .lineLimit(1)
        .truncationMode(.tail)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var separator: some View {
        Text(verbatim: "·")
    }
}

extension SubagentRowMetadata {
    /// Read in place of the line's glyphs: "Opus 4.6, High, Fast, Work account, Branch: fix/agents".
    var accessibilityText: String {
        ([modelLabel, traits?.effort, traits?.speed?.label, account].compactMap { $0 }
            + workspace.map { "\($0.label): \($0.value)" })
            .joined(separator: ", ")
    }

    /// "Subagent · GPT-5.6 · High · ⚡ Fast": a lineage row's subtitle as one
    /// run of text, so it truncates as a whole rather than squeezing each part.
    func modelSummary(after leading: String) -> Text {
        let base = [leading, modelLabel, traits?.effort].compactMap { $0 }.joined(separator: " · ")
        guard let speed = traits?.speed else { return Text(verbatim: base) }
        return Text("\(base) · \(speed.text)")
    }
}

extension SubagentModelTraits.Speed {
    /// Web's bolt beside the tier's name; the name tells Fast from Ultrafast.
    var text: Text {
        Text("\(Image(systemName: "bolt.fill")) \(label)")
    }
}

extension ProviderAccountBadge {
    /// The accent a provider instance was given in settings, as a fill.
    static func color(_ hex: String) -> Color? {
        guard let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        return Color(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

/// Agents fanned out side by side read as one list: a run of adjacent
/// lifecycle rows stacks as tightly as a work log, with the entry spacing
/// supplied once for the run.
struct ThreadLifecycleRowGroup: View {
    let rows: [OrchestrationV2ProjectedTurnItem]
    var runs: [LifecycleTimelineRun] = []
    var liveChildThreadIDs: [String: String] = [:]
    var subagentMetadata: [String: SubagentRowMetadata] = [:]
    var onOpenThread: (String) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(rows, id: \.id) { row in
                ThreadLifecycleRow(
                    row: row,
                    runs: runs,
                    liveChildThreadID: liveChildThreadIDs[row.id],
                    subagentMetadata: subagentMetadata[row.id],
                    grouped: true,
                    onOpenThread: onOpenThread
                )
            }
        }
        .padding(.bottom, ChatTimelineStyle.entrySpacing)
    }
}
