import XCTest

@testable import T3Code

/// Ports apps/mobile/src/lib/runtimeModeMenu.test.ts plus the
/// packages/shared/src/runtimeModes.test.ts cases the menu builds on.
final class RuntimeModeMenuTests: XCTestCase {
    func testKeepsTheFourGenericModesForACodeProvider() {
        let menu = RuntimeModeMenu.resolve(isHermes: false, runtimeMode: .approvalRequired)

        XCTAssertEqual(
            menu.options.map(\.mode),
            [.approvalRequired, .autoAcceptEdits, .auto, .fullAccess]
        )
        XCTAssertEqual(menu.selected.title, "Approve actions")
    }

    func testOffersAWorkThreadTheTwoModesHermesDistinguishes() {
        let menu = RuntimeModeMenu.resolve(isHermes: true, runtimeMode: .fullAccess)

        XCTAssertEqual(menu.options.map(\.title), ["Approve risky commands", "Full access"])
        XCTAssertEqual(menu.selected.mode, .fullAccess)
    }

    func testShowsACarriedInModeHermesDoesNotOfferAsTheApprovalOption() {
        let menu = RuntimeModeMenu.resolve(isHermes: true, runtimeMode: .autoAcceptEdits)

        XCTAssertEqual(menu.selected.mode, .approvalRequired)
        XCTAssertTrue(menu.options.contains(menu.selected))
    }

    func testHermesOffersOnlyTheTwoBehavioursItDistinguishes() {
        XCTAssertEqual(HermesRuntimeModes.choices.map(\.mode), [.approvalRequired, .fullAccess])
    }

    func testEveryModeHermesDoesNotOfferReadsAsTheApprovalChoice() {
        XCTAssertEqual(HermesRuntimeModes.choice(for: .auto).mode, .approvalRequired)
        XCTAssertEqual(HermesRuntimeModes.choice(for: .autoAcceptEdits).mode, .approvalRequired)
        XCTAssertEqual(HermesRuntimeModes.choice(for: .approvalRequired).mode, .approvalRequired)
        XCTAssertEqual(HermesRuntimeModes.choice(for: .fullAccess).mode, .fullAccess)
    }
}
