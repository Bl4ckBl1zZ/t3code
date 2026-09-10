import XCTest
@testable import T3Code

final class ProjectIconTests: XCTestCase {
    func testNameClassificationMatchesWebAcrossPlatforms() {
        for (name, expected) in [("MySwiftApp", "smartphone"), ("auth-service", "shield-check"), ("my-docs", "book-open"), ("t3-code", "layers-3"), ("AIStudio", "code-2"), ("camera-gallery", "image")] {
            XCTAssertEqual(ProjectIconDefaults.select(title: name, workspaceRoot: "/ignored").name, expected, name)
        }
        XCTAssertEqual(ProjectIconDefaults.select(title: "", workspaceRoot: "C:\\work\\swift-app").name, "smartphone")
        XCTAssertEqual(ProjectIconDefaults.select(title: "", workspaceRoot: "/work/swift-app/").name, "smartphone")
    }

    func testColorAndNameAreStableForUnknownUnicodeProjects() {
        XCTAssertEqual(ProjectIconDefaults.select(title: "🚀", workspaceRoot: "/one"), ProjectIconDefaults.select(title: "🚀", workspaceRoot: "/two"))
        XCTAssertEqual(ProjectIconDefaults.select(title: "Acme", workspaceRoot: "/one"), ProjectIconDefaults.select(title: "acme", workspaceRoot: "/two"))
    }

    func testEmojiInputKeepsGraphemeClustersAndRejectsPlainText() {
        XCTAssertEqual(ProjectIconEmoji.first(in: "Project 👩🏽‍💻 tools"), "👩🏽‍💻")
        XCTAssertEqual(ProjectIconEmoji.first(in: "🇩🇪"), "🇩🇪")
        XCTAssertEqual(ProjectIconEmoji.first(in: "🌱"), "🌱")
        XCTAssertNil(ProjectIconEmoji.first(in: "Hello 123"))
    }

    func testTypeScriptIconFixtureAndExplicitResetDecode() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/projectIcons.json")
        let icons = try JSONDecoder().decode([ProjectIconOverride?].self, from: Data(contentsOf: url))
        XCTAssertEqual(icons.count, 3)
        XCTAssertEqual(icons[0]?.name, "folder-code")
        XCTAssertEqual(icons[0]?.color, "violet")
        XCTAssertEqual(icons[1]?.emoji, "👩🏽‍💻")
        XCTAssertNil(icons[2])
    }

    func testIconWireValuesRoundTripAndFutureKindsRemainDecodable() throws {
        let decoder = JSONDecoder()
        for json in [#"{"kind":"lucide","name":"folder-code","color":"violet"}"#, #"{"kind":"emoji","emoji":"🚀"}"#, #"{"kind":"future","name":"custom"}"#] {
            let icon = try decoder.decode(ProjectIconOverride.self, from: Data(json.utf8))
            XCTAssertEqual(try decoder.decode(ProjectIconOverride.self, from: JSONEncoder().encode(icon)), icon)
        }
    }
}
