import Foundation
import XCTest

@testable import T3Code

/// Ports apps/mobile/src/features/settings/automations/scheduledTaskLabels.test.ts.
/// "Now" is injected and every instant is built from a fixed UTC calendar, so
/// these labels cannot drift with the runner's clock or time zone.
final class ScheduledTaskLabelsTests: XCTestCase {
    /// 2026-08-02T12:00:00.000Z, matching the TypeScript fixture.
    private static let now: Date = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar.date(
            from: DateComponents(year: 2026, month: 8, day: 2, hour: 12, minute: 0, second: 0)
        )!
    }()

    private static let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    private func instant(offsetSeconds: TimeInterval) -> String {
        Self.formatter.string(from: Self.now.addingTimeInterval(offsetSeconds))
    }

    // MARK: - scheduleLabel

    func testWholeMinuteIntervalsAreLabelledInMinutes() {
        XCTAssertEqual(
            ScheduledTaskLabels.scheduleLabel(.interval(everyMs: 30 * 60_000)),
            "Every 30 min"
        )
    }

    func testSubMinuteIntervalsFallBackToSeconds() {
        XCTAssertEqual(
            ScheduledTaskLabels.scheduleLabel(.interval(everyMs: 90_000)),
            "Every 90 sec"
        )
    }

    func testEmptyWeekdaysReadAsDaily() {
        XCTAssertEqual(
            ScheduledTaskLabels.scheduleLabel(.fixedTime(timeOfDay: "09:00")),
            "Daily at 09:00"
        )
        XCTAssertEqual(
            ScheduledTaskLabels.scheduleLabel(.fixedTime(timeOfDay: "09:00", weekdays: [])),
            "Daily at 09:00"
        )
    }

    func testMondayToFridayCollapsesToWeekdays() {
        XCTAssertEqual(
            ScheduledTaskLabels.scheduleLabel(
                .fixedTime(
                    timeOfDay: "07:30",
                    weekdays: [.monday, .tuesday, .wednesday, .thursday, .friday]
                )
            ),
            "Weekdays at 07:30"
        )
    }

    func testExplicitDaySubsetsAreListedDayByDay() {
        XCTAssertEqual(
            ScheduledTaskLabels.scheduleLabel(
                .fixedTime(timeOfDay: "16:00", weekdays: [.friday])
            ),
            "Fri at 16:00"
        )
        // Five days is only the weekday preset when none of them is a weekend.
        XCTAssertEqual(
            ScheduledTaskLabels.scheduleLabel(
                .fixedTime(
                    timeOfDay: "16:00",
                    weekdays: [.sunday, .monday, .tuesday, .wednesday, .thursday]
                )
            ),
            "Sun, Mon, Tue, Wed, Thu at 16:00"
        )
    }

    // MARK: - nextRunLabel

    func testNextRunLabelIsNilWhenUnscheduled() {
        XCTAssertNil(ScheduledTaskLabels.nextRunLabel(nil, now: Self.now))
    }

    func testNextRunLabelRendersMinuteHourAndDayGranularity() {
        XCTAssertEqual(
            ScheduledTaskLabels.nextRunLabel(instant(offsetSeconds: 5 * 60), now: Self.now),
            "next in 5m"
        )
        XCTAssertEqual(
            ScheduledTaskLabels.nextRunLabel(instant(offsetSeconds: 3 * 3600), now: Self.now),
            "next in 3h"
        )
        XCTAssertEqual(
            ScheduledTaskLabels.nextRunLabel(instant(offsetSeconds: 49 * 3600), now: Self.now),
            "next in 2d"
        )
    }

    func testNextRunLabelRoundsTheFirstMinuteUpToAVagueLabel() {
        XCTAssertEqual(
            ScheduledTaskLabels.nextRunLabel(instant(offsetSeconds: 30), now: Self.now),
            "next in under a minute"
        )
    }

    func testNextRunLabelHandlesOverdueAndInvalidValues() {
        XCTAssertEqual(
            ScheduledTaskLabels.nextRunLabel(instant(offsetSeconds: -1), now: Self.now),
            "next any moment"
        )
        XCTAssertNil(ScheduledTaskLabels.nextRunLabel("not-a-date", now: Self.now))
    }

    // MARK: - subtitle

    private func task(
        enabled: Bool = true,
        lastRunStatus: ScheduledTaskRunStatus = .succeeded
    ) -> ScheduledTaskSummary {
        ScheduledTaskSummary(
            enabled: enabled,
            schedule: .fixedTime(
                timeOfDay: "09:00",
                weekdays: [.monday, .tuesday, .wednesday, .thursday, .friday]
            ),
            nextRunAt: instant(offsetSeconds: 2 * 3600),
            lastRunStatus: lastRunStatus
        )
    }

    func testSubtitleShowsScheduleAndNextRunWhenEnabled() {
        XCTAssertEqual(
            ScheduledTaskLabels.subtitle(for: task(), now: Self.now),
            "Weekdays at 09:00 · next in 2h"
        )
    }

    func testSubtitleShowsRunningStateAndSuppressesNextRun() {
        XCTAssertEqual(
            ScheduledTaskLabels.subtitle(for: task(lastRunStatus: .running), now: Self.now),
            "Weekdays at 09:00 · running now"
        )
    }

    func testSubtitleShowsPausedInsteadOfNextRunWhenDisabled() {
        XCTAssertEqual(
            ScheduledTaskLabels.subtitle(for: task(enabled: false), now: Self.now),
            "Weekdays at 09:00 · paused"
        )
    }

    func testSubtitleSurfacesAFailedLastRunAlongsideTheNextRun() {
        XCTAssertEqual(
            ScheduledTaskLabels.subtitle(for: task(lastRunStatus: .failed), now: Self.now),
            "Weekdays at 09:00 · last run failed · next in 2h"
        )
    }

    func testStatusToneDistinguishesEveryRunStatus() {
        XCTAssertEqual(ScheduledTaskLabels.statusTone(.never), .dormant)
        XCTAssertEqual(ScheduledTaskLabels.statusTone(.running), .running)
        XCTAssertEqual(ScheduledTaskLabels.statusTone(.succeeded), .success)
        XCTAssertEqual(ScheduledTaskLabels.statusTone(.failed), .danger)
    }

    // MARK: - Form parsing

    func testParsesIntervalMinutes() {
        XCTAssertEqual(ScheduledTaskLabels.parseIntervalMinutes("15"), 15)
        XCTAssertEqual(ScheduledTaskLabels.parseIntervalMinutes(" 60 "), 60)
        XCTAssertNil(ScheduledTaskLabels.parseIntervalMinutes("0"))
        XCTAssertNil(ScheduledTaskLabels.parseIntervalMinutes("abc"))
        XCTAssertNil(ScheduledTaskLabels.parseIntervalMinutes(""))
        XCTAssertNil(ScheduledTaskLabels.parseIntervalMinutes("-5"))
    }

    func testValidatesHourMinuteTimeOfDay() {
        XCTAssertTrue(ScheduledTaskLabels.isValidTimeOfDay("09:00"))
        XCTAssertTrue(ScheduledTaskLabels.isValidTimeOfDay("23:59"))
        XCTAssertTrue(ScheduledTaskLabels.isValidTimeOfDay(" 09:00 "))
        XCTAssertFalse(ScheduledTaskLabels.isValidTimeOfDay("24:00"))
        XCTAssertFalse(ScheduledTaskLabels.isValidTimeOfDay("09:60"))
        XCTAssertFalse(ScheduledTaskLabels.isValidTimeOfDay("9:00"))
        XCTAssertFalse(ScheduledTaskLabels.isValidTimeOfDay("09:0a"))
    }
}
