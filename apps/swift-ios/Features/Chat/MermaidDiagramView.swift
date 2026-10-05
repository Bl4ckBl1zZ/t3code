import SwiftUI

/// Fence language, render script, and document assembly for ```mermaid
/// diagrams. Ports upstream web's MermaidDiagram onto the sandboxed embed web
/// view: the same CSP (no network), with the bundled Mermaid build injected as
/// a trusted user script rather than loaded from anywhere.
enum MermaidDiagram {
    static let fenceLanguage = "mermaid"

    static func isMermaidLanguage(_ language: String?) -> Bool {
        language?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == fenceLanguage
    }

    /// Before the document reports its own height.
    static let defaultHeight: CGFloat = 160

    static let renderedMessageType = "t3-mermaid:rendered"
    static let errorMessageType = "t3-mermaid:error"

    /// The bundled Mermaid build (~3.5 MB), read on the first diagram shown
    /// rather than at launch.
    @MainActor static let library: String? = Bundle.main
        .url(forResource: "mermaid.min", withExtension: "js")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }

    /// The diagram source as an inert JSON data block. `<`, `>` and `&` are
    /// escaped so the source can never close the element it sits in.
    static func sourceJSON(source: String, theme: HtmlEmbed.Theme) -> String {
        let payload: [String: String] = ["source": source.trimmingCharacters(in: .whitespacesAndNewlines), "theme": theme.rawValue]
        let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
            .replacingOccurrences(of: "<", with: "\\u003c")
            .replacingOccurrences(of: ">", with: "\\u003e")
            .replacingOccurrences(of: "&", with: "\\u0026")
    }

    private static let containerStyle = "<style>body{padding:12px 13px}"
        + "#t3-mermaid{display:flex;justify-content:center}"
        + "#t3-mermaid svg{max-width:100%;height:auto}</style>"

    /// A document that renders the diagram with the trusted script.
    static func renderDocument(source: String, theme: HtmlEmbed.Theme) -> String {
        HtmlEmbed.document(
            html: containerStyle + "<div id=\"t3-mermaid\"></div>"
                + "<script type=\"application/json\" id=\"t3-mermaid-source\">"
                + sourceJSON(source: source, theme: theme) + "</script>",
            theme: theme
        )
    }

    /// A document showing an SVG Mermaid already rendered; no script needed.
    static func svgDocument(svg: String, theme: HtmlEmbed.Theme) -> String {
        HtmlEmbed.document(html: containerStyle + "<div id=\"t3-mermaid\">\(svg)</div>", theme: theme)
    }

    /// Runs after the library. Strict security and SVG labels match the web
    /// client: diagram directives cannot loosen them, and labels never mount
    /// HTML. Reports the SVG so the next showing skips Mermaid entirely.
    static let renderCall = """
        ;(function(){\
        var post=function(m){var h=window.webkit&&window.webkit.messageHandlers\
        &&window.webkit.messageHandlers.\(HtmlEmbed.trustedMessageHandlerName);if(h){h.postMessage(m);}};\
        var fail=function(e){post({type:"\(errorMessageType)",\
        message:String((e&&e.message)||e||"The diagram could not be rendered.")});};\
        try{var data=JSON.parse(document.getElementById("t3-mermaid-source").textContent);\
        var target=document.getElementById("t3-mermaid");\
        mermaid.initialize({startOnLoad:false,securityLevel:"strict",suppressErrorRendering:true,\
        secure:["secure","securityLevel","startOnLoad","maxTextSize","suppressErrorRendering",\
        "maxEdges","htmlLabels","themeCSS"],htmlLabels:false,flowchart:{htmlLabels:false},\
        theme:data.theme==="dark"?"dark":"default",\
        fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"});\
        mermaid.render("t3-mermaid-svg",data.source).then(function(r){\
        target.innerHTML=r.svg;post({type:"\(renderedMessageType)",svg:r.svg});},fail);\
        }catch(e){fail(e);}})();
        """

    // MARK: - Outcomes

    enum Outcome: Equatable {
        case rendered(svg: String)
        case failed(String)
    }

    private final class OutcomeBox: NSObject {
        let value: Outcome
        init(_ value: Outcome) { self.value = value }
    }

    /// Rendered SVGs and parse failures per source and theme. A recycled
    /// transcript cell remounts its web view; this keeps that from running
    /// Mermaid again.
    @MainActor private static let outcomes: NSCache<NSString, OutcomeBox> = {
        let cache = NSCache<NSString, OutcomeBox>()
        cache.countLimit = 64
        cache.totalCostLimit = 8 * 1_024 * 1_024
        return cache
    }()

    private static func key(source: String, theme: HtmlEmbed.Theme) -> NSString {
        "\(theme.rawValue)\n\(source.trimmingCharacters(in: .whitespacesAndNewlines))" as NSString
    }

    @MainActor static func cachedOutcome(source: String, theme: HtmlEmbed.Theme) -> Outcome? {
        outcomes.object(forKey: key(source: source, theme: theme))?.value
    }

    @MainActor static func cachedFailure(source: String, theme: HtmlEmbed.Theme) -> String? {
        if case let .failed(message)? = cachedOutcome(source: source, theme: theme) { return message }
        return nil
    }

    /// Reads a message from the render script. Nil for anything else.
    static func outcome(from payload: [String: Any]) -> Outcome? {
        switch payload["type"] as? String {
        case renderedMessageType:
            guard let svg = payload["svg"] as? String, !svg.isEmpty else { return nil }
            return .rendered(svg: svg)
        case errorMessageType:
            return .failed((payload["message"] as? String) ?? "The diagram could not be rendered.")
        default:
            return nil
        }
    }

    @MainActor static func record(_ outcome: Outcome, source: String, theme: HtmlEmbed.Theme) {
        let cost = switch outcome {
        case let .rendered(svg): svg.utf8.count
        case let .failed(message): message.utf8.count
        }
        outcomes.setObject(OutcomeBox(outcome), forKey: key(source: source, theme: theme), cost: cost)
    }

    /// What the web view loads: the remembered SVG, or a render with the
    /// bundled library. Nil when the library is missing from the bundle.
    @MainActor static func plan(source: String, theme: HtmlEmbed.Theme) -> (document: String, script: String?)? {
        if case let .rendered(svg)? = cachedOutcome(source: source, theme: theme) {
            return (svgDocument(svg: svg, theme: theme), nil)
        }
        guard let library else { return nil }
        return (renderDocument(source: source, theme: theme), library + renderCall)
    }
}

