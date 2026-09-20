import SwiftUI
import WebKit

/// Fence language, sandbox policy, and document assembly for `t3-html` embeds.
///
/// Everything that decides what an agent's bytes are allowed to do lives here
/// as pure values: the CSP, the wrapper document, the navigation allowlist, and
/// the height clamp. Keeping them out of the view is what makes the security
/// surface testable — no web view has to run to assert on any of it.
enum HtmlEmbed {
    /// The only fence language that becomes a live embed. Every other language
    /// stays a code block, so an agent cannot turn ```html into a running page.
    static let fenceLanguage = "t3-html"

    /// Matches the `color-scheme` declaration handed to the wrapper document.
    enum Theme: String, Equatable, Sendable {
        case light
        case dark
    }

    /// Navigation guards do not stop fetch/XHR/external subresources, so the
    /// policy — not the delegate — is what closes off network access, form
    /// submission, and `<base>` retargeting. `form-action 'none'` stops a
    /// `<form>` from POSTing content off-device even though scripting is
    /// allowed; `base-uri 'none'` stops an injected `<base>` from re-pointing
    /// every relative URL in the document at an attacker's origin.
    static let contentSecurityPolicy = [
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "img-src data:",
        "font-src data:",
        "media-src data:",
        "form-action 'none'",
        "base-uri 'none'",
    ].joined(separator: "; ")

    /// Inline embeds never clip: this is the height used before the document
    /// reports its own, not a cap.
    static let defaultHeight: CGFloat = 220
    /// Keeps a one-line embed from collapsing into an invisible sliver.
    static let minimumHeight: CGFloat = 96
    /// Not a display cap: the inline web view grows to the full reported
    /// content height so nothing is ever clipped. This bound only keeps a
    /// runaway feedback loop bounded — an embed sized in vh/% plus padding
    /// reports a taller body on every resize, which would otherwise grow
    /// without limit.
    static let runawayHeightLimit: CGFloat = 20_000

    /// Where an embed is in its life.
    ///
    /// An embed goes live only once its fence closes. Until then the source is
    /// half a document, which paints almost nothing — most embeds open with
    /// `<style>` — while costing a full web view reload per token, so a
    /// streaming embed used to read as a dead box that popped at the end.
    enum Phase: Equatable, Sendable {
        /// The fence closed: the source is final and safe to load.
        case ready
        /// The fence is still open and the turn is still going.
        case building
        /// The turn ended mid-fence. No embed is coming; say so rather than
        /// leaving a placeholder breathing forever.
        case incomplete
    }

    static func phase(terminated: Bool, isStreaming: Bool) -> Phase {
        if terminated { return .ready }
        return isStreaming ? .building : .incomplete
    }

    /// The `window.webkit.messageHandlers` name the reporter script posts to.
    static let heightMessageHandlerName = "t3HtmlEmbedHeight"
    /// Discriminates our height payload from anything else an embed posts.
    static let heightMessageType = "t3-html-embed:height"

    /// Posted on the main actor after an inline embed settles on a new height.
    ///
    /// The transcript is a `UICollectionView` with self-sizing cells, and a row
    /// that changes height after layout is exactly what such a list cannot see
    /// on its own. This is the seam the host observes to re-measure the row.
    static let contentHeightDidChangeNotification = Notification.Name(
        "codes.t3.native.html-embed.content-height-did-change"
    )

    static func isEmbedLanguage(_ language: String?) -> Bool {
        guard let language else { return false }
        return language
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() == fenceLanguage
    }

    /// Rounds up (a fractional layout height would leave a hairline of the
    /// document cut off) and clamps into the bounds above. Returns `nil` for
    /// values a document can legitimately report before it has laid out.
    static func clampedHeight(_ reported: Double) -> CGFloat? {
        guard reported.isFinite, reported > 0 else { return nil }
        return min(runawayHeightLimit, max(minimumHeight, CGFloat(reported.rounded(.up))))
    }

    /// Snippets stay inside their own document. `loadHTMLString(_:baseURL: nil)`
    /// lands on `about:blank`, so the initial load and in-document fragment
    /// links are the only navigations an embed legitimately performs.
    static func allowsNavigation(to url: URL?) -> Bool {
        guard let url else { return false }
        let absolute = url.absoluteString
        if absolute == "about:blank" || absolute.hasPrefix("about:blank#") {
            return true
        }
        return url.scheme?.lowercased() == "data"
    }

