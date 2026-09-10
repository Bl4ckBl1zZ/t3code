import Foundation
import Testing
@testable import T3Code

struct ModelPriceTests {
    @Test func decodesExactContractRatesAndEncodesOnlyTheEditedModel() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("CoreTests/Fixtures/usageModelPrice.json")
        let price = try JSONDecoder().decode(UsageModelPriceOverride.self, from: Data(contentsOf: fixture))
        #expect(price.cacheReadCostPerMillionTokens == 0)
        #expect(price.cacheWriteCostPerMillionTokens == nil)
        let patch = ServerSettingsPatchInput(usagePriceOverrides: ["Vendor/Model": price])
        #expect(patch.json["usagePriceOverrides"]?["Vendor/Model"] == price.json)
        #expect(ServerSettingsPatchInput(usagePriceOverrides: ["Vendor/Model": nil]).json["usagePriceOverrides"]?["Vendor/Model"] == JSONValue.null)
    }

    @Test func validatesRatesAndKeepsZeroDifferentFromBlank() {
        var draft = PriceDraft(model: "Vendor/Model")
        draft.input = "2"
        draft.output = "8"
        #expect(draft.parsed?.cacheReadCostPerMillionTokens == nil)
        draft.cacheRead = "0"
        #expect(draft.parsed?.cacheReadCostPerMillionTokens == 0)
        for invalid in ["-1", "nan", "inf", "invalid"] {
            draft.input = invalid
            #expect(draft.parsed == nil)
        }
    }
}
