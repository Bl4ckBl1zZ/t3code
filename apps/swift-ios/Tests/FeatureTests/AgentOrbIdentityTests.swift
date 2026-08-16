import XCTest

@testable import T3Code

/// Ports packages/shared/src/agentIdentity.test.ts. The hue is a cross-client
/// contract: web, React Native, and this client hash the same seed, so an agent
/// keeps one colour wherever it appears.
final class AgentOrbIdentityTests: XCTestCase {
    func testMatchesTheSharedHashForKnownSeeds() {
        // Values produced by the JS `agentHue` for the same seeds.
        XCTAssertEqual(AgentIdentity.hue(for: ""), 0)
        XCTAssertEqual(AgentIdentity.hue(for: "a"), 97)
        XCTAssertEqual(AgentIdentity.hue(for: "thread-1"), 6)
        XCTAssertEqual(AgentIdentity.hue(for: "thread-2"), 7)
        XCTAssertEqual(AgentIdentity.hue(for: "thread-3"), 8)
        XCTAssertEqual(AgentIdentity.hue(for: "thread-abc"), 71)
        XCTAssertEqual(AgentIdentity.hue(for: "subagent-42"), 166)
        XCTAssertEqual(
            AgentIdentity.hue(for: "node:delegated-task:command%3Amcp%3A74c7782a"),
            225
        )
    }

    /// JS hashes UTF-16 code units, so an astral character contributes its two
    /// surrogates. Hashing Unicode scalars or UTF-8 bytes would silently drift.
    func testHashesUTF16CodeUnitsLikeTheSharedImplementation() {
        XCTAssertEqual(AgentIdentity.hue(for: "é🌟"), 148)
    }

    func testStaysWithinTheHueCircle() {
        for seed in ["", "a", "thread-1", "node:delegated-task:command%3Amcp%3A74c7782a"] {
            let hue = AgentIdentity.hue(for: seed)
            XCTAssertGreaterThanOrEqual(hue, 0)
            XCTAssertLessThan(hue, 360)
        }
    }

    func testSpreadsNearbySeedsAcrossDifferentHues() {
        let hues = Set(["thread-1", "thread-2", "thread-3"].map(AgentIdentity.hue(for:)))
        XCTAssertGreaterThan(hues.count, 1)
    }

    /// A long seed overflows 32 bits many times over; truncating each step is
    /// what keeps the result equal to the JS `| 0`.
    func testLongSeedsStayDeterministicAcrossOverflow() {
        let seed = String(repeating: "delegated-task/", count: 64)
        XCTAssertEqual(AgentIdentity.hue(for: seed), 256)
    }
}