    /// Assembles the document actually handed to the web view.
    ///
    /// The CSP head must precede every untrusted byte, and inserting into agent
    /// markup with string matching is spoofable (decoy `<head>` text in comments
    /// or scripts). So the trusted head is always emitted first and the agent's
    /// document follows verbatim: the HTML parser ignores its extra doctype,
    /// merges its `<html>` attributes, and reparents its head content into the
    /// body, where `<style>`/`<script>`/`<meta>` still function. Trailing
    /// scripts are likewise reparented, so height reporting still works.
    static func document(html code: String, theme: Theme) -> String {
        let head = "\(cspMetaTag)\(headMetaTags)"
        if isFullDocument(code) {
            return "<!doctype html><html><head>\(head)</head>"
                + "\(code)\n\(heightReporterScript)</html>"
        }
        return "<!doctype html><html><head>\(head)<style>\(baseStyle(theme: theme))</style></head>"
            + "<body>\(code)\n\(heightReporterScript)</body></html>"
    }

    /// True when the agent authored a whole document rather than a fragment.
    /// Mirrors `/^\s*(?:<!doctype\b|<html\b)/i`.
    static func isFullDocument(_ code: String) -> Bool {
        let trimmed = code
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return hasTagPrefix(trimmed, "<!doctype") || hasTagPrefix(trimmed, "<html")
    }

    static let cspMetaTag =
        "<meta http-equiv=\"Content-Security-Policy\" content=\"\(contentSecurityPolicy)\">"

    private static let headMetaTags = "<meta charset=\"utf-8\">"
        + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"

    /// `color-scheme` plus system `CanvasText` lets a fragment inherit the
    /// app's appearance without the embed having to know either palette.
    private static func baseStyle(theme: Theme) -> String {
        ":root{color-scheme:\(theme.rawValue)}"
            + "html,body{margin:0;background:transparent}"
            + "body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;"
            + "font-size:14px;line-height:1.45;color:CanvasText;padding:12px;"
            + "box-sizing:border-box;overflow-wrap:break-word}"
    }

    /// `documentElement.scrollHeight` is clamped to the web view viewport, so it
    /// can never report a shrink; the body is not the scrolling box and tracks
    /// true content height in both directions. Both boxes are observed because
    /// content that grows past the viewport changes the body's box while the
    /// clamped documentElement box stays put; the bounded ticker is the last
    /// resort for embeds that lay out asynchronously (web fonts, images).
    static let heightReporterScript = """
        <script>(function(){\
        var report=function(){\
        var body=document.body;\
        var height=body?Math.max(body.scrollHeight,body.offsetHeight)\
        :document.documentElement.scrollHeight;\
        var bridge=window.webkit&&window.webkit.messageHandlers\
        &&window.webkit.messageHandlers.\(heightMessageHandlerName);\
        if(bridge){bridge.postMessage({type:"\(heightMessageType)",height:height});}};\
        var schedule=function(){\
        if(window.requestAnimationFrame){requestAnimationFrame(report);}else{report();}};\
        window.addEventListener("load",schedule);\
        if(window.ResizeObserver){var observer=new ResizeObserver(schedule);\
        observer.observe(document.documentElement);\
        if(document.body){observer.observe(document.body);}}\
        var ticks=0;var timer=setInterval(function(){report();ticks+=1;\
        if(ticks>=10){clearInterval(timer);}},500);\
        schedule();})();</script>
        """

    /// The same measurement as the reporter script, evaluated from the
    /// navigation delegate so a document whose inline script fails to run still
    /// reports a height once.
    static let heightProbeScript = """
        (function(){var b=document.body;\
        return b?Math.max(b.scrollHeight,b.offsetHeight)\
        :document.documentElement.scrollHeight;})()
        """

    private static func hasTagPrefix(_ lowercased: String, _ prefix: String) -> Bool {
        guard lowercased.hasPrefix(prefix) else { return false }
        // `\b` in the source regex: the tag name must end here rather than be
        // the start of a longer word, so `<htmlish>` is not a document.
        guard let next = lowercased.dropFirst(prefix.count).first else { return true }
        return !(next.isLetter || next.isNumber || next == "_")
    }
}

/// Whether the message around a block is still being written.
///
/// Set once per message rather than threaded through every block: only the
/// embed cares, and only to tell "still coming" from "never coming".
private struct MarkdownIsStreamingKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var markdownIsStreaming: Bool {
        get { self[MarkdownIsStreamingKey.self] }
        set { self[MarkdownIsStreamingKey.self] = newValue }
    }
}

/// What stands in for an embed whose fence has not closed.
///
/// One opacity curve on the whole stack rather than per bar, so the compositor
/// animates a single layer — the native counterpart of the web app's stepped
/// skeleton breath. Scene, visibility and reduced-motion changes stop it, the
/// same discipline every other repeating animation in the app follows.
private struct HtmlEmbedPlaceholder: View {
    let isBuilding: Bool

    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @State private var visible = false
    @State private var dimmed = false

