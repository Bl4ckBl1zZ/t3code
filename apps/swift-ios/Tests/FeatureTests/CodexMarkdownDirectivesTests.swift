import XCTest
@testable import T3Code

final class CodexMarkdownDirectivesTests: XCTestCase {
    private let template = #"::artifact-template{skill_name="artifact-template-report" skill_directory="/skills/report" display_name="Weekly report" artifact_kind="document"}"#

    func testTemplateBecomesItsOwnBlockWithoutChangingCode() {
        let value = CodexArtifactTemplate.parse(template)!
        XCTAssertEqual(MarkdownDocument(parsing: "Hello\n\(template)\nDone").blocks, [.paragraph("Hello"), .artifactTemplate(value), .paragraph("Done")])
        XCTAssertEqual(MarkdownDocument(parsing: "```text\n\(template)\n```").blocks, [.codeBlock(language: "text", code: template)])
        XCTAssertEqual(value.displayName, "Weekly report")
        XCTAssertTrue(value.prompt.contains("$artifact-template-report"))
    }

    func testInvalidAndIncompleteTemplatesStayLiteral() {
        XCTAssertNil(CodexArtifactTemplate.parse(template.replacingOccurrences(of: "artifact_kind=\"document\"", with: "artifact_kind=\"unknown\"")))
        XCTAssertNil(CodexArtifactTemplate.parse(String(template.dropLast())))
        XCTAssertNil(CodexArtifactTemplate.parse(template.replacingOccurrences(of: "/skills/report", with: "relative/path")))
    }

    func testCitationsPreserveFileIdentityAndLineWhileEscapingReservedCharacters() throws {
        let source = #"See :codex-file-citation{path="src/a#b?.swift" line_range_start="42"}."#
        let converted = CodexMarkdownDirectives.renderFileCitations(source)
        let start = try XCTUnwrap(converted.range(of: "(<"))
        let end = try XCTUnwrap(converted.range(of: ">)", range: start.upperBound..<converted.endIndex))
        let url = try XCTUnwrap(URL(string: String(converted[start.upperBound..<end.lowerBound])))
        let target = try XCTUnwrap(CodexMarkdownDirectives.fileTarget(url))
        XCTAssertEqual(target.path, "src/a#b?.swift")
        XCTAssertEqual(target.line, 42)
    }

    func testCodeEscapesAndMalformedDirectivesRemainLiteral() {
        for source in [#"`:codex-file-citation{path="a"}`"#, #"\:codex-file-citation{path="a"}"#, #":codex-file-citation{purpose="output"}"#, #":codex-file-citation{path="unfinished"#] {
            XCTAssertEqual(CodexMarkdownDirectives.renderFileCitations(source), source)
        }
    }
}
