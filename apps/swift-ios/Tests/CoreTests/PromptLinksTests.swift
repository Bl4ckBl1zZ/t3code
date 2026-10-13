import Foundation
import XCTest
@testable import T3Code

/// Ports packages/shared/src/promptLinks.test.ts and the model resolution in
/// packages/client-runtime/src/promptLinks.test.ts.
final class PromptLinksTests: XCTestCase {
    private func scalars(_ values: UInt32...) -> String {
        String(String.UnicodeScalarView(values.compactMap(Unicode.Scalar.init)))
    }

    private func newLink(_ query: String) -> PromptLinks.NewThreadLink? {
        try? PromptLinks.parseNewThreadLink(query).get()
    }

    // MARK: sanitize

    func testRemovesCharactersAReaderCannotSeeAndCountsThem() {
        let tagged = "rate me" + scalars(0xE0041, 0xE0042)
        XCTAssertEqual(
            PromptLinks.sanitize("a\u{200B}b\u{202E}c\u{FEFF}\(tagged)"),
            .init(text: "abcrate me", hiddenCharacters: 5)
        )
        XCTAssertEqual(PromptLinks.sanitize("a\u{2028}b\u{2029}c"), .init(text: "a\nb\nc", hiddenCharacters: 0))
        XCTAssertEqual(PromptLinks.sanitize("a\r\nb\rc"), .init(text: "a\nb\nc", hiddenCharacters: 0))
    }

    func testKeepsEmojiSequencesIntact() {
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"
        let heart = "\u{2764}\u{FE0F}"
        XCTAssertEqual(PromptLinks.sanitize("\(family) \(heart)"), .init(text: "\(family) \(heart)", hiddenCharacters: 0))
        XCTAssertEqual(PromptLinks.sanitize("a\u{200D}b").hiddenCharacters, 1)
        XCTAssertEqual(PromptLinks.sanitize("\u{1F468}\u{200D}").hiddenCharacters, 1)
        XCTAssertEqual(PromptLinks.sanitize("\u{20000}\u{200D}\u{20001}").hiddenCharacters, 1)
    }

    // MARK: new links

    func testReadsASharedPromptWithItsOptionalRepositoryAndModel() {
        XCTAssertEqual(
            newLink("?prompt=Rate+me&repo=https://github.com/pingdotgg/t3code.git&provider=Codex&model=gpt-5"),
            .new(
                prompt: .init(text: "Rate me", hiddenCharacters: 0),
                repository: .init(owner: "pingdotgg", name: "t3code"),
                provider: "codex",
                model: "gpt-5"
            )
        )
    }

    func testReadsAPullRequestLinkWhosePromptIsOptional() {
        for pr in ["pingdotgg/t3code/42", "pingdotgg/t3code%2342", "https://github.com/pingdotgg/t3code/pull/42/files"] {
            XCTAssertEqual(
                newLink("?pr=\(pr)"),
                .pullRequest(.init(repository: .init(owner: "pingdotgg", name: "t3code"), number: 42), prompt: nil),
                pr
            )
        }
    }

    func testRefusesLinksItCannotOpenSafely() {
        XCTAssertNil(newLink("?repo=a/b"))
        XCTAssertNil(newLink("?prompt=%E2%80%8B"))
        XCTAssertNil(try? PromptLinks.parseThreadLinkPrompt("?prompt=%E2%80%8B").get())
        XCTAssertNil(newLink("?prompt=x&repo=../etc"))
        XCTAssertNil(newLink("?prompt=\(String(repeating: "x", count: 8_001))"))
        XCTAssertNotNil(newLink("?prompt=\(String(repeating: "x", count: 8_000))"))
        XCTAssertNil(newLink("?prompt=x&pr=owner/name/0"))
        if case let .failure(failure) = PromptLinks.parseNewThreadLink("?prompt=%E2%80%8B") {
            XCTAssertTrue(failure.message.contains("may be malicious"))
        } else {
            XCTFail("Expected a hidden-only prompt to be refused")
        }
    }

    // MARK: thread links

    func testThreadLinksReadThePrompt() {
        XCTAssertEqual(try PromptLinks.parseThreadLinkPrompt("?prompt=Fix+it").get(), .init(text: "Fix it", hiddenCharacters: 0))
        XCTAssertEqual(try PromptLinks.parseThreadLinkPrompt("?panel=diff").get(), nil)
    }

    // MARK: round trips and routes

    func testBuildsALinkThatParsesBackToTheSamePrompt() throws {
        let link = PromptLinks.buildNewThreadLink(prompt: "Swear count & rating?\nLine two 🎉")
        let route = try XCTUnwrap(PromptLinks.route(for: XCTUnwrap(URL(string: link))))
        guard case let .new(query) = route else { return XCTFail("Expected a new-thread route") }
        guard case let .new(prompt, _, _, _)? = newLink(query) else { return XCTFail("Expected a prompt") }
        XCTAssertEqual(prompt.text, "Swear count & rating?\nLine two 🎉")
    }

