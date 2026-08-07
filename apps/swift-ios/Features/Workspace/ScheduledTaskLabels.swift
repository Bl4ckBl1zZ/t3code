import Foundation

// Ported from apps/mobile/src/features/settings/automations/scheduledTaskLabels.ts
// so an automation reads the same on every client. The server owns the schedule
// arithmetic; these are presentation-only labels over what it reports.

/// Weekday numbering matches the wire contract, where 0 is Sunday. Modelling it
/// as an enum keeps the out-of-range days the contract forbids unrepresentable
/// instead of indexing a label table with an unchecked integer.
public enum ScheduledTaskWeekday: Int, CaseIterable, Equatable, Sendable {
    case sunday = 0
    case monday
    case tuesday
    case wednesday
    case thursday
    case friday
    case saturday

    fileprivate var shortLabel: String {
        switch self {
        case .sunday: "Sun"
        case .monday: "Mon"
        case .tuesday: "Tue"
        case .wednesday: "Wed"
        case .thursday: "Thu"
        case .friday: "Fri"
        case .saturday: "Sat"
        }
    }

    fileprivate var isWeekend: Bool {
        self == .sunday || self == .saturday
    }
}

public enum ScheduledTaskSchedule: Equatable, Sendable {
    case interval(everyMs: Int)
    /// `timeOfDay` is a wall-clock "HH:MM" the server resolves in its own zone,
    /// so it is echoed verbatim rather than reformatted against a device locale.
    /// `nil` weekdays means every day.
    case fixedTime(timeOfDay: String, weekdays: [ScheduledTaskWeekday]? = nil)
}

public enum ScheduledTaskRunStatus: String, Equatable, Sendable {
    case never
    case running
    case succeeded
    case failed
}

/// Weight of the status dot beside a row. The web and React Native clients name
/// Tailwind colours here; SwiftUI resolves the tone against the theme instead,
/// so the port keeps the four-way distinction without the class strings.
public enum ScheduledTaskStatusTone: Equatable, Sendable {
    /// Never run: dimmed rather than coloured, so it reads as absence of state.
    case dormant
    case running
    case success
    case danger
}

/// The fields a row subtitle reads. Deliberately narrower than the full
/// scheduled-task record so callers can render a subtitle from a partial decode.
public struct ScheduledTaskSummary: Equatable, Sendable {
    public let enabled: Bool
    public let schedule: ScheduledTaskSchedule
    public let nextRunAt: String?
    public let lastRunStatus: ScheduledTaskRunStatus

    public init(
        enabled: Bool,
        schedule: ScheduledTaskSchedule,
        nextRunAt: String?,
        lastRunStatus: ScheduledTaskRunStatus
    ) {
        self.enabled = enabled
        self.schedule = schedule
        self.nextRunAt = nextRunAt
        self.lastRunStatus = lastRunStatus
    }
}

public enum ScheduledTaskLabels {
    private static let millisecondsPerMinute = 60_000

    public static func scheduleLabel(_ schedule: ScheduledTaskSchedule) -> String {
        switch schedule {
        case let .interval(everyMs):
            // Rows persisted before the one-minute write minimum can still be
            // sub-minute, and "Every 1.5 min" reads worse than seconds.
            guard everyMs % millisecondsPerMinute == 0 else {
                return "Every \(Int((Double(everyMs) / 1000).rounded())) sec"
            }
            return "Every \(everyMs / millisecondsPerMinute) min"
        case let .fixedTime(timeOfDay, weekdays):
            return "\(dayLabel(weekdays ?? [])) at \(timeOfDay)"
        }
    }

    private static func dayLabel(_ weekdays: [ScheduledTaskWeekday]) -> String {
        if weekdays.isEmpty { return "Daily" }
        // Five entries with no weekend day is the Monday-to-Friday preset, which
        // is worth naming rather than spelling out.
        if weekdays.count == 5, weekdays.allSatisfy({ !$0.isWeekend }) { return "Weekdays" }
        return weekdays.map(\.shortLabel).joined(separator: ", ")
    }

