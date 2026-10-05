import WebKit
import XCTest

@testable import T3Code

/// ```mermaid fences render as diagrams inside the embed sandbox. What matters:
/// which fences qualify and when, that the source cannot escape its data
/// block, and that the bundled library actually renders under the embed CSP.
@MainActor
final class MermaidDiagramTests: XCTestCase {
    func testOnlyMermaidFencesBecomeDiagramsAndKnowWhenTheyClosed() {
        let document = MarkdownDocument(
            parsing: """
            ```Mermaid
            graph TD; A-->B
            ```

            ```mermaidjs
            not a diagram
            ```

            ```mermaid
            graph LR; still
            """
        )

        XCTAssertEqual(
            document.blocks,
            [
                .mermaid(source: "graph TD; A-->B", terminated: true),
                .codeBlock(language: "mermaidjs", code: "not a diagram"),
                .mermaid(source: "graph LR; still", terminated: false),
            ]
        )
    }

    func testRenderedDocumentCarriesTheDiagramThroughAndCitationsCountItsSource() {
        let cache = MarkdownRenderCache(documentCountLimit: 8, documentCostLimit: 64_000)
        let rendered = cache.documentImmediately(
            for: MarkdownContentRevision("Intro\n\n```mermaid\ngraph TD; A-->B\n```")
        )
        XCTAssertEqual(rendered?.blocks.last, .mermaid(source: "graph TD; A-->B", terminated: true))
        // Quotes are matched against the text the reader can select, which
        // includes the diagram source.
        XCTAssertEqual(rendered?.citationText, "Intro\ngraph TD; A-->B")
    }

    func testSourceCannotCloseItsDataBlock() {
        let json = MermaidDiagram.sourceJSON(source: "A[\"</script><script>alert(1)</script>\"] & B", theme: .dark)
        XCTAssertFalse(json.contains("<"))
        XCTAssertFalse(json.contains(">"))
        XCTAssertFalse(json.contains("&"))
        let decoded = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: String]
        XCTAssertEqual(decoded?["source"], "A[\"</script><script>alert(1)</script>\"] & B")
        XCTAssertEqual(decoded?["theme"], "dark")
        // The document keeps the embed CSP ahead of everything else.
        XCTAssertTrue(MermaidDiagram.renderDocument(source: "graph TD", theme: .light).contains(HtmlEmbed.cspMetaTag))
    }

    func testRenderMessagesBecomeOutcomesAndAreRemembered() {
        XCTAssertEqual(
            MermaidDiagram.outcome(from: ["type": MermaidDiagram.renderedMessageType, "svg": "<svg/>"]),
            .rendered(svg: "<svg/>")
        )
        XCTAssertEqual(
            MermaidDiagram.outcome(from: ["type": MermaidDiagram.errorMessageType, "message": "Parse error"]),
            .failed("Parse error")
        )
        XCTAssertNil(MermaidDiagram.outcome(from: ["type": "t3-html-embed:height", "height": 10]))

        let source = "graph TD; cached-\(UUID().uuidString)"
        XCTAssertNil(MermaidDiagram.cachedFailure(source: source, theme: .light))
        MermaidDiagram.record(.failed("Parse error"), source: source, theme: .light)
        XCTAssertEqual(MermaidDiagram.cachedFailure(source: source, theme: .light), "Parse error")
        XCTAssertNil(MermaidDiagram.cachedFailure(source: source, theme: .dark))

        MermaidDiagram.record(.rendered(svg: "<svg id=\"x\"/>"), source: source, theme: .dark)
        let plan = MermaidDiagram.plan(source: source, theme: .dark)
        XCTAssertNil(plan?.script, "a remembered SVG needs no Mermaid run")
        XCTAssertTrue(plan?.document.contains("<svg id=\"x\"/>") == true)
    }

    /// The bundled build has to run as a user script under the embed's CSP,
    /// which admits inline script only and no network.
    func testBundledMermaidRendersInsideTheSandbox() throws {
        let library = try XCTUnwrap(MermaidDiagram.library, "mermaid.min.js is missing from the app bundle")
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let receiver = MessageReceiver()
        configuration.userContentController.add(receiver, name: HtmlEmbed.trustedMessageHandlerName)
        configuration.userContentController.addUserScript(
            WKUserScript(source: library + MermaidDiagram.renderCall, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 600), configuration: configuration)
        let rendered = expectation(description: "diagram rendered")
        receiver.onMessage = { payload in
            if MermaidDiagram.outcome(from: payload) != nil { rendered.fulfill() }
        }

        webView.loadHTMLString(MermaidDiagram.renderDocument(source: "graph TD\n  A[Start] --> B[Done]", theme: .light), baseURL: nil)
        wait(for: [rendered], timeout: 30)

        guard case let .rendered(svg)? = receiver.payload.flatMap(MermaidDiagram.outcome(from:)) else {
            return XCTFail("render failed: \(String(describing: receiver.payload))")
        }
        XCTAssertTrue(svg.contains("<svg"))
        XCTAssertTrue(svg.contains("Start"))
        configuration.userContentController.removeScriptMessageHandler(forName: HtmlEmbed.trustedMessageHandlerName)
    }
}

private final class MessageReceiver: NSObject, WKScriptMessageHandler {
    var payload: [String: Any]?
    var onMessage: (([String: Any]) -> Void)?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        payload = body
        onMessage?(body)
    }
}
