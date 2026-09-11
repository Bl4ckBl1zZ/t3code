import Foundation
import Testing
@testable import T3Code

struct ToolActivityTests {
    private struct Fixture: Decodable {
        struct Item: Decodable { let toolIcon: ToolActivityIcon?; let toolSource: ToolActivitySource? }
        let turnItems: [Item]
    }
    @Test func generatedMetadataDecodesAndRoundTrips() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/orchestrationV2Projection.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        let item = try #require(fixture.turnItems.first { $0.toolSource != nil })
        #expect(item.toolSource?.key == "browser-use:chrome")
        #expect(item.toolSource?.icon?.app?.displayName == "Google Chrome")
        #expect(item.toolIcon?.imageURL(dark: true)?.absoluteString == "https://github.githubassets.com/favicons/favicon-dark.svg")
        let source = try #require(item.toolSource)
        #expect(try JSONDecoder().decode(ToolActivitySource.self, from: JSONEncoder().encode(source)) == source)
        #expect(fixture.turnItems.filter { $0.toolSource == nil }.count > 0)
    }
    @Test func untrustedURLsDoNotBecomeLocalFileRequests() throws {
        let data = Data(#"{"_tag":"website","pageUrl":"file:///private/file","faviconUrl":"javascript:alert(1)"}"#.utf8)
        let icon = try JSONDecoder().decode(ToolActivityIcon.self, from: data)
        #expect(icon.imageURL(dark: false) == nil)
    }
    @Test func fallbackUsesOriginWithoutPathQueryOrCredentials() throws {
        let data = Data(#"{"_tag":"website","pageUrl":"https://user:secret@localhost:8080/path?private=yes#fragment"}"#.utf8)
        let icon = try JSONDecoder().decode(ToolActivityIcon.self, from: data)
        #expect(icon.imageURL(dark: false)?.absoluteString == "https://localhost:8080/favicon.ico")
    }
}