    /// Human label for the next scheduled fire. `nextRunAt` is a future instant,
    /// so a plain relative-time formatter would render a misleading "just now".
    public static func nextRunLabel(_ nextRunAt: String?, now: Date) -> String? {
        guard let nextRunAt, let next = parseTimestamp(nextRunAt) else { return nil }
        // Snapped to whole milliseconds first: the wire values only ever carry
        // millisecond precision, and rounding here keeps the `ceil` below from
        // tipping an exact five minutes into six on floating-point noise.
        let milliseconds = (next.timeIntervalSince(now) * 1000).rounded()
        if milliseconds <= 0 { return "next any moment" }

        let minutes = Int((milliseconds / Double(millisecondsPerMinute)).rounded(.up))
        if minutes < 2 { return "next in under a minute" }
        if minutes < 60 { return "next in \(minutes)m" }
        let hours = Int((Double(minutes) / 60).rounded())
        if hours < 24 { return "next in \(hours)h" }
        return "next in \(Int((Double(hours) / 24).rounded()))d"
    }

    /// One-line row subtitle: schedule, then run state, matching the web panel.
    public static func subtitle(for task: ScheduledTaskSummary, now: Date) -> String {
        var parts = [scheduleLabel(task.schedule)]
        if task.lastRunStatus == .running {
            // A live run makes the next fire irrelevant until it settles.
            parts.append("running now")
        } else if !task.enabled {
            parts.append("paused")
        } else {
            if task.lastRunStatus == .failed { parts.append("last run failed") }
            if let next = nextRunLabel(task.nextRunAt, now: now) { parts.append(next) }
        }
        return parts.joined(separator: " · ")
    }

    public static func statusTone(_ status: ScheduledTaskRunStatus) -> ScheduledTaskStatusTone {
        switch status {
        case .never: .dormant
        case .running: .running
        case .succeeded: .success
        case .failed: .danger
        }
    }

    /// Mirrors `Number.parseInt` rather than Swift's stricter `Int(_:)`: the
    /// field is a free-text keyboard entry, and trailing junk should still yield
    /// the number the user typed.
    public static func parseIntervalMinutes(_ raw: String) -> Int? {
        guard let minutes = leadingInteger(raw), minutes >= 1 else { return nil }
        return minutes
    }

    public static func isValidTimeOfDay(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // Deliberately rigid: "9:00" is rejected so the stored value is always
        // the zero-padded HH:MM the server contract expects.
        guard trimmed.count == 5 else { return false }
        let characters = Array(trimmed)
        guard characters[2] == ":" else { return false }
        guard let hour = twoDigitValue(characters[0], characters[1]),
              let minute = twoDigitValue(characters[3], characters[4]) else { return false }
        return hour <= 23 && minute <= 59
    }

    private static func twoDigitValue(_ tens: Character, _ units: Character) -> Int? {
        guard let tens = asciiDigit(tens), let units = asciiDigit(units) else { return nil }
        return tens * 10 + units
    }

    private static func asciiDigit(_ character: Character) -> Int? {
        guard character.isASCII, character.isNumber else { return nil }
        return character.wholeNumberValue
    }

    private static func leadingInteger(_ raw: String) -> Int? {
        var characters = Substring(raw.trimmingCharacters(in: .whitespacesAndNewlines))
        var sign = 1
        if let first = characters.first, first == "+" || first == "-" {
            sign = first == "-" ? -1 : 1
            characters = characters.dropFirst()
        }
        let digits = characters.prefix { $0.isASCII && $0.isNumber }
        guard let magnitude = Int(digits) else { return nil }
        return sign * magnitude
    }

    /// The fractional form is what the server emits; the plain form covers
    /// records written before it stamped milliseconds.
    private static func parseTimestamp(_ value: String) -> Date? {
        fractionalFormatter.date(from: value) ?? plainFormatter.date(from: value)
    }

    private static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plainFormatter = ISO8601DateFormatter()
}
