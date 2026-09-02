import XCTest

@testable import T3Code

/// Ports apps/mobile/src/lib/markdownMediaSource.test.ts. The three routes look
/// alike in markdown and resolve to completely different loaders, so each one is
/// pinned here.
final class MarkdownMediaSourceTests: XCTestCase {
    private let threadID = "thread-1"

    func testPassesThroughDirectlyLoadableSources() {
        for src in [
            "https://example.com/a.png",
            "http://example.com/a.png",
            "data:image/png;base64,AAAA",
            "blob:https://example.com/abc",
            "file:///tmp/a.png",
            "//cdn.example.com/a.png",
        ] {
            XCTAssertEqual(
                MarkdownMediaSource.resolve(src, threadID: threadID),
                .direct(url: src),
                src
            )
        }
    }

    func testDirectSchemesAreMatchedCaseInsensitively() {
        XCTAssertEqual(
            MarkdownMediaSource.resolve("HTTPS://example.com/a.png", threadID: threadID),
            .direct(url: "HTTPS://example.com/a.png")
        )
    }

    func testRoutesAHermesBrowserArtifactToTheArtifactResource() {
        XCTAssertEqual(
            MarkdownMediaSource.resolve("/tmp/browser-artifacts/shot.png", threadID: threadID),
            .resource(.browserArtifact(fileName: "shot.png"))
        )
    }

    func testARelativeBrowserArtifactsPathStaysAWorkspaceFile() {
        // Only absolute paths are the server's artifact directory; a workspace
        // may hold a directory of the same name.
        XCTAssertEqual(
            MarkdownMediaSource.resolve("./browser-artifacts/shot.png", threadID: threadID),
            .resource(.workspaceFile(threadID: threadID, path: "browser-artifacts/shot.png"))
        )
    }

    func testRoutesAWorkspacePathToTheThreadsWorkspaceFile() {
        XCTAssertEqual(
            MarkdownMediaSource.resolve("./out/render.png", threadID: threadID),
            .resource(.workspaceFile(threadID: threadID, path: "out/render.png"))
        )
    }

    func testStripsTheLeadingSlashFromAnEscapedWindowsDrivePath() {
        XCTAssertEqual(
            MarkdownMediaSource.resolve("/C:/work/out.png", threadID: threadID),
            .resource(.workspaceFile(threadID: threadID, path: "C:/work/out.png"))
        )
    }

    func testAWindowsBrowserArtifactStillResolvesToTheArtifactResource() {
        XCTAssertEqual(
            MarkdownMediaSource.resolve(
                "/C:/tmp/browser-artifacts/shot.png",
                threadID: threadID
            ),
            .resource(.browserArtifact(fileName: "shot.png"))
        )
    }

    func testResolvedWorkspacePathsAreDecodedAndQueryFree() {
        XCTAssertEqual(
            MarkdownMediaSource.resolve("./out/my%20render.png?v=2", threadID: threadID),
            .resource(.workspaceFile(threadID: threadID, path: "out/my render.png"))
        )
    }

    func testDecodesPercentEncodedNames() {
        XCTAssertEqual(MarkdownMediaSource.fileName("./out/my%20render.png"), "my render.png")
    }

    func testFileNameKeepsAMalformedEscapeRatherThanFailing() {
        XCTAssertEqual(MarkdownMediaSource.fileName("./out/100%.png"), "100%.png")
    }

    func testFileNameFallsBackToTheWholePathWhenThereIsNoTrailingSegment() {
        XCTAssertEqual(MarkdownMediaSource.fileName("./out/"), "./out/")
        XCTAssertEqual(MarkdownMediaSource.fileName("render.png?v=2"), "render.png")
    }

    func testDetectsVideoSourcesByExtensionIgnoringTheQuery() {
        XCTAssertTrue(MarkdownMediaSource.isVideo("./demo.mp4?v=2"))
        XCTAssertTrue(MarkdownMediaSource.isVideo("./demo.mov"))
        XCTAssertTrue(MarkdownMediaSource.isVideo("./demo.WEBM#t=1"))
        XCTAssertTrue(MarkdownMediaSource.isVideo("./demo.m4v"))
        XCTAssertFalse(MarkdownMediaSource.isVideo("./shot.png"))
        XCTAssertFalse(MarkdownMediaSource.isVideo("./demo.mp4.txt"))
    }

    func testVideoPlaybackProbeRequiresAnExactByteRangeResponse() throws {
        let url = try XCTUnwrap(URL(string: "https://example.com/clip.mp4?token=signed"))
        let request = FeatureVideoRangeProbe.request(for: url)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Range"), "bytes=0-0")

        let supported = try XCTUnwrap(HTTPURLResponse(
            url: url,
            statusCode: 206,
            httpVersion: nil,
            headerFields: [
                "Accept-Ranges": "bytes",
                "Content-Range": "bytes 0-0/1024",
            ]
        ))
        XCTAssertTrue(FeatureVideoRangeProbe.supportsPlaybackResponse(supported))

        let legacy = try XCTUnwrap(HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Length": "1024"]
        ))
        XCTAssertFalse(FeatureVideoRangeProbe.supportsPlaybackResponse(legacy))
    }
}
