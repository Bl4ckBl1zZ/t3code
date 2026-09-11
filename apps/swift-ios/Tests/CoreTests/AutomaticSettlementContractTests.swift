import Testing
@testable import T3Code

@Suite("Automatic settlement contracts")
struct AutomaticSettlementContractTests {
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
