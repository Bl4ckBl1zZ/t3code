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
            Text(ThreadDetailsBackgroundTasks.capsuleLabel(summary, nowMilliseconds: nowMilliseconds))
                .font(T3Typography.supportingStrong)
                .foregroundStyle(labelColor)
                .monospacedDigit()
                .lineLimit(1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(minHeight: 48)
        .t3GlassEffect(.regular, in: collapsedShape)
        .overlay { collapsedShape.stroke(T3Colors.border, lineWidth: 1) }
        .contentShape(collapsedShape)
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
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: 17, height: 17)
    }

    /// A parked monitor is grey: nothing is burning, and painting it the same
    /// live blue as a running command would overstate what the thread is doing.
    private var tint: Color {
        if summary.reportsOutcome, let outcome = summary.outcome {
            return outcome.tone == .danger ? T3Colors.danger : T3Colors.warning
        }
        if summary.variant == .monitor { return T3Colors.textTertiary }
        return summary.paused ? T3Colors.statusRunning.opacity(0.5) : T3Colors.statusRunning
    }

    /// The count and the clock are primary text; only an ending borrows the
    /// glyph's colour, because that is the one case where the words are the
    /// warning rather than a measurement.
    private var labelColor: Color {
        summary.reportsOutcome ? tint : T3Colors.textPrimary
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

    private let diameter: CGFloat = 17
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

    // Qualified: `Environment` is this app's own model type (Core/Models.swift).
    @SwiftUI.Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                ThreadDetailsSection(title: "Background Tasks") {
                    ForEach(Array(processes.enumerated()), id: \.element.id) { index, process in
                        if index > 0 { ThreadDetailsDivider() }
                        ThreadDetailsBackgroundTaskRow(process: process)
                    }
                }
                .padding(16)
            }
            .background(T3Colors.background)
            .navigationTitle("Background")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
