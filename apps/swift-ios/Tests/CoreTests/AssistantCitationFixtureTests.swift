import Foundation
import Testing
@testable import T3Code

struct AssistantCitationFixtureTests {
    @Test func decodesTheContractAndURLTogether() throws {
        struct Fixture: Decodable { let citation: AssistantCitation; let href: String }
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/assistantCitation.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: file))
        #expect(fixture.citation.isValid)
        #expect(fixture.citation.href == fixture.href)
        #expect(AssistantCitation.parse(fixture.href) == fixture.citation)
    }
}
