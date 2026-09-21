import SwiftUI

/// The transcript bar's right-hand capsule: what this thread left running in the
/// background, in the space a glance can spend on it.
///
/// The left-hand capsule reports agents — work the thread delegated. This
/// reports work the thread launched and walked away from: a build, a dev server,
/// a monitor parked on a condition. Both are things happening while the reader
/// is looking at something else, which is why they share a bar.
///
/// They are two capsules rather than one split pill because they answer to two
/// different sheets. A single button spanning both would have to send every tap
/// to whichever destination won the coin toss, and a divider inside a button
/// looks tappable without being so.
///
/// Mirrors apps/web/src/components/chat/BackgroundProcessesControl.tsx, the
/// strip above the desktop composer.
struct ThreadBackgroundTasksCapsule: View {
    let summary: ThreadBackgroundSummary
    let nowMilliseconds: Int
    let processes: [ThreadDetailsBackgroundProcess]

    @State private var isSheetPresented = false

    var body: some View {
        Button {
            isSheetPresented = true
        } label: {
            collapsedLabel
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            ThreadDetailsBackgroundTasks.capsuleAccessibilityLabel(
                summary, nowMilliseconds: nowMilliseconds
            )
        )
        .accessibilityIdentifier("thread-background-tasks-capsule")
        .sheet(isPresented: $isSheetPresented) {
            ThreadBackgroundTasksSheet(processes: processes)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // MARK: Collapsed

    /// Geometry is the agents capsule's, to the point: the two sit on one line
    /// and any difference in height or corner reads as a mistake rather than as
    /// a distinction. `ThreadRelationshipsBanner.collapsedLabel` is the origin of
    /// every number here.
    private var collapsedLabel: some View {
        HStack(spacing: 7) {
            glyph
            Text(label)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(labelColor)
                .monospacedDigit()
                .lineLimit(1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(minHeight: 48)
        .t3GlassEffect(.regular, interactive: true, in: collapsedShape)
        .t3GlassRim(in: collapsedShape)
        .contentShape(collapsedShape)
    }

    /// Several tasks get their noun: a bare "3" beside a glyph read as a
    /// duration as easily as a count.
    private var label: String {
        if !summary.reportsOutcome, summary.solitary == nil, summary.count > 1 {
            return "\(summary.count) tasks"
        }
        return ThreadDetailsBackgroundTasks.capsuleLabel(summary, nowMilliseconds: nowMilliseconds)
    }

    private var collapsedShape: Capsule {
        Capsule(style: .continuous)
    }

    @ViewBuilder
    private var glyph: some View {
        switch ThreadDetailsBackgroundTasks.capsuleGlyph(summary, nowMilliseconds: nowMilliseconds) {
        case .command:
            symbol("terminal")
        case let .deadline(fraction):
            DeadlineRing(fraction: fraction, color: tint)
        case .asleep:
            symbol("moon.zzz.fill")
        case .outcome:
            symbol("terminal")
        }
    }

    private func symbol(_ name: String) -> some View {
        Image(systemName: name)
            .font(.footnote.weight(.medium))
            .foregroundStyle(tint)
            .frame(minWidth: 17, minHeight: 17)
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

    @ScaledMetric(relativeTo: .footnote) private var diameter: CGFloat = 17
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

/// The capsule's destination: the same rows the thread details sheet lists under
/// "Background Tasks", without the four-row ceiling that section needs to stay
/// proportionate to the sections around it. Here they are the entire subject, so
/// truncating them would only hide the thing the reader tapped to see.
private struct ThreadBackgroundTasksSheet: View {
    let processes: [ThreadDetailsBackgroundProcess]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(processes, id: \.id) { process in
                        ThreadDetailsBackgroundTaskRow(process: process)
                            .t3GroupedRow()
                    }
                }
            }
            .listStyle(.insetGrouped)
            .t3GroupedListBackground()
            .navigationTitle("Background Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(.close)
        }
    }
}
