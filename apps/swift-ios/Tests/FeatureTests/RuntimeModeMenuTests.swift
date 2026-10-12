import XCTest

@testable import T3Code

/// Ports apps/mobile/src/lib/runtimeModeMenu.test.ts.
final class RuntimeModeMenuTests: XCTestCase {
    func testKeepsTheFourGenericModesForACodeProvider() {
        let menu = RuntimeModeMenu.resolve(runtimeMode: .approvalRequired)

        XCTAssertEqual(
            menu.options.map(\.mode),
            [.approvalRequired, .autoAcceptEdits, .auto, .fullAccess]
        )
        XCTAssertEqual(menu.selected.title, "Approve actions")
    }

    func testOffersOnlyTheModesAProviderSupportsReadingAnUnsupportedOneAsTheFirst() {
        let supported: [RuntimeMode] = [.approvalRequired, .auto, .fullAccess]
        let menu = RuntimeModeMenu.resolve(
            runtimeMode: .autoAcceptEdits,
            supportedRuntimeModes: supported
        )

        XCTAssertEqual(menu.options.map(\.mode), supported)
        XCTAssertEqual(menu.selected.mode, .approvalRequired)
    }
}
