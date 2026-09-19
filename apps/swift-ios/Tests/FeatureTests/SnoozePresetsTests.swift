import Foundation
import XCTest

@testable import T3Code

/// Ports the preset expectations of
/// packages/client-runtime/src/state/threadSnoozed.test.ts for the shared
/// snooze choices in `resolveSnoozePresets`.
final class SnoozePresetsTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        return calendar
    }()

    private func date(
        _ year: Int, _ month: Int, _ day: Int, hour: Int, minute: Int = 0
    ) -> Date {
        calendar.date(
            from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)
        )!
    }

    func testMorningOffersEveryPresetInSharedOrder() {
        // Wednesday, well before evening.
        let now = date(2026, 8, 12, hour: 10)

        let presets = SnoozePresets.resolve(now: now, calendar: calendar)

        XCTAssertEqual(
            presets.map(\.id),
            ["hour", "three-hours", "evening", "tomorrow", "next-week"]
        )
        XCTAssertEqual(presets[0].snoozedUntil, now.addingTimeInterval(60 * 60))
        XCTAssertEqual(presets[1].snoozedUntil, now.addingTimeInterval(3 * 60 * 60))
        XCTAssertEqual(presets[2].snoozedUntil, date(2026, 8, 12, hour: 18))
        XCTAssertEqual(presets[3].snoozedUntil, date(2026, 8, 13, hour: 9))
        // Next Monday morning, not any sooner weekday.
        XCTAssertEqual(presets[4].snoozedUntil, date(2026, 8, 17, hour: 9))
    }

    func testEveningDisappearsOnceItIsLessThanAnHourAway() {
        let now = date(2026, 8, 12, hour: 17, minute: 30)

        let presets = SnoozePresets.resolve(now: now, calendar: calendar)

        XCTAssertEqual(presets.map(\.id), ["hour", "three-hours", "tomorrow", "next-week"])
    }

    func testNextWeekFromAMondayIsTheFollowingMonday() {
        // Monday.
        let now = date(2026, 8, 10, hour: 10)

        let presets = SnoozePresets.resolve(now: now, calendar: calendar)

        XCTAssertEqual(
            presets.first { $0.id == "next-week" }?.snoozedUntil,
            date(2026, 8, 17, hour: 9)
        )
    }

    func testSundayDoesNotOfferMondayMorningTwice() {
        // Sunday: both Tomorrow and Next week would otherwise resolve to the
        // same Monday at 9 AM.
        let now = date(2026, 8, 9, hour: 10)

        let presets = SnoozePresets.resolve(now: now, calendar: calendar)

        XCTAssertEqual(presets.map(\.id), ["hour", "three-hours", "evening", "tomorrow"])
        XCTAssertEqual(presets.last?.snoozedUntil, date(2026, 8, 10, hour: 9))
    }

    func testActionIDsRoundTripToTheirWakeTimes() {
        let now = date(2026, 8, 12, hour: 10)
        let presets = SnoozePresets.resolve(now: now, calendar: calendar)

        for preset in presets {
            XCTAssertEqual(
                SnoozePresets.snoozedUntil(
                    actionID: SnoozePresets.actionID(for: preset),
                    now: now,
                    calendar: calendar
                ),
                preset.snoozedUntil
            )
        }
        XCTAssertNil(SnoozePresets.snoozedUntil(actionID: "snooze", now: now, calendar: calendar))
        XCTAssertNil(
            SnoozePresets.snoozedUntil(actionID: "snooze:never", now: now, calendar: calendar)
        )
    }

    func testCustomDurationsCountFromConfirmationAndRejectEmptyAmounts() {
        let now = date(2026, 8, 12, hour: 10)

        XCTAssertEqual(CustomSnooze.wake(amount: 45, unit: .minutes, now: now), now.addingTimeInterval(45 * 60))
        XCTAssertEqual(CustomSnooze.wake(amount: 3, unit: .hours, now: now), date(2026, 8, 12, hour: 13))
        // A day is 24 hours, not a calendar day.
        XCTAssertEqual(CustomSnooze.wake(amount: 2, unit: .days, now: now), now.addingTimeInterval(48 * 60 * 60))
        XCTAssertNil(CustomSnooze.wake(amount: 0, unit: .hours, now: now))
        XCTAssertNil(CustomSnooze.wake(amount: -1, unit: .days, now: now))
    }

    func testCustomDatesMustBeInTheFutureAndDropSeconds() {
        let now = date(2026, 8, 12, hour: 10)

        XCTAssertNil(CustomSnooze.wake(date: now, now: now, calendar: calendar))
        XCTAssertNil(CustomSnooze.wake(date: date(2026, 8, 11, hour: 9), now: now, calendar: calendar))
        XCTAssertEqual(
            CustomSnooze.wake(date: date(2026, 8, 13, hour: 9).addingTimeInterval(42), now: now, calendar: calendar),
            date(2026, 8, 13, hour: 9)
        )
        XCTAssertEqual(CustomSnooze.initialDate(now: now, calendar: calendar), date(2026, 8, 13, hour: 9))
    }
}