    /// Enough shape to read as a pending embed; fixed, so the card never reflows.
    private static let barWidths: [CGFloat] = [0.4, 0.8, 0.6]
    private let barHeight: CGFloat = 10
    private var animates: Bool { isBuilding && !reduceMotion && visible && scenePhase == .active }

    var body: some View {
        Group {
            if isBuilding {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Self.barWidths, id: \.self) { width in
                        // Proportional to the card, which is the reader's whole
                        // job here: a container-relative frame would measure the
                        // transcript instead and overflow the card it sits in.
                        GeometryReader { proxy in
                            RoundedRectangle(cornerRadius: 5)
                                .fill(T3Colors.textTertiary.opacity(0.28))
                                .frame(width: proxy.size.width * width, height: barHeight)
                        }
                        .frame(height: barHeight)
                    }
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 14)
                .opacity(dimmed ? 0.55 : 1)
                .accessibilityElement()
                .accessibilityLabel("Building interactive embed")
                .onAppear { visible = true; synchronize() }
                .onDisappear { visible = false; synchronize() }
                .onChange(of: animates) { synchronize() }
            } else {
                Text("The agent stopped before finishing this embed.")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 12)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func synchronize() {
        guard animates else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { dimmed = false }
            return
        }
        withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { dimmed = true }
    }
}

/// A live, sandboxed `t3-html` embed rendered inline in the transcript.
///
/// This is the one chat block that genuinely cannot be native SwiftUI:
/// arbitrary agent-authored HTML has no native equivalent, so a locked-down
/// `WKWebView` is the renderer. Everything around it — chrome, expansion,
/// sizing — stays SwiftUI.
struct HtmlEmbedView: View {
    private let html: String
    private let terminated: Bool

    @SwiftUI.Environment(\.colorScheme) private var colorScheme
    @SwiftUI.Environment(\.markdownIsStreaming) private var isStreaming
    @State private var inlineHeight = HtmlEmbed.defaultHeight
    @State private var isExpanded = false

    init(html: String, terminated: Bool) {
        self.html = html
        self.terminated = terminated
    }

    private var phase: HtmlEmbed.Phase {
        HtmlEmbed.phase(terminated: terminated, isStreaming: isStreaming)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Rectangle()
                .fill(T3Colors.separator)
                .frame(height: 1)
            if phase == .ready {
                // The web view mounts once, with final source: no reload per
                // token, and nothing to measure until there is something to see.
                HtmlEmbedWebView(
                    document: document,
                    isScrollEnabled: false,
                    onReportedHeight: applyReportedHeight
                )
                // The embed owns its height rather than scrolling inside a fixed
                // box: the document reports what it needs and the row grows to it.
                .frame(height: inlineHeight)
            } else {
                HtmlEmbedPlaceholder(isBuilding: phase == .building)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T3Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(T3Colors.border, lineWidth: 1)
        }
        .sheet(isPresented: $isExpanded) {
            expandedEmbed
        }
    }

    private var document: String {
        HtmlEmbed.document(
            html: html,
            theme: colorScheme == .dark ? .dark : .light
        )
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Interactive embed")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(1)
            Spacer(minLength: 8)
            if phase == .building {
                Text("Building")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .padding(.trailing, 8)
            }
            if phase == .ready {
                Button {
                    isExpanded = true
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(T3Typography.control)
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(minWidth: 32, minHeight: 32)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Expand embed")
                .accessibilityHint("Opens this embed full screen")
            }
        }
        .padding(.leading, 13)
        .padding(.trailing, 5)
        .frame(minHeight: 36)
    }

