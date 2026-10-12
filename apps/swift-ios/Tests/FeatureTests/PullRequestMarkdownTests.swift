import XCTest
@testable import T3Code

/// Mirrors upstream `githubMarkdownLinks.test.ts`, `pullRequestMarkdown.test.ts`
/// and `botBadgeImages.test.ts`, for the native renderer's needs.
final class PullRequestMarkdownTests: XCTestCase {
    private let url = "https://github.com/team/repo/pull/8"

    // MARK: - GitHub references

    func testLinksClosingReferencesCrossRepositoryReferencesCommitsAndMentions() {
        XCTAssertEqual(
            PullRequestMarkdown.linkGitHubReferences(
                "Closes #123, fixes other/project#9; other#4 @julius @team/mobile abc1234 other/project@abcdef1", pullRequestURL: url),
            "Closes [#123](https://github.com/team/repo/issues/123), fixes [other/project#9](https://github.com/other/project/issues/9); [other#4](https://github.com/other/repo/issues/4) [@julius](https://github.com/julius) [@team/mobile](https://github.com/orgs/team/teams/mobile) [abc1234](https://github.com/team/repo/commit/abc1234) [other/project@abcdef1](https://github.com/other/project/commit/abcdef1)"
        )
    }

    func testLeavesCodeLinksImagesURLsEscapesEmailsAndPlainNumbersAlone() {
        let text = ##"`#123 @person abc1234`"## + "\n\n```\n#123\n```\n\n"
            + ##"[#123](https://example.com) ![#123](image.png) https://example.com/#123 user@example.com \#123 1234567"##
            + "\n\n[ref]: https://example.com/#123\n\n    #77 in indented code"
        XCTAssertEqual(PullRequestMarkdown.linkGitHubReferences(text, pullRequestURL: url), text)
    }

    func testKeepsFormattingAndLinksReferencesInListsAndQuotes() {
        XCTAssertEqual(
            PullRequestMarkdown.linkGitHubReferences("> **Fixes #42**\n\n- See #9", pullRequestURL: url),
            "> **Fixes [#42](https://github.com/team/repo/issues/42)**\n\n- See [#9](https://github.com/team/repo/issues/9)"
        )
    }

    func testDoesNothingWithoutAGitHubRepository() {
        XCTAssertEqual(PullRequestMarkdown.linkGitHubReferences("#123", pullRequestURL: nil), "#123")
        XCTAssertEqual(PullRequestMarkdown.linkGitHubReferences("#123", pullRequestURL: "https://gitlab.com/a/b/-/merge_requests/1"), "#123")
    }

    func testDoesNotNestLinksInsideHTMLAnchorsOrCode() {
        XCTAssertEqual(
            PullRequestMarkdown.linkGitHubReferences(#"See <a href="https://example.com">#12</a> and <code>#13</code>, then #14."#, pullRequestURL: url),
            #"See <a href="https://example.com">#12</a> and <code>#13</code>, then [#14](https://github.com/team/repo/issues/14)."#
        )
    }

    // MARK: - Media

    func testADroppedImageTagBecomesMarkdownMedia() {
        XCTAssertEqual(
            PullRequestMarkdown.liftMedia(#"<img width="1414" alt="Screenshot" src="https://github.com/user-attachments/assets/7195f963-51a9" />"#),
            "![Screenshot](https://github.com/user-attachments/assets/7195f963-51a9)"
        )
        XCTAssertEqual(
            PullRequestMarkdown.liftMedia(#"<p align="center"><img src="https://example.com/a.png"><img alt="b" src="https://example.com/b.png"></p>"#),
            "![Image](https://example.com/a.png) ![b](https://example.com/b.png)"
        )
    }

    func testAnImageTagSharingItsLineWithProseStaysProse() {
        let body = #"Before <img src="https://example.com/a.png"> after"#
        XCTAssertEqual(PullRequestMarkdown.liftMedia(body), body)
    }

    func testABareGitHubUploadIsAVideoLinkAndAVideoFilePlaysInline() {
        XCTAssertEqual(
            PullRequestMarkdown.liftMedia("Before\n\nhttps://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e\n\nAfter"),
            "Before\n\n[Video](https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e)\n\nAfter"
        )
        XCTAssertEqual(PullRequestMarkdown.liftMedia("https://example.com/demo.mp4?raw=1"), "![Video](https://example.com/demo.mp4?raw=1)")
        XCTAssertEqual(PullRequestMarkdown.liftMedia("<https://example.com/shot.png>"), "![shot.png](https://example.com/shot.png)")
    }

    func testReadsTheSourceOutOfAMultiLineVideoTag() {
        XCTAssertEqual(
            PullRequestMarkdown.liftMedia("<video controls>\n  <source src=\"https://example.com/a.webm\">\n</video>\nAfter"),
            "![Video](https://example.com/a.webm)\nAfter"
        )
    }

    func testOrdinaryLinksAndCodeAreLeftAlone() {
        for body in [
            "https://example.com/page\n\n[the docs](https://example.com/docs)",
            "```\nhttps://example.com/demo.mp4\n```",
            "```\n~~~\nhttps://example.com/demo.mp4\n```",
            "```\n```javascript\nhttps://example.com/demo.mp4\n```",
            "    https://example.com/demo.mp4",
            #"Before <video src="https://example.com/a.mp4"></video> after"#,
            "![shot](https://github.com/user-attachments/assets/2f8c1a90)",
        ] {
            XCTAssertEqual(PullRequestMarkdown.liftMedia(body), body)
        }
    }

    func testHTMLCommentsAreHiddenLikeOnGitHub() {
        XCTAssertEqual(
            PullRequestMarkdown.liftMedia("<!-- Describe your change -->\n## Summary\n<!--\nchecklist\n-->\nDone"),
            "## Summary\nDone"
        )
        XCTAssertEqual(PullRequestMarkdown.liftMedia("```\n<!-- kept -->\n```"), "```\n<!-- kept -->\n```")
    }

    // MARK: - Bot badges

    func testBotBadgesStayOutOfMediaWhileScreenshotsOnTheSameServicesRemain() {
        XCTAssertTrue(PullRequestMarkdown.isBotBadgeImage("https://img.shields.io/badge/a-b-green"))
        XCTAssertTrue(PullRequestMarkdown.isBotBadgeImage("https://www.cursor.com/assets/images/fix-in-cursor.svg"))
        XCTAssertFalse(PullRequestMarkdown.isBotBadgeImage("https://cursor.com/artifacts/screenshot.png"))
        XCTAssertFalse(PullRequestMarkdown.isBotBadgeImage("https://github.com/user-attachments/assets/abc"))

        XCTAssertEqual(PullRequestMarkdown.liftMedia(#"<a href="https://cursor.com"><img src="https://cursor.com/assets/images/fix-in-cursor.svg"></a>"#), "")
        XCTAssertEqual(
            PullRequestMarkdown.liftMedia("![build](https://img.shields.io/badge/build-passing-green.svg) ![ui](https://example.com/ui.png)"),
            "![ui](https://example.com/ui.png)"
        )
    }

    func testPrepareLiftsMediaThenLinksReferences() {
        XCTAssertEqual(
            PullRequestMarkdown.prepare("<!-- template -->\nFixes #3", pullRequestURL: url),
            "Fixes [#3](https://github.com/team/repo/issues/3)"
        )
    }
}
