import ActivityKit
import SwiftUI
import WidgetKit

struct T3TaskLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LiveActivityAttributes.self) { context in
            // The tint and the escalation layout depend on `isLuminanceReduced`
            // and `colorScheme`, which only exist inside the view, so the
            // background tint is applied one level in rather than here.
            T3LiveActivityLockScreenView(state: context.state, isStale: context.isStale)
                .activitySystemActionForegroundColor(Color(uiColor: .label))
                .widgetURL(T3AgentActivityPresentation(state: context.state).deepLinkURL)
        } dynamicIsland: { context in
            let presentation = T3AgentActivityPresentation(state: context.state, isStale: context.isStale)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    T3ActivityMark(tint: presentation.heroTint.color(), size: .expanded)
                        .padding(.leading, 4)
                }

                DynamicIslandExpandedRegion(.trailing) {
                    Group {
                        if let since = presentation.escalatedRow?.phaseSince, !presentation.isStale {
                            // A calm mm:ss count, the format Timer and Maps use.
                            Text(since, style: .timer)
                                .multilineTextAlignment(.trailing)
                                .monospacedDigit()
                        } else if presentation.isAllDone {
                            Image(systemName: presentation.heroPhase.systemImage)
                        } else {
                            Text("\(presentation.activeCount)")
                                .contentTransition(.numericText())
                        }
                    }
                    .font(.headline)
                    .foregroundStyle(presentation.headerTint.color())
                    .frame(maxWidth: 64, alignment: .trailing)
                    .padding(.trailing, 4)
                }

                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 1) {
                        Text(islandHeadline(presentation))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(presentation.headerTint.color())
                        if let escalated = presentation.escalatedRow {
                            Text(escalated.threadTitle)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .lineLimit(1)
                }

                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if let escalated = presentation.escalatedRow {
                            if let url = escalated.nativeDeepLinkURL {
                                T3OpenThreadLink(url: url)
                            }
                            if !presentation.footer.isEmpty {
                                Text(presentation.footer)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else if presentation.rows.isEmpty {
                            Text(presentation.subtitle)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        } else {
                            ForEach(presentation.rows.prefix(3)) { row in
                                T3LiveActivityRow(row: row, isStale: presentation.isStale)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 2)
                }
            } compactLeading: {
                T3ActivityMark(tint: presentation.heroTint.color(), size: .compact)
            } compactTrailing: {
                // Glyph + bare count rather than a word: the compact
                // presentation also renders in landscape, where it cannot grow
                // in width, and "Approval" was the first thing to get clipped.
                if presentation.isEscalated {
                    HStack(spacing: 3) {
                        Image(systemName: presentation.heroPhase.systemImage)
                        if presentation.attentionCount > 1 {
                            Text("\(presentation.attentionCount)")
                                .font(.caption2.weight(.semibold))
                                .contentTransition(.numericText())
                        }
                    }
                    .foregroundStyle(presentation.headerTint.color())
                } else if presentation.isAllDone {
                    Image(systemName: presentation.heroPhase.systemImage)
                        .foregroundStyle(presentation.heroTint.color())
                } else {
                    Text("\(presentation.activeCount)")
                        .font(.caption.weight(.semibold))
                        .contentTransition(.numericText())
                        .foregroundStyle(presentation.heroTint.color())
                }
            } minimal: {
                Image(systemName: presentation.heroPhase.systemImage)
                    .foregroundStyle(presentation.heroTint.color())
            }
            .widgetURL(presentation.deepLinkURL)
            .keylineTint(presentation.heroTint.color())
        }
    }

    /// What the expanded island leads with, in the center under the camera.
    private func islandHeadline(_ presentation: T3AgentActivityPresentation) -> String {
        if presentation.isStale { return "No recent update" }
        if presentation.isEscalated { return presentation.headline }
        if presentation.isAllDone {
            return presentation.hasFailure ? "Agent work failed" : "All agents done"
        }
        let count = presentation.activeCount
        return count == 1 ? "1 agent working" : "\(count) agents working"
    }
}

/// The app's mark: a "T3" set in the phase color. Stands in for a template
/// glyph, since the widget extension ships no asset catalog.
private struct T3ActivityMark: View {
    enum Size { case compact, expanded, card }

    let tint: Color
    let size: Size

    var body: some View {
        Text("T3")
            .font(font)
            .foregroundStyle(tint)
            .accessibilityLabel("T3 Code")
    }

    private var font: Font {
        switch size {
        case .compact: .system(.caption, design: .rounded).weight(.black)
        case .expanded: .system(.subheadline, design: .rounded).weight(.black)
        case .card: .system(.footnote, design: .rounded).weight(.black)
        }
    }
}

/// The explicit way into the thread that is waiting, rather than relying on a
/// tap anywhere on the card.
private struct T3OpenThreadLink: View {
    let url: URL

    var body: some View {
        Link(destination: url) {
            Label("Open Thread", systemImage: "arrow.up.forward.app")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(.white.opacity(0.14), in: Capsule())
        }
    }
}

private struct T3LiveActivityLockScreenView: View {
    let state: LiveActivityAttributes.ContentState
    let isStale: Bool

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    private var presentation: T3AgentActivityPresentation {
        T3AgentActivityPresentation(
            state: state,
            isLuminanceReduced: isLuminanceReduced,
            isStale: isStale
        )
    }

    private var isLightScheme: Bool { colorScheme == .light }

