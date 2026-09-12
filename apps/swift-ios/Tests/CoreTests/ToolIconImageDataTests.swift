import Foundation
import Testing
@testable import T3Code

struct ToolIconImageDataTests {
    @Test func inlineImageFormatsAndLimits() {
        #expect(ToolIconImageData.inline("data:image/png;base64,aGVsbG8=") == Data("hello".utf8))
        #expect(ToolIconImageData.inline("data:image/svg+xml,%3Csvg%2F%3E") == Data("<svg/>".utf8))
        #expect(ToolIconImageData.inline("data:text/html;base64,aGVsbG8=") == nil)
        #expect(ToolIconImageData.inline("data:image/png;base64,!!!") == nil)
        #expect(ToolIconImageData.inline("data:image/png;base64," + Data(repeating: 1, count: ToolIconImageData.maximumBytes + 1).base64EncodedString()) == nil)
    }
    @Test func svgReferencesMustBeFiniteAndBounded() {
        func accepts(_ svg: String) -> Bool { ToolIconSVGValidation.accepts(Data(svg.utf8)) }
        #expect(accepts("<svg><defs><path id='p' d='M0 0L1 1'/></defs><use href='#p'/></svg>"))
        #expect(!accepts("<svg><g id='a'><use href='#a'/></g></svg>"))
        #expect(!accepts("<svg><use id='a' href='#b'/><use id='b' href='#a'/></svg>"))
        #expect(!accepts("<!DOCTYPE svg [<!ENTITY x 'x'>]><svg/>"))
        #expect(!accepts("<svg>" + String(repeating: "<g>", count: 33) + String(repeating: "</g>", count: 33) + "</svg>"))
        #expect(!accepts("<svg><path></svg>"))
    }
}
