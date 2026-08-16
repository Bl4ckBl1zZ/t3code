import Foundation
import XCTest

@testable import T3Code

/// The `t3-html` embed is the one chat block that executes what an agent wrote,
/// so the parts worth testing are the parts that decide what it may do: which
/// fence becomes an embed at all, what wraps the agent's bytes, and what the
/// sandbox refuses. The web view itself is not exercised here.
final class HtmlEmbedTests: XCTestCase {

    // MARK: Fence detection

    func testT3HtmlFenceBecomesAnEmbedBlock() {
        let document = MarkdownDocument(
            parsing: """
            Before

            ```t3-html
            <p>Hello</p>
            <button onclick="alert(1)">Go</button>
            ```

            After
            """
        )

        XCTAssertEqual(
            document.blocks,
            [
                .paragraph("Before"),
                .htmlEmbed("<p>Hello</p>\n<button onclick=\"alert(1)\">Go</button>"),
                .paragraph("After"),
            ]
        )
    }

    func testFenceLanguageMatchIgnoresCaseAndSurroundingSpace() {
        XCTAssertTrue(HtmlEmbed.isEmbedLanguage("t3-html"))
        XCTAssertTrue(HtmlEmbed.isEmbedLanguage("T3-HTML"))
        XCTAssertTrue(HtmlEmbed.isEmbedLanguage("  t3-Html \n"))
        XCTAssertFalse(HtmlEmbed.isEmbedLanguage(nil))
        XCTAssertFalse(HtmlEmbed.isEmbedLanguage(""))
        XCTAssertFalse(HtmlEmbed.isEmbedLanguage("t3-htmlx"))
        XCTAssertFalse(HtmlEmbed.isEmbedLanguage("t3html"))
    }

    /// The whole point of a dedicated language: markup an agent labels with any
    /// other fence stays inert source.
    func testOtherLanguagesStayCodeBlocks() {
        let document = MarkdownDocument(
            parsing: """
            ```html
            <script>fetch("https://example.com")</script>
            ```

            ```
            <p>plain</p>
            ```

            ```svg
            <svg />
            ```
            """
        )

        XCTAssertEqual(
            document.blocks,
            [
                .codeBlock(
                    language: "html",
                    code: "<script>fetch(\"https://example.com\")</script>"
                ),
                .codeBlock(language: nil, code: "<p>plain</p>"),
                .codeBlock(language: "svg", code: "<svg />"),
            ]
        )
    }

    func testTildeFenceAndInfoStringSuffixStillProduceAnEmbed() {
        let document = MarkdownDocument(
            parsing: """
            ~~~t3-html title="Chart"
            <p>Tilde</p>
            ~~~
            """
        )

        XCTAssertEqual(document.blocks, [.htmlEmbed("<p>Tilde</p>")])
    }

    /// Streaming shows a fence long before its closing marker arrives; the
    /// partial body is still an embed (the view debounces before loading it).
    func testUnclosedFenceStillProducesAnEmbed() {
        let document = MarkdownDocument(
            parsing: """
            ```t3-html
            <p>Still streaming
            """
        )

        XCTAssertEqual(document.blocks, [.htmlEmbed("<p>Still streaming")])
    }

    func testRenderedDocumentCarriesTheEmbedThrough() {
        let cache = MarkdownRenderCache(documentCountLimit: 8, documentCostLimit: 64_000)
        let revision = MarkdownContentRevision("```t3-html\n<p>Hi</p>\n```")

        let rendered = cache.documentImmediately(for: revision)

        XCTAssertEqual(rendered?.blocks, [.htmlEmbed("<p>Hi</p>")])
    }

    // MARK: Content Security Policy

    func testContentSecurityPolicyIsTheHardenedEmbedPolicy() {
        let expected = """
            default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; \
            img-src data:; font-src data:; media-src data:; form-action 'none'; \
            base-uri 'none'
            """

        XCTAssertEqual(HtmlEmbed.contentSecurityPolicy, expected)
    }

    /// Navigation guards do not stop fetch/XHR/subresources, so these four
    /// directives are the actual sandbox and are asserted individually.
    func testPolicyBlocksNetworkFormActionAndBaseUri() {
        let policy = HtmlEmbed.contentSecurityPolicy
        XCTAssertTrue(policy.contains("default-src 'none'"))
        XCTAssertTrue(policy.contains("form-action 'none'"))
        XCTAssertTrue(policy.contains("base-uri 'none'"))
        XCTAssertFalse(policy.contains("connect-src"))
        XCTAssertFalse(policy.contains("https:"))
    }

    // MARK: Document assembly

    func testFragmentIsWrappedWithThePolicyHeadAndThemedBaseStyle() {
        let document = HtmlEmbed.document(html: "<p>Hi</p>", theme: .dark)

        XCTAssertTrue(document.hasPrefix("<!doctype html><html><head>\(HtmlEmbed.cspMetaTag)"))
        XCTAssertTrue(document.contains(":root{color-scheme:dark}"))
        XCTAssertTrue(document.contains("<body><p>Hi</p>"))
        XCTAssertTrue(document.contains(HtmlEmbed.heightReporterScript))
        XCTAssertTrue(document.hasSuffix("</body></html>"))
    }