    private var expandedEmbed: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("Interactive embed")
                    .font(T3Typography.navigationTitle)
                    .foregroundStyle(T3Colors.textPrimary)
                Spacer(minLength: 8)
                Button {
                    isExpanded = false
                } label: {
                    Image(systemName: "xmark")
                        .font(T3Typography.control)
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(
                            minWidth: T3Metrics.minimumTapTarget,
                            minHeight: T3Metrics.minimumTapTarget
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close embed")
            }
            .padding(.leading, 16)
            .padding(.trailing, 6)
            .padding(.vertical, 4)
            Rectangle()
                .fill(T3Colors.separator)
                .frame(height: 1)
            // Full screen is the one place the document may scroll itself: it
            // is bounded by the sheet rather than by a row that has to grow.
            HtmlEmbedWebView(
                document: document,
                isScrollEnabled: true,
                onReportedHeight: nil
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(T3Colors.surface)
    }

    private func applyReportedHeight(_ reported: Double) {
        guard let clamped = HtmlEmbed.clampedHeight(reported),
              abs(clamped - inlineHeight) > 0.5 else {
            return
        }
        inlineHeight = clamped
        // The row just changed height after it was laid out. SwiftUI resizes
        // itself; the UIKit list hosting it has to be told.
        NotificationCenter.default.post(
            name: HtmlEmbed.contentHeightDidChangeNotification,
            object: nil
        )
    }
}

/// The sandboxed web view itself.
///
/// Height arrives as a push, not a pull: the document only knows its size after
/// it has laid out, which happens long after SwiftUI asked this view how big it
/// wanted to be. `sizeThatFits` cannot express that — SwiftUI would have to be
/// asking again at the moment the answer changes — so the measurement is
/// delivered through a callback that drives `@State` on the owner, and the
/// owner sets an explicit frame. That also keeps one authority for the height:
/// the clamp in `HtmlEmbed`, applied once, rather than a size negotiation that
/// can oscillate between the layout system and the document.
private struct HtmlEmbedWebView: UIViewRepresentable {
    let document: String
    let isScrollEnabled: Bool
    /// `nil` for the expanded presentation, which scrolls instead of resizing.
    let onReportedHeight: ((Double) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Nothing an embed stores may outlive it, and no cookie or cache from
        // the app's other web content may be visible to it.
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.dataDetectorTypes = []
        configuration.userContentController.add(
            context.coordinator,
            name: HtmlEmbed.heightMessageHandlerName
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        // The card behind the web view supplies the surface colour, so the
        // document's transparent background shows the app's own theme.
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        webView.accessibilityIdentifier = "html-embed"
        apply(scrollEnabled: isScrollEnabled, to: webView)
        context.coordinator.onReportedHeight = onReportedHeight
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onReportedHeight = onReportedHeight
        apply(scrollEnabled: isScrollEnabled, to: webView)
        context.coordinator.load(document, into: webView)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.onReportedHeight = nil
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        // The content controller holds the coordinator strongly; a recycled
        // transcript cell would otherwise keep every embed it ever showed.
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: HtmlEmbed.heightMessageHandlerName
        )
    }

    private func apply(scrollEnabled: Bool, to webView: WKWebView) {
        webView.scrollView.isScrollEnabled = scrollEnabled
        // Bouncing an inline embed would drag the transcript's own scroll out
        // from under it.
        webView.scrollView.bounces = scrollEnabled
        webView.scrollView.showsVerticalScrollIndicator = scrollEnabled
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var onReportedHeight: ((Double) -> Void)?
        private var loadedDocument: String?

        /// Reloads only when the assembled document actually changed. SwiftUI
        /// re-runs `updateUIView` for unrelated reasons, and reloading would
        /// throw away whatever state the embed's own scripts hold.
        func load(_ document: String, into webView: WKWebView) {
            guard loadedDocument != document else { return }
            loadedDocument = document
            // `baseURL: nil` leaves the embed on `about:blank`: it has no origin
            // to inherit, so it cannot read app files or same-origin data.
            webView.loadHTMLString(document, baseURL: nil)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            decisionHandler(
                HtmlEmbed.allowsNavigation(to: navigationAction.request.url) ? .allow : .cancel
            )
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            measure(webView)
        }

        /// No popups: a returned web view is a new window the embed controls.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            nil
        }

        // Scripting is allowed inside the embed, so `alert`/`confirm`/`prompt`
        // are reachable. Completing them without presenting anything keeps an
        // embed from throwing modal chrome over the transcript.
        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping () -> Void
        ) {
            completionHandler()
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (Bool) -> Void
        ) {
            completionHandler(false)
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptTextInputPanelWithPrompt prompt: String,
            defaultText: String?,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (String?) -> Void
        ) {
            completionHandler(nil)
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == HtmlEmbed.heightMessageHandlerName,
                  let payload = message.body as? [String: Any],
                  payload["type"] as? String == HtmlEmbed.heightMessageType,
                  let height = payload["height"] as? Double else {
                // Ignore malformed messages from embedded scripts.
                return
            }
            onReportedHeight?(height)
        }

        private func measure(_ webView: WKWebView) {
            guard onReportedHeight != nil else { return }
            webView.evaluateJavaScript(HtmlEmbed.heightProbeScript) { [weak self] value, _ in
                guard let height = value as? Double else { return }
                self?.onReportedHeight?(height)
            }
        }
    }
}
