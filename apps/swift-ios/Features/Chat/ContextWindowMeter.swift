import SwiftUI

// The composer's context ring and its detail popover. Ports
// apps/web/src/components/chat/ContextWindowMeter.tsx and its `.logic.ts`.

/// What the composer's context ring shows, and the compaction it can start.
struct ComposerContextMeter {
    var window: ThreadContextWindow
    /// The thread's model, for the auto-compaction note.
    var modelName: String?
    /// Nil when the provider cannot compact on request (only Claude can).
    var compaction: Compaction?

    struct Compaction {
        /// Why Compact Now is off right now; nil while it can run.
        var disabledReason: String?
        var run: () -> Void
    }
}

enum ContextWindowFormat {
    /// Percent of the window used, 0...100, when its size is known.
    static func usedPercentage(_ window: ThreadContextWindow) -> Double? {
        guard let max = window.maxTokens, max > 0 else { return nil }
        return min(100, Double(window.usedTokens) / Double(max) * 100)
    }

    /// "4.2%" below ten, whole percents above, as web shows them.
    static func percentage(_ value: Double) -> String {
        guard value.isFinite else { return "" }
        if value < 10 {
            let rounded = (value * 10).rounded() / 10
            return rounded == rounded.rounded()
                ? "\(Int(rounded))%"
                : String(format: "%.1f%%", rounded)
        }
        return "\(Int(value.rounded()))%"
    }

    /// "950", "4.2k", "84k", "1.2m": token counts at a glance.
    static func tokens(_ value: Int) -> String {
        let number = Double(value)
        func trimmed(_ scaled: Double, _ suffix: String) -> String {
            let rounded = (scaled * 10).rounded() / 10
            return rounded == rounded.rounded()
                ? "\(Int(rounded))\(suffix)"
                : String(format: "%.1f", rounded) + suffix
        }
        switch value {
        case ..<1_000: return "\(max(0, value))"
        case ..<10_000: return trimmed(number / 1_000, "k")
        case ..<1_000_000: return "\(Int((number / 1_000).rounded()))k"
        default: return trimmed(number / 1_000_000, "m")
        }
    }

    static func compactionNote(modelName: String?, threshold: Int?) -> String {
        if let threshold, threshold > 0 {
            return "Compacts automatically at \(threshold.formatted(.number.grouping(.automatic))) tokens."
        }
        if let modelName, !modelName.isEmpty {
            return "Context for \(modelName) compacts automatically when needed."
        }
        return "Context compacts automatically when needed."
    }

    /// Past 90% the ring turns to the danger color, as web's does.
    static func isNearlyFull(_ window: ThreadContextWindow) -> Bool {
        (usedPercentage(window) ?? 0) > 90
    }
}

/// How full the model's context window is. A readout rather than a setting:
/// tapping it shows the exact figures and, for a provider that can, a way to
/// compact now. Static: the ring only moves when a new usage report lands.
struct ContextWindowMeterButton: View {
    let meter: ComposerContextMeter

    @State private var showsDetail = false

    private var window: ThreadContextWindow { meter.window }
    private var percentage: Double? { ContextWindowFormat.usedPercentage(window) }

    var body: some View {
        Button {
            showsDetail = true
        } label: {
            ZStack {
                Circle()
                    .stroke(T3Colors.border, lineWidth: 2)
                Circle()
                    .trim(from: 0, to: (percentage ?? 0) / 100)
                    .stroke(
                        ContextWindowFormat.isNearlyFull(window) ? T3Colors.danger : T3Colors.textSecondary,
                        style: StrokeStyle(lineWidth: 2, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 18, height: 18)
            .frame(width: 32, height: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showsDetail) {
            ContextWindowDetail(meter: meter, onCompact: {
                showsDetail = false
                meter.compaction?.run()
            })
            .presentationCompactAdaptation(.popover)
        }
        .accessibilityLabel("Context window")
        .accessibilityValue(accessibilityValue)
        .accessibilityHint("Shows context usage\(meter.compaction == nil ? "" : " and compaction").")
        .accessibilityIdentifier("composer-context-meter")
    }

    private var accessibilityValue: String {
        if let percentage {
            return "\(ContextWindowFormat.percentage(percentage)) used"
        }
        return "\(ContextWindowFormat.tokens(window.usedTokens)) tokens used"
    }
}

private struct ContextWindowDetail: View {
    let meter: ComposerContextMeter
    let onCompact: () -> Void

    private var window: ThreadContextWindow { meter.window }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text("Context Window")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer(minLength: 0)
                Text(verbatim: usageSummary)
                    .font(T3Typography.supporting.monospacedDigit())
                    .foregroundStyle(T3Colors.textPrimary)
            }
            if let percentage = ContextWindowFormat.usedPercentage(window) {
                ProgressView(value: percentage, total: 100)
                    .tint(ContextWindowFormat.isNearlyFull(window) ? T3Colors.danger : T3Colors.textSecondary)
                    .accessibilityLabel("Context window usage")
                    .accessibilityValue(ContextWindowFormat.percentage(percentage))
            }
            if let total = window.totalProcessedTokens, total > 0 {
                HStack {
                    Text("Total processed")
                    Spacer(minLength: 8)
                    Text(verbatim: ContextWindowFormat.tokens(total)).monospacedDigit()
                }
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
            }
            if window.compactsAutomatically == true {
                Text(ContextWindowFormat.compactionNote(
                    modelName: meter.modelName,
                    threshold: window.autoCompactThreshold
                ))
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            if let compaction = meter.compaction {
                Button(action: onCompact) {
                    Label("Compact Now", systemImage: "arrow.down.right.and.arrow.up.left")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .tint(T3Colors.textPrimary)
                .disabled(compaction.disabledReason != nil)
                .accessibilityHint("Summarizes the conversation so far to free up context.")
                if let reason = compaction.disabledReason {
                    Text(reason)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(16)
        .frame(minWidth: 240, idealWidth: 280, maxWidth: 320, alignment: .leading)
    }

    private var usageSummary: String {
        let used = ContextWindowFormat.tokens(window.usedTokens)
        guard let max = window.maxTokens, let percentage = ContextWindowFormat.usedPercentage(window) else {
            return used
        }
        return "\(ContextWindowFormat.percentage(percentage)) · \(used)/\(ContextWindowFormat.tokens(max))"
    }
}