    func testMapsAppSchemeAndHostedLinksToRoutesAndNothingElse() {
        func route(_ value: String) -> PromptLinks.Route? { PromptLinks.route(for: URL(string: value)!) }
        XCTAssertEqual(route("t3code://new?prompt=hi"), .new(query: "prompt=hi"))
        XCTAssertEqual(route("t3code://new/?prompt=hi"), .new(query: "prompt=hi"))
        XCTAssertEqual(route("t3code-dev://threads/env-1/thread-1"), .thread(environmentID: "env-1", threadID: "thread-1", query: ""))
        XCTAssertEqual(route("t3code-debug://threads/env-1/thread-1?prompt=go"), .thread(environmentID: "env-1", threadID: "thread-1", query: "prompt=go"))
        XCTAssertEqual(route("https://app.t3.codes/env-1/thread-1?prompt=go"), .thread(environmentID: "env-1", threadID: "thread-1", query: "prompt=go"))
        XCTAssertEqual(route("https://app.t3.codes/new?prompt=hi"), .new(query: "prompt=hi"))
        XCTAssertNil(route("https://app.t3.codes/env-1/thread-1"))
        XCTAssertNil(route("https://app.t3.codes/settings/general"))
        XCTAssertNil(route("https://evil.test/new?prompt=hi"))
        XCTAssertNil(route("t3code://app/index.html"))
        XCTAssertNil(route("t3code://pair?host=x"))
        XCTAssertNil(route("t3code2://new?prompt=hi"))
    }

    func testShareLinksCarryTheTrimmedPromptOnlyWhenItFits() throws {
        let link = try XCTUnwrap(PromptLinks.shareLink(for: "  Rate me  "))
        XCTAssertEqual(link, "https://app.t3.codes/new?prompt=Rate+me")
        XCTAssertNil(PromptLinks.shareLink(for: " \n "))
        XCTAssertNil(PromptLinks.shareLink(for: String(repeating: "x", count: 8_001)))
    }

    // MARK: model resolution

    private func provider(_ instanceID: String, _ driver: String, status: String = "ready") -> PromptLinks.ProviderCandidate {
        .init(instanceID: instanceID, driver: driver, enabled: true, availability: nil, status: status, models: [
            .init(slug: "small", name: "Small"),
            .init(slug: "big", name: "Big", aliases: ["opus"], isDefault: true),
        ])
    }

    func testMapsTheRequestedProviderAndModelOntoAUsableInstance() {
        let providers = [provider("broken", "claudeAgent", status: "error"), provider("work", "claudeAgent")]
        XCTAssertEqual(PromptLinks.resolveModel(providers, provider: "claude", model: "small"), .init(instanceID: "work", model: "small", exact: true))
        XCTAssertEqual(PromptLinks.resolveModel(providers, provider: "claudeagent", model: "opus"), .init(instanceID: "work", model: "big", exact: true))
        XCTAssertEqual(PromptLinks.resolveModel(providers, provider: "claudeagent", model: "BIG"), .init(instanceID: "work", model: "big", exact: true))
    }

    func testUsesTheInstanceDefaultForAnUnknownModelAndNothingForAMissingProvider() {
        let providers = [provider("codex", "codex")]
        XCTAssertEqual(PromptLinks.resolveModel(providers, provider: "codex", model: "nope"), .init(instanceID: "codex", model: "big", exact: false))
        XCTAssertEqual(PromptLinks.resolveModel(providers, provider: "codex", model: nil), .init(instanceID: "codex", model: "big", exact: true))
        XCTAssertNil(PromptLinks.resolveModel(providers, provider: "cursor", model: nil))
    }

    // MARK: drafts and notices

    func testLinkedPromptsFillOnlyAnEmptyComposer() {
        XCTAssertEqual(PromptLinks.threadDraftAction(currentText: "  \n", prompt: "Fix it"), .fill)
        XCTAssertEqual(PromptLinks.threadDraftAction(currentText: "Fix it", prompt: "Fix it"), .keep)
        XCTAssertEqual(PromptLinks.threadDraftAction(currentText: "Mine", prompt: "Fix it"), .ask)
    }

    func testNoticeWarnsLouderAboutHiddenCharacters() {
        XCTAssertEqual(PromptLinks.notice(hiddenCharacters: 0), "This prompt came from a link. Read it before you send.")
        XCTAssertTrue(PromptLinks.notice(hiddenCharacters: 2).hasPrefix("This prompt had hidden characters, it may be malicious."))
        XCTAssertTrue(PromptLinks.notice(hiddenCharacters: 0, modelUnavailable: true).hasSuffix("The requested model is not available, so your default is used."))
    }

    func testScratchEnvironmentPrefersTheMostRecentlyActiveCapableOne() {
        XCTAssertEqual(PromptLinks.scratchEnvironmentID(mostRecentFirst: ["a", "b", "c"], scratchCapable: ["c", "b"]), "b")
        XCTAssertEqual(PromptLinks.scratchEnvironmentID(mostRecentFirst: [], scratchCapable: ["c"]), "c")
        XCTAssertNil(PromptLinks.scratchEnvironmentID(mostRecentFirst: ["a"], scratchCapable: []))
    }
}