    var body: some View {
        let resolved = presentation
        return Group {
            if let escalated = resolved.escalatedRow, !resolved.isStale {
                escalatedBody(presentation: resolved, escalated: escalated)
            } else {
                fleetBody(presentation: resolved)
            }
        }
        .padding(15)
        // Translucent, so it tints the material the OS supplies rather than
        // fighting it. Nothing to escalate means no tint at all, so the system
        // material (Liquid Glass on iOS 26) shows instead of an opaque slab.
        .activityBackgroundTint(
            resolved.backgroundTint.map {
                Color(argb: $0.argb(isLightScheme: isLightScheme))
            }
        )
    }

    /// Blocked: one agent, large enough to read without picking the phone up,
    /// with the rest of the fleet demoted to a count.
    @ViewBuilder
    private func escalatedBody(
        presentation: T3AgentActivityPresentation,
        escalated: T3RelayAgentActivityAggregateRow
    ) -> some View {
        let tint = presentation.headerTint.color(isLightScheme: isLightScheme)
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                T3ActivityMark(tint: .primary, size: .card)
                Text(escalated.phase == .waitingForApproval ? "Approval needed" : "Waiting for your answer")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(tint)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let since = escalated.phaseSince {
                    // A calm mm:ss count, the format Timer and Maps use.
                    Text(since, style: .timer)
                        .font(.footnote.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                        .frame(maxWidth: 70, alignment: .trailing)
                }
            }

            HStack(spacing: 10) {
                Image(systemName: escalated.phase.systemImage)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(tint)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(escalated.threadTitle)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(escalated.projectTitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if let url = escalated.nativeDeepLinkURL {
                    Link(destination: url) {
                        Text("Open Thread")
                            .font(.footnote.weight(.semibold))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(tint.opacity(0.18), in: Capsule())
                    }
                    .foregroundStyle(.primary)
                }
            }

            if !presentation.footer.isEmpty {
                Text(presentation.footer)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private func fleetBody(presentation: T3AgentActivityPresentation) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                T3ActivityMark(tint: .primary, size: .card)
                Text(fleetHeadline(presentation))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if !presentation.isStale {
                    Image(systemName: presentation.heroPhase.systemImage)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(presentation.headerTint.color(isLightScheme: isLightScheme))
                        .accessibilityLabel(presentation.shortStatus)
                }
            }

            if presentation.rows.isEmpty {
                Text(presentation.subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            } else {
                ForEach(presentation.rows.prefix(4)) { row in
                    if let url = row.nativeDeepLinkURL {
                        Link(destination: url) {
                            T3LiveActivityRow(row: row, isLightScheme: isLightScheme, isStale: presentation.isStale)
                        }
                    } else {
                        T3LiveActivityRow(row: row, isLightScheme: isLightScheme, isStale: presentation.isStale)
                    }
                }
            }
        }
    }

    private func fleetHeadline(_ presentation: T3AgentActivityPresentation) -> String {
        if presentation.isStale {
            guard let lastUpdate = presentation.lastUpdate else { return "No recent update" }
            return "No update since \(lastUpdate.formatted(date: .omitted, time: .shortened))"
        }
        if presentation.isAllDone {
            return presentation.hasFailure ? "Agent work failed" : "All agents done"
        }
        return presentation.headline
    }
}

/// One agent: the phase glyph, the thread, and "project · status".
private struct T3LiveActivityRow: View {
    let row: T3RelayAgentActivityAggregateRow
    var isLightScheme = false
    var isStale = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: row.phase.systemImage)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(rowTint)
                .frame(width: 16)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(row.threadTitle)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.primary)
                Text("\(row.projectTitle) · \(row.status)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            Spacer(minLength: 0)
        }
        .opacity(isStale ? 0.6 : 1)
        .accessibilityElement(children: .combine)
    }

    private var rowTint: Color {
        T3AgentActivityTint.forPhase(row.phase, isLuminanceReduced: isStale).color(isLightScheme: isLightScheme)
    }
}

extension T3AgentActivityPresentation {
    /// The glyph every presentation keys off. `.stale` is the empty-aggregate
    /// fallback the pre-escalation card already used, and what a card the
    /// system marked stale shows.
    var heroPhase: T3AgentActivityPhase {
        isStale ? .stale : heroRow?.phase ?? .stale
    }
}

extension T3AgentActivityTint {
    /// Scheme-agnostic form for the Dynamic Island, which always renders on the
    /// device's own dark pill.
    func color() -> Color {
        color(isLightScheme: false)
    }

    func color(isLightScheme: Bool) -> Color {
        guard let rgb = rgb(isLightScheme: isLightScheme) else { return Color.secondary }
        return Color(argb: 0xFF00_0000 | rgb)
    }
}

extension Color {
    /// 0xAARRGGBB. The Live Activity palette is shared with the web sidebar's
    /// pills, so it travels as hex rather than as a per-platform asset.
    init(argb: UInt32) {
        self.init(
            .sRGB,
            red: Double((argb >> 16) & 0xFF) / 255,
            green: Double((argb >> 8) & 0xFF) / 255,
            blue: Double(argb & 0xFF) / 255,
            opacity: Double((argb >> 24) & 0xFF) / 255
        )
    }
}

extension T3AgentActivityPhase {
    /// Used by the home-screen widget, which renders on the system's own
    /// material where the semantic system colors already adapt correctly. The
    /// Live Activity uses the web-parity palette in `T3AgentActivityTint`
    /// instead, because it can also land on a light macOS material.
    var tint: Color {
        switch self {
        case .starting, .running:
            Color(uiColor: .systemBlue)
        case .waitingForApproval:
            Color(uiColor: .systemOrange)
        case .waitingForInput:
            Color(uiColor: .systemIndigo)
        case .completed:
            Color(uiColor: .systemGreen)
        case .failed:
            Color(uiColor: .systemRed)
        case .stale:
            Color.secondary
        }
    }
}
