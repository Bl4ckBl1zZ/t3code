import Foundation
import Testing
@testable import T3Code

@Suite("Automatic settlement contracts")
struct AutomaticSettlementContractTests {
    @Test func restartRecoveryIsExplicitAndSparse() throws {
        let settings = try JSONDecoder().decode(ServerSettingsSnapshot.self, from: Data(#"{"defaultThreadEnvMode":"local","newWorktreesStartFromOrigin":true}"#.utf8))
        #expect(settings.continueThreadsAfterServerUpdate == false)
        #expect(ServerSettingsPatchInput(continueThreadsAfterServerUpdate: true).json == .object(["continueThreadsAfterServerUpdate": .bool(true)]))
        #expect(ServerSettingsPatchInput(continueThreadsAfterServerUpdate: false).json == .object(["continueThreadsAfterServerUpdate": .bool(false)]))
    }

    @Test func sparsePatchDistinguishesNeverFalseAndUnchanged() {
        #expect(ServerSettingsPatchInput().isEmpty)
        #expect(ServerSettingsPatchInput(sidebarAutoSettleAfterDays: .some(nil), sidebarAutoSettleOnMerge: false).json == .object([
            "sidebarAutoSettleAfterDays": .null, "sidebarAutoSettleOnMerge": .bool(false)
        ]))
        #expect(ServerSettingsPatchInput(sidebarAutoSettleAfterDays: .some(7)).json == .object([
            "sidebarAutoSettleAfterDays": .number(7)
        ]))
    }
}
