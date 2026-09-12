import XCTest
@testable import T3Code

final class SnapShotContractTests: XCTestCase {
    func testDecodesCapturedWindowTreeAndPreservesItWhenEncoded() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/snapShot.json")
        let attachment = try JSONDecoder().decode(ChatAttachment.self, from: Data(contentsOf: url))
        let source = try XCTUnwrap(attachment.source)
        XCTAssertEqual(source.appName, "Editor")
        XCTAssertEqual(source.accessibility?.imageSize?.width, 100)
        XCTAssertEqual(source.accessibility?.root?.children.first?.bounds?.x, 10)
        XCTAssertEqual(source.accessibility?.truncated, true)
        XCTAssertTrue(source.accessibilityDetails?.contains("Save") == true)
        XCTAssertEqual(try JSONDecoder().decode(ChatAttachment.self, from: JSONEncoder().encode(attachment)), attachment)
    }

    func testLegacyImagesRemainDecodableWithoutSource() throws {
        let data = Data(#"{"id":"image_1","type":"image","name":"photo.jpg","mimeType":"image/jpeg","sizeBytes":3}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(ChatAttachment.self, from: data).source)
    }
}
