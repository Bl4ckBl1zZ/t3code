import XCTest
@testable import T3Code

final class PullRequestReactionContractTests: XCTestCase {
    func testReactionCountsAndDescriptionTargetMatchContract() throws {
        struct Fixture: Decodable { let reactions: [PullRequestReaction]; let input: PullRequestReactionRequest }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/pullRequestReactions.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        XCTAssertEqual(fixture.reactions.first?.count, 3)
        XCTAssertEqual(fixture.reactions.first?.actors, ["a", "b"])
        XCTAssertTrue(fixture.reactions.first?.viewerHasReacted == true)
        XCTAssertNil(fixture.input.subjectId)
        XCTAssertFalse(fixture.input.reacted)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(fixture.input)) as! [String: Any]
        XCTAssertNil(encoded["subjectId"])
    }
}
