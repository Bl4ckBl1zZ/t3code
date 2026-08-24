import Foundation
import XCTest

@testable import T3Code

/// Covers the "Activity detail" preference added to `FeatureSettings`. The
/// stored settings blob is shared with builds that predate the key and with
/// builds that will add more, so both directions have to survive a round trip.
final class ThreadAppearanceSettingsTests: XCTestCase {
    func testActivityDetailIsOffByDefault() {
        XCTAssertFalse(FeatureSettings().alwaysExpandActivity)
    }

    /// Matches the server's client-settings default, so a reader who never
    /// opens Settings sees the same slash menu the web client shows.
    func testSkillsInTheSlashMenuAreOnByDefault() {
        XCTAssertTrue(FeatureSettings().showSkillsInSlashMenu)
    }

    /// Settings written by a build that never knew the key must still decode,
    /// landing on the default rather than throwing the whole blob away.
    func testSettingsWrittenBeforeTheKeyExistedStillDecode() throws {
        let legacy = Data(
            """
            {
              "appearance": "dark",
              "hapticsEnabled": false,
              "notificationsEnabled": true,
              "liveActivitiesEnabled": true
            }
            """.utf8
        )
        let settings = try JSONDecoder().decode(FeatureSettings.self, from: legacy)
        XCTAssertFalse(settings.alwaysExpandActivity)
        XCTAssertTrue(settings.showSkillsInSlashMenu)
        XCTAssertEqual(settings.appearance, .dark)
        XCTAssertFalse(settings.hapticsEnabled)
    }

    func testUnknownKeysFromANewerBuildAreIgnored() throws {
        let future = Data(
            """
            {
              "alwaysExpandActivity": true,
              "somethingAddedLater": "value"
            }
            """.utf8
        )
        let settings = try JSONDecoder().decode(FeatureSettings.self, from: future)
        XCTAssertTrue(settings.alwaysExpandActivity)
        // Absent keys still fall back to their own defaults.
        XCTAssertEqual(settings.appearance, .system)
        XCTAssertTrue(settings.notificationsEnabled)
    }

    func testThePreferenceSurvivesAnEncodeDecodeRoundTrip() throws {
        var settings = FeatureSettings()
        settings.alwaysExpandActivity = true
        settings.showSkillsInSlashMenu = false
        settings.appearance = .light

        let data = try JSONEncoder().encode(settings)
        let decoded = try JSONDecoder().decode(FeatureSettings.self, from: data)
        XCTAssertEqual(decoded, settings)
        XCTAssertTrue(decoded.alwaysExpandActivity)
        XCTAssertFalse(decoded.showSkillsInSlashMenu)
    }

    /// The settings sheet enables Save by comparing against the saved snapshot,
    /// so the new field has to participate in equality or toggling it would
    /// leave Save greyed out.
    func testTogglingActivityDetailMakesSettingsUnequal() {
        var changed = FeatureSettings()
        changed.alwaysExpandActivity = true
        XCTAssertNotEqual(changed, FeatureSettings())

        var slashMenu = FeatureSettings()
        slashMenu.showSkillsInSlashMenu = false
        XCTAssertNotEqual(slashMenu, FeatureSettings())
    }
}
