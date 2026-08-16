import ActivityKit
import SwiftUI
import WidgetKit

struct T3TaskLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LiveActivityAttributes.self) { context in
            // The tint and the escalation layout depend on `isLuminanceReduced`
            // and `colorScheme`, which only exist inside the view, so the
            // background tint is applied one level in rather than here.
            T3LiveActivityLockScreenView(state: context.state)
                .activitySystemActionForegroundColor(Color(uiColor: .label))
                .widgetURL(T3AgentActivityPresentation(state: context.state).deepLinkURL)
        } dynamicIsland: { context in
            let presentation = T3AgentActivityPresentation(state: context.state)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 5) {
                        Text("T3")
                            .font(.system(size: 14, weight: .black, design: .rounded))
                        Text(presentation.isAllDone
                            ? presentation.doneLabel
                            : "\(presentation.activeCount)")
                            .font(.system(size: 13, weight: .bold))
                    }
                    .foregroundStyle(presentation.heroTint.color())
                    .padding(.leading, 4)
                }

                DynamicIslandExpandedRegion(.trailing) {
                    Label(
                        presentation.shortStatus,
                        systemImage: presentation.heroPhase.systemImage
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(presentation.headerTint.color())
                    .lineLimit(1)
                    .padding(.trailing, 4)
                }

                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(presentation.rows.prefix(3)) { row in
                            T3LiveActivityRow(row: row)
                        }
                        if presentation.rows.isEmpty {
                            Text(presentation.subtitle)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.bottom, 2)
                }
            } compactLeading: {
                Text("T3")
                    .font(.system(size: 11, weight: .black, design: .rounded))
                    .foregroundStyle(presentation.heroTint.color())
            } compactTrailing: {
                // Glyph + bare count rather than a word: the compact
                // presentation also renders in landscape, where it cannot grow
                // in width, and "Approval" was the first thing to get clipped.
                if presentation.isEscalated {
                    HStack(spacing: 3) {
                        Image(systemName: presentation.heroPhase.systemImage)
                        if presentation.attentionCount > 1 {
                            Text("\(presentation.attentionCount)")
                                .font(.system(size: 11, weight: .semibold))
                        }
                    }
                    .foregroundStyle(presentation.headerTint.color())
                } else {
                    Text(presentation.isAllDone
                        ? presentation.doneLabel
                        : "\(presentation.activeCount)")
                        .font(.system(size: 11, weight: .semibold))
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
}

private struct T3LiveActivityLockScreenView: View {
    let state: LiveActivityAttributes.ContentState

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    private var presentation: T3AgentActivityPresentation {
        T3AgentActivityPresentation(state: state, isLuminanceReduced: isLuminanceReduced)
    }

    private var isLightScheme: Bool { colorScheme == .light }

    var body: some View {
        let resolved = presentation
        return Group {
            if let escalated = resolved.escalatedRow {
                escalatedBody(presentation: resolved, escalated: escalated)
            } else {
                fleetBody(presentation: resolved)
            }
        }
        .padding(15)
        // Translucent, so it tints the material the OS supplies rather than
        // fighting it, and absent under reduced luminance.
        .activityBackgroundTint(
            resolved.backgroundTint.map {
                Color(argb: $0.argb(isLightScheme: isLightScheme))
            } ?? Color(uiColor: .systemBackground)
        )
    }

    /// Blocked: one agent, large enough to read without picking the phone up,
    /// with the rest of the fleet demoted to a count.
    @ViewBuilder
    private func escalatedBody(
        presentation: T3AgentActivityPresentation,
        escalated: T3RelayAgentActivityAggregateRow
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                Text("T3 Code")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.primary)
                Text(presentation.headline)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(presentation.headerTint.color(isLightScheme: isLightScheme))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }

            HStack(spacing: 10) {
                Image(systemName: escalated.phase.systemImage)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(presentation.headerTint.color(isLightScheme: isLightScheme))
                    .frame(width: 24, height: 24)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(escalated.threadTitle)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        Text(escalated.projectTitle)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        // Rendered together so the separator cannot dangle when
                        // a row carries a timestamp we could not parse.
                        if let since = escalated.phaseSince {
                            Text("·")
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                            Text(since, style: .relative)
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                Spacer(minLength: 8)
                Text(escalated.status)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(presentation.headerTint.color(isLightScheme: isLightScheme))
                    .layoutPriority(1)
            }

            if !presentation.footer.isEmpty {
                Text(presentation.footer)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private func fleetBody(presentation: T3AgentActivityPresentation) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                Text("T3 Code")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.primary)
                Spacer(minLength: 8)
                Label(
                    presentation.shortStatus,
                    systemImage: presentation.heroPhase.systemImage
                )
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(presentation.headerTint.color(isLightScheme: isLightScheme))
                .lineLimit(1)
            }

            if presentation.rows.isEmpty {
                Text(presentation.subtitle)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            } else {
                ForEach(presentation.rows.prefix(4)) { row in
                    T3LiveActivityRow(row: row, isLightScheme: isLightScheme)
                }
            }
        }
    }
}

private struct T3LiveActivityRow: View {
    let row: T3RelayAgentActivityAggregateRow
    var isLightScheme = false

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: row.phase.systemImage)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(rowTint)
                .frame(width: 14)
            Text(row.threadTitle)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Text(row.projectTitle)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 6)
            Text(row.status)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(rowTint)
                .lineLimit(1)
                .layoutPriority(1)
        }
    }

    private var rowTint: Color {
        T3AgentActivityTint.forPhase(row.phase).color(isLightScheme: isLightScheme)
    }
}

extension T3AgentActivityPresentation {
    /// The glyph every presentation keys off. `.stale` is the empty-aggregate
    /// fallback the pre-escalation card already used.
    var heroPhase: T3AgentActivityPhase {
        heroRow?.phase ?? .stale
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
