import Foundation
import XCTest

@testable import T3Code

/// Covers the built-in palettes and the two settings keys that select them.
/// The stored settings blob is shared with builds that predate themes, and the
/// palette table is generated from the shared package rather than typed here,
/// so both the compatibility and the data need holding down.
final class ThemeSelectionTests: XCTestCase {
    func testEveryBuiltInPaletteIsPresentAndDistinct() {
        let ids = T3Palette.builtIn.map(\.id)
        XCTAssertEqual(ids, ["t3-code", "t3-chat", "grove", "ocean", "ember", "iris"])
        XCTAssertEqual(Set(ids).count, ids.count)
        XCTAssertFalse(T3Palette.builtIn.contains { $0.label.isEmpty })
    }

    func testTheDefaultPaletteKeepsTheColorsTheAppAlreadyShipped() {
        // Guards the generated table against a mapping slip: these are the
        // values T3Colors hardcoded before the palette existed, so the default
        // theme has to be pixel-identical for anyone upgrading.
        let light = T3Palette.named("t3-code").light
        XCTAssertEqual(light.background.red, 242.0 / 255, accuracy: 0.001)
        XCTAssertEqual(light.background.green, 242.0 / 255, accuracy: 0.001)
        XCTAssertEqual(light.background.blue, 247.0 / 255, accuracy: 0.001)

        // #007AFF, the light-mode accent.
        XCTAssertEqual(light.accent.red, 0, accuracy: 0.001)
        XCTAssertEqual(light.accent.green, 122.0 / 255, accuracy: 0.001)
        XCTAssertEqual(light.accent.blue, 1, accuracy: 0.001)

        let dark = T3Palette.named("t3-code").dark
        XCTAssertEqual(dark.background.red, 10.0 / 255, accuracy: 0.001)
        XCTAssertEqual(dark.textPrimary.red, 245.0 / 255, accuracy: 0.001)
    }

    /// The id round-trips through persisted settings, so a downgrade or an
    /// edited file can name a palette this build has never heard of.
    func testAnUnknownPaletteFallsBackToTheDefault() {
        XCTAssertEqual(T3Palette.named("no-such-theme").id, "t3-code")
        XCTAssertEqual(T3Palette.named(nil).id, "t3-code")
    }

    func testSheetCarriesItsTranslucency() {
        // The sheet role is the one alpha-bearing color in the table; a parser
        // that dropped alpha would render it opaque and go unnoticed.
        XCTAssertEqual(T3Palette.named("t3-code").light.sheet.alpha, 0.98, accuracy: 0.001)
        XCTAssertEqual(T3Palette.named("t3-code").light.background.alpha, 1, accuracy: 0.001)
    }

    func testBothAppearancesStartOnTheDefaultPalette() {
        let settings = FeatureSettings()
        XCTAssertEqual(settings.lightThemeID, "t3-code")
        XCTAssertEqual(settings.darkThemeID, "t3-code")
    }

    func testSettingsWrittenBeforeThemesExistedStillDecode() throws {
        let legacy = Data(
            """
            {
              "appearance": "dark",
              "hapticsEnabled": true,
              "notificationsEnabled": true,
              "liveActivitiesEnabled": true,
              "alwaysExpandActivity": false
            }
            """.utf8
        )
        let settings = try JSONDecoder().decode(FeatureSettings.self, from: legacy)
        XCTAssertEqual(settings.lightThemeID, "t3-code")
        XCTAssertEqual(settings.darkThemeID, "t3-code")
        XCTAssertEqual(settings.appearance, .dark)
    }

    func testEachAppearanceKeepsItsOwnPalette() throws {
        var settings = FeatureSettings()
        settings.lightThemeID = "grove"
        settings.darkThemeID = "iris"

        let decoded = try JSONDecoder().decode(
            FeatureSettings.self,
            from: JSONEncoder().encode(settings)
        )
        XCTAssertEqual(decoded, settings)
        XCTAssertEqual(decoded.lightThemeID, "grove")
        XCTAssertEqual(decoded.darkThemeID, "iris")
    }

    /// The settings sheet enables Save by comparing against the saved snapshot,
    /// so a palette change has to move equality or Save would stay greyed out.
    func testChangingAPaletteMakesSettingsUnequal() {
        var changed = FeatureSettings()
        changed.lightThemeID = "ocean"
        XCTAssertNotEqual(changed, FeatureSettings())
    }

    @MainActor
    func testApplyingTheSameSelectionTwiceIsIgnored() {
        let store = T3ThemeStore()
        store.apply(lightPaletteID: "grove", darkPaletteID: "iris")
        XCTAssertEqual(store.lightPaletteID, "grove")
        XCTAssertEqual(store.darkPaletteID, "iris")

        // Settings republish constantly for reasons unrelated to the theme; a
        // repeat must not post a change notification that repaints everything.
        var notifications = 0
        let token = NotificationCenter.default.addObserver(
            forName: .t3ThemeDidChange,
            object: nil,
            queue: .main
        ) { _ in notifications += 1 }
        defer { NotificationCenter.default.removeObserver(token) }

        store.apply(lightPaletteID: "grove", darkPaletteID: "iris")
        XCTAssertEqual(notifications, 0)
    }

    @MainActor
    func testAnUnknownIdSettlesOnTheDefaultRatherThanBeingStored() {
        let store = T3ThemeStore()
        store.apply(lightPaletteID: "bogus", darkPaletteID: nil)
        XCTAssertEqual(store.lightPaletteID, "t3-code")
        XCTAssertEqual(store.darkPaletteID, "t3-code")
    }
}
