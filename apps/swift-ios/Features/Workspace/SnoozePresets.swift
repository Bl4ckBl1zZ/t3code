import Foundation

// Ported from packages/client-runtime/src/state/threadSettled.ts
// (`resolveSnoozePresets`).
//
// The presets are the shared "snooze until" choices every client offers, so
// the same wake times never read differently per client: 1 hour, 3 hours,
// this evening (only while it is meaningfully before evening), tomorrow
// morning, and next Monday morning.

public struct SnoozePreset: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    /// Menu-row time column. Complements the label instead of repeating it:
    /// "Tomorrow" pairs with "9:00 AM", not "tomorrow 9:00 AM".
    public let whenLabel: String
    /// Wake time.
    public let snoozedUntil: Date
}

public enum SnoozePresets {
    private static let eveningHour = 18
    private static let morningHour = 9

    /// Row id namespace, so the collection view can route any preset tap back
    /// here without a case per preset.
    public static let actionIDPrefix = "snooze:"

    public static func actionID(for preset: SnoozePreset) -> String {
        actionIDPrefix + preset.id
    }

    /// The wake time a preset action id resolves to, recomputed at tap time so
    /// a menu that sat open (or a cell that sat rendered) never snoozes to a
    /// stale clock.
    public static func snoozedUntil(
        actionID: String,
        now: Date = .now,
        calendar: Calendar = .current
    ) -> Date? {
        guard actionID.hasPrefix(actionIDPrefix) else { return nil }
        let presetID = String(actionID.dropFirst(actionIDPrefix.count))
        return resolve(now: now, calendar: calendar).first { $0.id == presetID }?.snoozedUntil
    }

    /// "This evening" only appears while it is meaningfully before evening;
    /// after that the calendar choices start at "Tomorrow".
    public static func resolve(
        now: Date = .now,
        calendar: Calendar = .current
    ) -> [SnoozePreset] {
        let inAnHour = now.addingTimeInterval(60 * 60)
        let inThreeHours = now.addingTimeInterval(3 * 60 * 60)
        var presets: [SnoozePreset] = [
            SnoozePreset(
                id: "hour",
                label: "In 1 hour",
                whenLabel: timeOfDayLabel(inAnHour),
                snoozedUntil: inAnHour
            ),
            SnoozePreset(
                id: "three-hours",
                label: "In 3 hours",
                whenLabel: timeOfDayLabel(inThreeHours),
                snoozedUntil: inThreeHours
            ),
        ]

        if let evening = atHour(eveningHour, of: now, calendar: calendar),
            evening.timeIntervalSince(now) > 60 * 60
        {
            presets.append(
                SnoozePreset(
                    id: "evening",
                    label: "This evening",
                    whenLabel: timeOfDayLabel(evening),
                    snoozedUntil: evening
                )
            )
        }

        // Calendar-day advance instead of a fixed second offset: fixed offsets
        // land on the wrong local day across DST transitions (a spring-forward
        // day is 23 hours, so 23:30 + 24h skips the whole next day).
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now)
            .flatMap { atHour(morningHour, of: $0, calendar: calendar) }
        if let tomorrow {
            presets.append(
                SnoozePreset(
                    id: "tomorrow",
                    label: "Tomorrow",
                    whenLabel: timeOfDayLabel(tomorrow),
                    snoozedUntil: tomorrow
                )
            )
        }

        // weekday is 1-based with Sunday = 1, so Monday = 2; `|| 7` keeps a
        // Monday pointing at next Monday rather than itself.
        let weekday = calendar.component(.weekday, from: now)
        var daysUntilMonday = (2 - weekday + 7) % 7
        if daysUntilMonday == 0 { daysUntilMonday = 7 }
        if let mondayDay = calendar.date(byAdding: .day, value: daysUntilMonday, to: now),
            let nextWeek = atHour(morningHour, of: mondayDay, calendar: calendar),
            nextWeek != tomorrow
        {
            presets.append(
                SnoozePreset(
                    id: "next-week",
                    label: "Next week",
                    whenLabel: "\(weekdayLabel(nextWeek)) \(timeOfDayLabel(nextWeek))",
                    snoozedUntil: nextWeek
                )
            )
        }

        return presets
    }

    private static func atHour(_ hour: Int, of base: Date, calendar: Calendar) -> Date? {
        calendar.date(bySettingHour: hour, minute: 0, second: 0, of: base)
    }

    private static func timeOfDayLabel(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }

    private static func weekdayLabel(_ date: Date) -> String {
        date.formatted(Date.FormatStyle().weekday(.abbreviated))
    }
}
