import SwiftUI

/// The activity pill's background half: what this thread left running, in the
/// space a glance can spend on it — a build, a dev server, a monitor parked on
/// a condition. The agents half reports work the thread delegated; this reports
/// work it launched and walked away from.
///
/// Only the label: the pill is the button, and the activity sheet lists the
/// rows behind it.
///
/// Mirrors apps/web/src/components/chat/BackgroundProcessesControl.tsx, the
/// strip above the desktop composer.
struct ThreadBackgroundSegment: View {
    let summary: ThreadBackgroundSummary
    let nowMilliseconds: Int

    var body: some View {
        HStack(spacing: 6) {
            glyph
            Text(label)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(labelColor)
                .monospacedDigit()
                .lineLimit(1)
        }
    }

    /// Several tasks get their noun: a bare "3" beside a glyph read as a
    /// duration as easily as a count.
    private var label: String {
        if !summary.reportsOutcome, summary.solitary == nil, summary.count > 1 {
            return "\(summary.count) tasks"
        }
        return ThreadDetailsBackgroundTasks.capsuleLabel(summary, nowMilliseconds: nowMilliseconds)
    }

    @ViewBuilder
    private var glyph: some View {
        switch ThreadDetailsBackgroundTasks.capsuleGlyph(summary, nowMilliseconds: nowMilliseconds) {
        case .command, .outcome:
            symbol("terminal")
        case let .deadline(fraction):
            DeadlineRing(fraction: fraction, color: tint)
        case .asleep:
            symbol("moon.zzz.fill")
        }
    }

    private func symbol(_ name: String) -> some View {
        Image(systemName: name)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .frame(minWidth: 15, minHeight: 15)
    }

    private var tint: Color {
        ThreadBackgroundTint.color(
            live: !summary.reportsOutcome,
            ending: summary.outcome?.tone,
            monitor: summary.variant == .monitor,
            paused: summary.paused
        )
    }

    /// The count and the clock are primary text; only an ending borrows the
    /// glyph's colour, because that is the one case where the words are the
    /// warning rather than a measurement.
    private var labelColor: Color {
        summary.reportsOutcome ? tint : T3Colors.textPrimary
    }
}

/// The colour of a background glyph, shared by the capsule and the rows behind
/// it so the two cannot disagree about what a state looks like.
///
/// A parked monitor is grey: nothing is burning, and painting it the same live
/// blue as a running command would overstate what the thread is doing. Once the
/// work stops only a bad ending keeps a colour; a clean exit goes neutral.
enum ThreadBackgroundTint {
    static func color(
        live: Bool,
        ending: ThreadBackgroundOutcomeTone?,
        monitor: Bool,
        paused: Bool
    ) -> Color {
        guard live else {
            switch ending {
            case .danger: return T3Colors.danger
            case .warning: return T3Colors.warning
            case nil: return T3Colors.textSecondary
            }
        }
        if monitor { return T3Colors.textTertiary }
        return paused ? T3Colors.statusRunning.opacity(0.5) : T3Colors.statusRunning
    }
}

/// Determinate progress toward a declared deadline.
///
/// The ring is drawn rather than borrowed from a symbol because it has to show a
/// fraction, and it degrades to a plain dot when the fraction is unknown — an
/// arc drawn from a guess would be a claim the reader has no way to check.
private struct DeadlineRing: View {
    let fraction: Double?
    let color: Color

    @ScaledMetric(relativeTo: .footnote) private var diameter: CGFloat = 15
    private let lineWidth: CGFloat = 2

    var body: some View {
        ZStack {
            Circle()
                .stroke(color.opacity(0.22), lineWidth: lineWidth)
            if let fraction {
                Circle()
                    .trim(from: 0, to: max(0.02, fraction))
                    .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            Circle()
                .fill(color)
                .frame(width: 5, height: 5)
        }
        .frame(width: diameter, height: diameter)
        .accessibilityHidden(true)
    }
}
