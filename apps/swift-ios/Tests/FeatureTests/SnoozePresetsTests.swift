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
}
