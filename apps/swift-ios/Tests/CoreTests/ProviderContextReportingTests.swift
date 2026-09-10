import XCTest
@testable import T3Code

final class ProviderContextReportingTests: XCTestCase {
    func testContextReportingDecodesFromGeneratedProviderSnapshot() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/providerContextReporting.json")
        let provider = try JSONDecoder().decode(ServerProviderSnapshot.self, from: Data(contentsOf: url))
        XCTAssertEqual(provider.instanceId, "codex-work")
        XCTAssertEqual(provider.reportsContextWindow, true)
        XCTAssertEqual(provider.models.first?.badge, "new")
        XCTAssertEqual(provider.models.first?.aliases, ["test"])
        let roundTrip = try JSONDecoder().decode(ServerProviderSnapshot.self, from: JSONEncoder().encode(provider))
        XCTAssertEqual(roundTrip.models, provider.models)
    }
}
