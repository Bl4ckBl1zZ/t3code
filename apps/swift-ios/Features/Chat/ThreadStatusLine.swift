import SwiftUI

/// One quiet line after the last message for thread state that does not change
/// what Send does: snoozed or settled. Sending a message clears each of them,
/// so the action is only the explicit way out. Mirrors web's ThreadStatusLine.
struct ThreadStatusLine: Equatable {
    enum Kind: Equatable { case snoozed, settled }

    let kind: Kind
    let label: String

    /// Changes with the label, so a new time or state is a new row.
    var id: String { "\(kind):\(label)" }
    var actionLabel: String { kind == .snoozed ? "Wake now" : "Un-settle" }
    var busyLabel: String { kind == .snoozed ? "Waking…" : "Un-settling…" }
    var systemImage: String { kind == .snoozed ? "moon.zzz" : "checkmark.circle" }

    /// Snoozed wins over settled, as on web. Nil for a thread that is neither,
    /// or whose server cannot shelve it that way.
    static func resolve(_ thread: FeatureThread, now: Date) -> ThreadStatusLine? {
        guard !thread.isArchived else { return nil }
        if thread.canShelveSnoozed, thread.isEffectivelySnoozed(at: now), let until = thread.snoozedUntil {
            return ThreadStatusLine(kind: .snoozed, label: "Snoozed, \(relative(until, now: now))")
        }
        if thread.canShelveSettled, thread.isEffectivelySettled(at: now) {
            return ThreadStatusLine(
                kind: .settled,
                label: thread.settledAt.map { "Settled \(relative($0, now: now))" } ?? "Settled"
            )
        }
        return nil
    }

    /// "2d ago", "in 3h".
    private static func relative(_ date: Date, now: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: now)
    }
}

/// The line itself: glyph, label, and the way out as a quiet inline button.
struct ThreadStatusLineView: View {
    let line: ThreadStatusLine
    let action: () async -> Void
    @State private var isBusy = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: line.systemImage)
                .accessibilityHidden(true)
            Text(verbatim: line.label)
                .lineLimit(1)
            Text(verbatim: "·")
                .accessibilityHidden(true)
            Button(isBusy ? line.busyLabel : line.actionLabel) {
                isBusy = true
                Task {
                    await action()
                    isBusy = false
                }
            }
            .buttonStyle(.plain)
            .fontWeight(.medium)
            .disabled(isBusy)
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
            Spacer(minLength: 0)
        }
        .font(ChatTimelineStyle.small)
        .foregroundStyle(T3Colors.textTertiary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread-status-line")
    }
}