/// Fixes the document a diagram view loads for each source and theme, so a
/// render that lands in the cache mid-flight does not reload the web view.
@MainActor
private final class MermaidPlanMemo {
    private var key: String?
    private var plan: (document: String, script: String?)?

    func plan(source: String, theme: HtmlEmbed.Theme) -> (document: String, script: String?)? {
        let key = "\(theme.rawValue)\n\(source)"
        if self.key != key {
            self.key = key
            plan = MermaidDiagram.plan(source: source, theme: theme)
        }
        return plan
    }
}

/// A finished ```mermaid fence, drawn. Lives inside the code block card, which
/// owns the show-code toggle and falls back to the source on failure.
struct MermaidDiagramView: View {
    let source: String
    let theme: HtmlEmbed.Theme
    /// True for the expanded sheet, which scrolls and zooms instead of growing.
    let isScrollEnabled: Bool
    let onFailure: (String) -> Void

    @State private var height = MermaidDiagram.defaultHeight
    @State private var memo = MermaidPlanMemo()

    var body: some View {
        if let plan = memo.plan(source: source, theme: theme) {
            HtmlEmbedWebView(
                document: plan.document,
                isScrollEnabled: isScrollEnabled,
                onReportedHeight: isScrollEnabled ? nil : applyReportedHeight,
                trustedScript: plan.script,
                onTrustedMessage: handle
            )
            .frame(height: isScrollEnabled ? nil : height)
            .accessibilityLabel("Mermaid diagram")
        } else {
            Color.clear
                .frame(height: 1)
                .onAppear { onFailure("The diagram renderer is not available in this build.") }
        }
    }

    private func handle(_ payload: [String: Any]) {
        guard let outcome = MermaidDiagram.outcome(from: payload) else { return }
        MermaidDiagram.record(outcome, source: source, theme: theme)
        if case let .failed(message) = outcome { onFailure(message) }
    }

    private func applyReportedHeight(_ reported: Double) {
        guard let clamped = HtmlEmbed.clampedHeight(reported), abs(clamped - height) > 0.5 else { return }
        height = clamped
        // The transcript's self-sizing cells have to be told the row grew.
        NotificationCenter.default.post(name: HtmlEmbed.contentHeightDidChangeNotification, object: nil)
    }
}
