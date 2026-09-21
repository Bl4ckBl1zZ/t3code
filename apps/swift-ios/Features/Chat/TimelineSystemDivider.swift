import SwiftUI

// Ported from apps/mobile/src/features/threads/TimelineSystemDivider.tsx, plus
// the day-divider label from packages/shared/src/orchestrationV2Timeline.ts.

/// Type roles and metrics the timeline chrome shares. Rows read at subheadline
/// beside a 17pt body, metadata at caption; the web's dense `text-xs` rhythm
/// read like a log file on a phone. Everything follows Dynamic Type.
enum ChatTimelineStyle {
    /// Eyebrow labels inside the inspector.
    static let micro = Font.system(.caption2, design: .default)
    static let microStrong = Font.system(.caption2, design: .default, weight: .semibold)
    /// Divider labels, badges, diffstats.
    static let small = Font.system(.caption, design: .default)
    static let smallStrong = Font.system(.caption, design: .default, weight: .medium)
    static let smallMono = Font.system(.caption, design: .monospaced)
    /// Work-log row text.
    static let body = Font.system(.subheadline, design: .default)
    static let bodyStrong = Font.system(.subheadline, design: .default, weight: .medium)
    static let bodyMono = Font.system(.subheadline, design: .monospaced)

    static let hairline = T3Colors.border
    /// Bottom margin a timeline entry owns, so the feed can stack entries with
    /// zero spacing and still match the RN rhythm.
    static let entrySpacing: CGFloat = 16
}

/// A system boundary in the transcript: hairline, a quiet caption label,
/// hairline. Becomes a full-width row button when `action` is set (e.g. "Open
/// source conversation"), because a boundary you can tap has to look like it.
struct TimelineSystemDivider: View {
    enum Tone: Equatable { case neutral, danger }
    /// Stacked puts the detail on its own centred line under the label.
    enum Layout: Equatable { case inline, stacked }

    let label: String
    var detail: String?
    var tone: Tone = .neutral
    var symbol: String?
    var layout: Layout = .inline
    /// In-flight system work. Static on purpose: the composer band already
    /// shows live work, and a spinner here would repaint for as long as the
    /// step takes.
    var busy: Bool = false
    var accessibilityActionLabel: String?
    var action: (() -> Void)?

    private var isDanger: Bool { tone == .danger }
    private var foreground: Color { isDanger ? T3Colors.danger : T3Colors.textSecondary }
    private var iconTint: Color { isDanger ? T3Colors.danger : T3Colors.textTertiary }

    var body: some View {
        Group {
            if let action {
                Button(action: action) { linkRow }
                    .buttonStyle(.plain)
                    .accessibilityLabel(accessibilityActionLabel ?? label)
            } else {
                HStack(spacing: 10) {
                    hairline
                    // Priority over the hairlines: they are infinitely greedy,
                    // and without this the layout crushes the label into
                    // "Interr…" instead of shortening the lines beside it.
                    labelStack
                        .layoutPriority(1)
                    hairline
                }
            }
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
    private var labelStack: some View {
        Group {
            if layout == .stacked {
                VStack(spacing: 2) {
                    HStack(spacing: 6) {
                        icon
                        labelText
                    }
                    detailText
                }
            } else {
                HStack(spacing: 6) {
                    icon
                    labelText
                    detailText
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// The one tappable boundary (a fork's source) as a row: accent label and
    /// a chevron at a 44pt target, where a pill had an arrow as its only hint.
    private var linkRow: some View {
        HStack(spacing: 8) {
            icon
            labelText
                .foregroundStyle(T3Colors.accent)
            detailText
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(ChatTimelineStyle.small.weight(.semibold))
                .foregroundStyle(T3Colors.textTertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget)
        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder
    private var icon: some View {
        if let symbol {
            Image(systemName: symbol)
                .font(ChatTimelineStyle.small.weight(.medium))
                .foregroundStyle(iconTint)
                .accessibilityHidden(true)
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
                .frame(maxWidth: 260)
        }
    }
}

/// A boundary between calendar days, so a thread picked up over a week doesn't
/// read as one sitting. A plain centred caption, like Messages: the day in
/// bold and the time of the first thing said on it. A pill read as an event.
struct TimelineDayDivider: View {
    let date: Date
    var now: Date = Date()

    var body: some View {
        (Text(verbatim: ThreadTimelineDay.label(for: date, now: now)).fontWeight(.semibold)
            + Text(verbatim: " " + date.formatted(date: .omitted, time: .shortened)))
            .font(ChatTimelineStyle.small)
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.bottom, ChatTimelineStyle.entrySpacing)
            .accessibilityAddTraits(.isHeader)
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
        // A format style rather than a `DateFormatter` built per call: this
        // runs for every divider on every feed rebuild.
        var style = Date.FormatStyle.dateTime.weekday(.abbreviated).day().month(.abbreviated)
        if !sameYear { style = style.year() }
        style.locale = locale
        style.calendar = calendar
        style.timeZone = calendar.timeZone
        return date.formatted(style)
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
