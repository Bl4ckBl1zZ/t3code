import XCTest
@testable import T3Code

/// What the link sheet accepts, and what the details row says about it.
///
/// The parse is the whole entry point on a phone: web links a pull request from
/// a right-click on its transcript link, which has no gesture equivalent over
/// rendered inline text here.
final class ThreadLinkedPullRequestInputTests: XCTestCase {
    func testAcceptsANumberInTheFormsPeopleWriteIt() {
        XCTAssertEqual(ThreadLinkedPullRequestInput.parse("123"), 123)
        XCTAssertEqual(ThreadLinkedPullRequestInput.parse("#123"), 123)
        XCTAssertEqual(ThreadLinkedPullRequestInput.parse("  #123  "), 123)
    }

    func testAcceptsAPastedHostURL() {
        XCTAssertEqual(
            ThreadLinkedPullRequestInput.parse("https://github.com/pingdotgg/t3code/pull/8160"),
            8160
        )
        // A copied URL often carries the tab the reader was on.
        XCTAssertEqual(
            ThreadLinkedPullRequestInput.parse(
                "https://github.com/pingdotgg/t3code/pull/8160/files"
            ),
            8160
        )
        // GitLab calls them merge requests; the number is the number.
        XCTAssertEqual(
            ThreadLinkedPullRequestInput.parse("https://gitlab.com/group/app/-/merge_requests/12"),
            12
        )
    }

    func testRejectsWhatCannotNameAPullRequest() {
        XCTAssertNil(ThreadLinkedPullRequestInput.parse(""))
        XCTAssertNil(ThreadLinkedPullRequestInput.parse("   "))
        XCTAssertNil(ThreadLinkedPullRequestInput.parse("#"))
        XCTAssertNil(ThreadLinkedPullRequestInput.parse("0"))
        XCTAssertNil(ThreadLinkedPullRequestInput.parse("main"))
        // An issue is not a pull request, and linking one would store a number
        // whose badge could never resolve.
        XCTAssertNil(
            ThreadLinkedPullRequestInput.parse("https://github.com/pingdotgg/t3code/issues/8160")
        )
    }

    func testRowSaysWhichPullRequestTheThreadFollows() {
        XCTAssertEqual(
            ThreadDetailsGit.linkedPullRequestSubtitle(nil),
            "Follows the branch"
        )
        XCTAssertEqual(
            ThreadDetailsGit.linkedPullRequestSubtitle(
                FeatureLinkedPullRequest(
                    projectID: "project:1",
                    repository: "pingdotgg/t3code",
                    number: 42,
                    url: "https://github.com/pingdotgg/t3code/pull/42"
                )
            ),
            "#42 · pingdotgg/t3code"
        )
    }
}