    func testFragmentBaseStyleFollowsTheColorScheme() {
        let light = HtmlEmbed.document(html: "<p>Hi</p>", theme: .light)

        XCTAssertTrue(light.contains(":root{color-scheme:light}"))
        XCTAssertFalse(light.contains("color-scheme:dark"))
        // System colours, so an embed that sets nothing stays legible in both.
        XCTAssertTrue(light.contains("color:CanvasText"))
        XCTAssertTrue(light.contains("background:transparent"))
    }

    /// A full document is appended verbatim rather than merged: the parser
    /// reparents its head into the body, and the trusted head still comes first.
    func testFullDocumentIsAppendedAfterThePolicyHead() {
        let code = "<!DOCTYPE html>\n<html><head><title>Chart</title></head><body>x</body></html>"
        let document = HtmlEmbed.document(html: code, theme: .light)

        XCTAssertTrue(document.hasPrefix("<!doctype html><html><head>\(HtmlEmbed.cspMetaTag)"))
        XCTAssertTrue(document.contains(code))
        XCTAssertTrue(document.contains(HtmlEmbed.heightReporterScript))
        // No second wrapper body/style around a document that has its own.
        XCTAssertFalse(document.contains("color-scheme:light"))
        XCTAssertTrue(document.hasSuffix("</html>"))
    }

    func testFullDocumentDetectionMatchesDoctypeAndHtmlOnly() {
        XCTAssertTrue(HtmlEmbed.isFullDocument("  \n<!doctype html><html></html>"))
        XCTAssertTrue(HtmlEmbed.isFullDocument("<!DOCTYPE HTML>"))
        XCTAssertTrue(HtmlEmbed.isFullDocument("<html lang=\"en\">"))
        XCTAssertTrue(HtmlEmbed.isFullDocument("<html>"))
        XCTAssertFalse(HtmlEmbed.isFullDocument("<htmlish>"))
        XCTAssertFalse(HtmlEmbed.isFullDocument("<div><html></div>"))
        XCTAssertFalse(HtmlEmbed.isFullDocument(""))
    }

    /// Deciding where to insert the policy by matching the agent's own markup
    /// would be spoofable, so the head is always emitted first. A decoy `<head>`
    /// must not end up ahead of the policy.
    func testDecoyHeadInAgentMarkupStaysAfterThePolicy() {
        let code = "<!-- <head><meta http-equiv=\"Content-Security-Policy\" content=\"*\"> -->"
        let document = HtmlEmbed.document(html: code, theme: .light)

        let policyIndex = document.range(of: HtmlEmbed.cspMetaTag)?.lowerBound
        let decoyIndex = document.range(of: code)?.lowerBound
        XCTAssertNotNil(policyIndex)
        XCTAssertNotNil(decoyIndex)
        if let policyIndex, let decoyIndex {
            XCTAssertLessThan(policyIndex, decoyIndex)
        }
    }

    func testReporterScriptPostsHeightsThroughTheNamedBridge() {
        let script = HtmlEmbed.heightReporterScript

        XCTAssertTrue(script.contains("window.webkit.messageHandlers.t3HtmlEmbedHeight"))
        XCTAssertTrue(script.contains(HtmlEmbed.heightMessageType))
        // Measured on the body, which — unlike documentElement — is not the
        // scrolling box and can therefore report a shrink as well as growth.
        XCTAssertTrue(script.contains("Math.max(body.scrollHeight,body.offsetHeight)"))
        XCTAssertTrue(script.contains("ResizeObserver"))
    }

    // MARK: Height clamping

    func testReportedHeightsAreRoundedUpAndClamped() {
        XCTAssertEqual(HtmlEmbed.clampedHeight(400), 400)
        XCTAssertEqual(HtmlEmbed.clampedHeight(220.2), 221)
        // Below the floor an embed would be an unreadable sliver.
        XCTAssertEqual(HtmlEmbed.clampedHeight(10), HtmlEmbed.minimumHeight)
        // Not a display cap: only a bound on a vh-sized embed's feedback loop.
        XCTAssertEqual(HtmlEmbed.clampedHeight(1_000_000), HtmlEmbed.runawayHeightLimit)
    }

    func testUnusableReportedHeightsAreRejected() {
        XCTAssertNil(HtmlEmbed.clampedHeight(0))
        XCTAssertNil(HtmlEmbed.clampedHeight(-12))
        XCTAssertNil(HtmlEmbed.clampedHeight(.nan))
        XCTAssertNil(HtmlEmbed.clampedHeight(.infinity))
    }

    // MARK: Navigation

    func testOnlyTheEmbedsOwnDocumentMayLoad() {
        XCTAssertTrue(HtmlEmbed.allowsNavigation(to: URL(string: "about:blank")))
        XCTAssertTrue(HtmlEmbed.allowsNavigation(to: URL(string: "about:blank#section")))
        XCTAssertTrue(HtmlEmbed.allowsNavigation(to: URL(string: "data:text/html,<p>x</p>")))
    }

    func testNavigationAwayFromTheEmbedIsRefused() {
        for candidate in [
            "https://example.com",
            "http://example.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "t3code://thread/1",
            "about:srcdoc",
            "about:blankish",
        ] {
            XCTAssertFalse(
                HtmlEmbed.allowsNavigation(to: URL(string: candidate)),
                "\(candidate) must not be allowed to load"
            )
        }
        XCTAssertFalse(HtmlEmbed.allowsNavigation(to: nil))
    }
}
