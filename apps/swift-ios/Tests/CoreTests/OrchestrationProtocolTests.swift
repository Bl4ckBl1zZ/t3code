import XCTest
@testable import T3Code

/// `OrchestrationProtocol.version` is mirrored by hand from
/// `packages/contracts`. Nothing compiles against the TypeScript constant, so
/// this is what catches a bump that would otherwise ship an iOS build the
/// updated server refuses to talk to.
final class OrchestrationProtocolTests: XCTestCase {
    private struct Fixture: Decodable {
        let version: Int
    }

    func testVersionMatchesTheGeneratedContractFixture() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/orchestrationProtocol.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        XCTAssertEqual(OrchestrationProtocol.version, fixture.version)
    }
}
