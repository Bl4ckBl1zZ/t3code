import ImageIO
import UIKit
import XCTest

@testable import T3Code

/// Project icons arrive as whatever the repo keeps: a PNG, an ICO, or an SVG.
/// SVG is the case worth pinning — it has no system decoder, and the rows that
/// lost it fell back to a derived icon without ever reporting a failure.
@MainActor
final class NativeIconImageTests: XCTestCase {
    func testDecodesSvgIconsThatImageIOCannotRead() {
        let svg = Data(
            """
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
              <rect width="400" height="400" fill="#090909" />
              <rect x="72" y="72" width="180" height="180" rx="40" fill="#f28b1c" />
            </svg>
            """.utf8
        )
        XCTAssertNil(CGImageSourceCreateWithData(svg as CFData, nil).flatMap {
            CGImageSourceCreateImageAtIndex($0, 0, nil)
        })
        XCTAssertNotNil(NativeIconImageStore.decode(svg, maximumPixelSize: 96))
    }

    func testDecodesRasterIconsDownToTheDrawnSize() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let source = UIGraphicsImageRenderer(size: CGSize(width: 256, height: 256), format: format)
            .image { context in
                UIColor.systemOrange.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
            }
        let png = try XCTUnwrap(source.pngData())

        let decoded = NativeIconImageStore.decode(png, maximumPixelSize: 96)

        XCTAssertEqual(decoded?.cgImage?.width, 96)
    }

    func testRejectsBytesThatAreNeitherBitmapNorSvg() {
        XCTAssertNil(NativeIconImageStore.decode(Data("not an icon".utf8), maximumPixelSize: 96))
    }
}
