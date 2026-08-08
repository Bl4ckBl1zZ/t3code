import SwiftUI

// Ported from apps/mobile/src/features/threads/TimelineSystemDivider.tsx, plus
// the day-divider label from packages/shared/src/orchestrationV2Timeline.ts.

/// Type roles and metrics the timeline chrome shares. The RN client works in
/// `text-3xs`/`text-2xs`/`text-xs`; those map onto the two smallest semantic
/// iOS sizes so the whole transcript still follows Dynamic Type.
enum ChatTimelineStyle {
    /// RN `text-3xs` — eyebrow labels inside the inspector.
    static let micro = Font.system(.caption2, design: .default)
    static let microStrong = Font.system(.caption2, design: .default, weight: .semibold)
    /// RN `text-2xs` — divider pills, badges, diffstats.
    static let small = Font.system(.caption2, design: .default)
    static let smallStrong = Font.system(.caption2, design: .default, weight: .medium)
    static let smallMono = Font.system(.caption2, design: .monospaced)
    /// RN `text-xs` — work-log row text.
    static let body = Font.system(.caption, design: .default)
    static let bodyStrong = Font.system(.caption, design: .default, weight: .medium)
    static let bodyMono = Font.system(.caption, design: .monospaced)

    static let hairline = T3Colors.border
    /// Bottom margin a timeline entry owns, so the feed can stack entries with
    /// zero spacing and still match the RN rhythm.
    static let entrySpacing: CGFloat = 16
}

/// A system boundary in the transcript: hairline — pill — hairline. Becomes a
/// button when `action` is set (e.g. "Open source conversation").
struct TimelineSystemDivider: View {
    enum Tone: Equatable { case neutral, danger }
    /// Stacked puts the detail on its own centred line under the label.
    enum Layout: Equatable { case inline, stacked }

    let label: String
    var detail: String?
    var tone: Tone = .neutral
    var symbol: String?
    var layout: Layout = .inline
    /// In-flight system work: swaps the symbol for a spinner.
    var busy: Bool = false
    var accessibilityActionLabel: String?
    var action: (() -> Void)?

    private var isDanger: Bool { tone == .danger }
    private var foreground: Color { isDanger ? T3Colors.danger : T3Colors.textSecondary }
    private var iconTint: Color { isDanger ? T3Colors.danger : T3Colors.textTertiary }

    var body: some View {
        HStack(spacing: 10) {
            hairline
            // Priority over the hairlines: they are infinitely greedy, and
            // without this the layout crushes the pill's labels into "Interr…"
            // instead of shortening the lines beside it.
            Group {
                if let action {
                    Button(action: action) { pill }
                        .buttonStyle(.plain)
                        .accessibilityLabel(accessibilityActionLabel ?? label)
                } else {
                    pill
                }
            }
            .layoutPriority(1)
            hairline
        }
        .padding(.bottom, ChatTimelineStyle.entrySpacing)
    }

    private var hairline: some View {
        Rectangle()
            .fill(ChatTimelineStyle.hairline)
            .frame(height: 1)
            .frame(maxWidth: .infinity)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var pill: some View {
        Group {
            if layout == .stacked {
                VStack(spacing: 2) {
                    HStack(spacing: 6) {
                        icon
                        labelText
                        trailingArrow
                    }
                    detailText
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(pillFill)
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .strokeBorder(pillStroke, lineWidth: 1)
                        )
                )
            } else {
                HStack(spacing: 6) {
                    icon
                    labelText
                    detailText
                    trailingArrow
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    Capsule(style: .continuous)
                        .fill(pillFill)
                        .overlay(Capsule(style: .continuous).strokeBorder(pillStroke, lineWidth: 1))
                )
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var icon: some View {
        if busy {
            // A system step that is still running (a handoff summary being
            // generated, say) reads as stalled without a live indicator.
            ProgressView()
                .controlSize(.mini)
                .tint(iconTint)
        } else if let symbol {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(iconTint)
        }
    }

    private var labelText: some View {
        Text(verbatim: label)
            .font(ChatTimelineStyle.smallStrong)
            .foregroundStyle(foreground)
            .lineLimit(1)
    }

    @ViewBuilder
    private var detailText: some View {
        // A detail that just repeats the label ("Interrupted  Interrupted")
        // adds noise, not information.
        if let detail, !detail.isEmpty, detail != label {
            Text(verbatim: detail)
                .font(ChatTimelineStyle.small)
                .foregroundStyle(T3Colors.textTertiary)
                .lineLimit(1)
                .truncationMode(.tail)
                // Bounded so a sentence-length message shortens itself instead
                // of eating the hairlines entirely.
                .frame(maxWidth: 220)
        }
    }

    @ViewBuilder
    private var trailingArrow: some View {
        if action != nil {
            Image(systemName: "arrow.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(T3Colors.textTertiary)
        }
    }

    private var pillFill: Color {
        isDanger ? T3Colors.danger.opacity(0.10) : T3Colors.surface
    }

    private var pillStroke: Color {
        isDanger ? T3Colors.danger.opacity(0.25) : T3Colors.border
    }
}

/// A boundary between calendar days, so a thread picked up over a week doesn't
/// read as one sitting.
struct TimelineDayDivider: View {
    let date: Date
    var now: Date = Date()

    var body: some View {
        TimelineSystemDivider(label: ThreadTimelineDay.label(for: date, now: now))
    }
}

/// Local calendar day bucketing for the transcript. Local rather than UTC: a
/// message sent at 23:30 belongs to the day the reader remembers sending it.
public enum ThreadTimelineDay {
    /// `yyyy-MM-dd` in the reader's own time zone.
    public static func key(for date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04d-%02d-%02d",
            parts.year ?? 0,
            parts.month ?? 0,
            parts.day ?? 0
        )
    }

    /// "Today" / "Yesterday" for the days a reader still holds in their head,
    /// and a dated label beyond that. The year only appears once it isn't the
    /// current one.
    public static func label(
        for date: Date,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        // Compared against the passed-in `now` rather than `isDateInToday`, so
        // the label stays a pure function of its inputs.
        let dayKey = key(for: date, calendar: calendar)
        if dayKey == key(for: now, calendar: calendar) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
            dayKey == key(for: yesterday, calendar: calendar) {
            return "Yesterday"
        }
        let sameYear = calendar.component(.year, from: date)
            == calendar.component(.year, from: now)
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate(sameYear ? "EEEdMMM" : "EEEdMMMy")
        return formatter.string(from: date)
    }

    /// Wire timestamps arrive as ISO-8601 strings, usually with fractional
    /// seconds but not always. An unparsable one drops the divider rather than
    /// the entry it was going to sit above.
    public static func date(fromISO8601 value: String) -> Date? {
        fractionalParser.date(from: value) ?? plainParser.date(from: value)
    }

    private static let fractionalParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plainParser = ISO8601DateFormatter()

    /// Indexes of the entries that need a day divider immediately above them.
    /// The first dated entry never gets one — there is nothing above it to
    /// separate from. Entries with no timestamp neither break nor continue a
    /// run, matching the RN feed.
    public static func dividerIndexes<Element>(
        _ entries: [Element],
        calendar: Calendar = .current,
        date: (Element) -> Date?
    ) -> [Int] {
        var indexes: [Int] = []
        var previousKey: String?
        for (index, entry) in entries.enumerated() {
            guard let entryDate = date(entry) else { continue }
            let dayKey = key(for: entryDate, calendar: calendar)
            if let previousKey, previousKey != dayKey {
                indexes.append(index)
            }
            previousKey = dayKey
        }
        return indexes
    }
}
