import Observation
import SwiftUI
import UIKit
import WebKit

// An MCP App inline in the thread: the document the server captured, in an
// opaque-origin iframe inside a WKWebView, speaking the MCP Apps bridge through
// `McpAppHost`. Full screen is a separate presentation with its own document;
// a web view cannot move between the two without reloading, so the inline one
// is torn down while full screen is open and comes back fresh afterwards.

/// The environment calls an MCP App row needs. Optional on purpose: a client
/// that cannot host apps shows them as the plain tool calls they are.
@MainActor
protocol FeatureMcpAppHosting: FeatureClient {
    /// A short-lived URL for the app's captured document.
    func mcpAppDocumentURL(threadID: String, app: McpAppReference) async throws -> URL
    func mcpAppToolInfo(threadID: String, sourceThreadID: String, itemID: String, name: String) async throws -> McpAppToolInfo
    func mcpAppCallTool(
        threadID: String, sourceThreadID: String, itemID: String,
        name: String, arguments: [String: JSONValue]
    ) async throws -> JSONValue
    func mcpAppReadResource(threadID: String, sourceThreadID: String, itemID: String, uri: String) async throws -> JSONValue
    /// Informs the next turn of `threadID`, the thread on screen.
    func mcpAppUpdateModelContext(
        threadID: String, sourceThreadID: String, itemID: String,
        content: [JSONValue]?, structuredContent: [String: JSONValue]?
    ) async throws
}

/// One app a row or the full-screen presentation shows. The app runs against
/// the thread and item that produced it, which a fork shares with its source.
struct McpAppPresentation: Identifiable, Equatable {
    let id: String
    let app: McpAppReference
    let sourceThreadID: String
    let itemID: String
    let revision: String
}

/// Per-thread-screen state the app rows share: which app is full screen,
/// whether the agent waits on the user, and whether the server lacks the
/// `mcpApps.*` RPCs (then every row falls back to its plain tool call).
@MainActor @Observable
final class ThreadMcpApps {
    @ObservationIgnored let client: any FeatureMcpAppHosting
    /// The thread on screen, as the feature layer routes it.
    @ObservationIgnored var threadID: String
    var fullscreen: McpAppPresentation?
    var awaitingUser = false
    var unsupported = false

    init(client: any FeatureMcpAppHosting, threadID: String) {
        self.client = client
        self.threadID = threadID
    }
}

private struct ThreadMcpAppsKey: EnvironmentKey {
    static let defaultValue: ThreadMcpApps? = nil
}

extension EnvironmentValues {
    var threadMcpApps: ThreadMcpApps? {
        get { self[ThreadMcpAppsKey.self] }
        set { self[ThreadMcpAppsKey.self] = newValue }
    }
}

enum McpAppLayout {
    /// The feed reserves a fixed box for an app; a taller app scrolls inside it.
    static let inlineHeight: CGFloat = 420
    /// Largest file an app may hand the user through `ui/download-file`.
    static let maxDownloadBytes = 25 * 1024 * 1024
    static let messageHandlerName = "t3McpApp"
}

/// The tiny page the web view loads. It hosts the app in a real opaque-origin
/// iframe, so the app's `window.parent` and the source of host replies are a
/// real window, which the MCP Apps SDK requires. It only relays: app to native
/// wrapped in a per-view secret, and native replies to the app. WebKit exposes
/// message handlers to every frame, so anything without the secret, or not
/// from the main frame, is dropped. Once the app frame loads a second time (it
/// navigated itself) the page stops relaying rather than let a page T3 never
/// served pose as the app.
enum McpAppFrameDocument {
    static let sandbox = "allow-scripts allow-forms"

    static func outer(src: URL, allow: String, secret: String) -> String {
        let attribute = { (value: String) in
            value.replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "\"", with: "&quot;")
                .replacingOccurrences(of: "<", with: "&lt;")
        }
        return "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            + "<style>html,body{margin:0;height:100%;background:transparent}"
            + "iframe{border:0;display:block;width:100%;height:100%}</style></head>"
            + "<body><iframe id=\"app\" sandbox=\"\(sandbox)\" allow=\"\(attribute(allow))\"></iframe>"
            + "<script>(function(){var frame=document.getElementById(\"app\"),secret=\(jsString(secret)),loads=0,live=true;"
            + "var send=function(m){try{window.webkit.messageHandlers.\(McpAppLayout.messageHandlerName)"
            + ".postMessage(JSON.stringify({secret:secret,message:m}));}catch(e){}};"
            + "frame.addEventListener(\"load\",function(){loads+=1;if(loads>1&&live){live=false;send({t3:\"navigated\"});}});"
            + "window.addEventListener(\"message\",function(e){if(live&&e.source===frame.contentWindow)send(e.data);});"
            + "window.__t3McpAppReceive=function(m){if(live&&frame.contentWindow)frame.contentWindow.postMessage(m,\"*\");};"
            + "frame.src=\(jsString(src.absoluteString));})();</script></body></html>"
    }

    /// A JS string literal that cannot close the script element it sits in.
    static func jsString(_ value: String) -> String {
        let data = (try? JSONEncoder.t3Intermediate.encode(value)) ?? Data("\"\"".utf8)
        return String(decoding: data, as: UTF8.self)
            .replacingOccurrences(of: "<", with: "\\u003c")
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }
}

/// A question the app is waiting on, shown as an alert.
struct McpAppApproval: Identifiable {
    let id = UUID()
    let title: String
    let message: String
    let action: String
    let resolve: (Bool) -> Void
}

/// Files an approved download hands to the share sheet.
struct McpAppSharedFiles: Identifiable {
    let id = UUID()
    let urls: [URL]
}

/// One loaded document of one app and the bridge to it.
@MainActor @Observable
final class McpAppSession {
    enum Phase: Equatable {
        case loading
        case ready(URL)
        case unsupported
        case failed
        case navigatedAway
        case crashed
    }

    let target: McpAppPresentation
    let mode: McpAppDisplayMode
    private(set) var phase: Phase = .loading
    /// Bumped to load a fresh web view and document (after a crash).
    private(set) var generation = 0
    /// The app asked to be closed; the row offers to bring it back.
    private(set) var closed = false
    private(set) var approval: McpAppApproval?
    var sharedFiles: McpAppSharedFiles?

    @ObservationIgnored let secret = UUID().uuidString
    @ObservationIgnored private let apps: ThreadMcpApps
    @ObservationIgnored private(set) var host: McpAppHost?
    @ObservationIgnored weak var webView: WKWebView?
    @ObservationIgnored private var queuedApprovals: [McpAppApproval] = []
    @ObservationIgnored private var toolDefinition: JSONValue?
    @ObservationIgnored private var toolCall: (arguments: JSONValue?, result: JSONValue?)?
    @ObservationIgnored private var restarted = false
    @ObservationIgnored private var started = false
    /// The view went away; coming back loads a fresh document.
    @ObservationIgnored private var stopped = false
    /// The load in progress; an older one that finishes late changes nothing.
    @ObservationIgnored private var currentLoad = UUID()
    // Read by the host on every message, so it sees current values without
    // being rebuilt (which would drop the app's session).
    @ObservationIgnored var containerSize: CGSize = .zero
    @ObservationIgnored var horizontalInsets: (left: Double, right: Double) = (0, 0)
    @ObservationIgnored var isDark = false
    @ObservationIgnored var openURL: (URL) -> Void = { _ in }
    /// Full screen only: leaves it, back to the inline row.
    @ObservationIgnored var onExitFullscreen: () -> Void = {}

    init(target: McpAppPresentation, mode: McpAppDisplayMode, apps: ThreadMcpApps) {
        self.target = target
        self.mode = mode
        self.apps = apps
    }

    private var app: McpAppReference { target.app }

    func start() async {
        if stopped {
            // Back on screen after its teardown: a new document and host,
            // under a fresh URL.
            stopped = false
            started = false
            host = nil
            phase = .loading
            generation += 1
        }
        guard !started else { return }
        started = true
        let load = UUID()
        currentLoad = load
        let client = apps.client
        let threadID = apps.threadID
        let target = target
        // Both in flight at once; the definition rides on `ui/initialize`, and
        // its RPC is also how an older server says it has no app support.
        let info = Task { try await client.mcpAppToolInfo(
            threadID: threadID, sourceThreadID: target.sourceThreadID, itemID: target.itemID, name: target.app.tool
        ) }
        let document = Task { try await client.mcpAppDocumentURL(threadID: threadID, app: target.app) }
        let infoResult = await info.result
        guard currentLoad == load else { return }
        switch infoResult {
        case let .failure(error) where (error as? RPCError).map(Self.isUnsupported) == true:
            document.cancel()
            apps.unsupported = true
            phase = .unsupported
            return
        case let .success(value):
            toolDefinition = value.tool
        case .failure:
            // Only the definition is missing; the app still runs.
            break
        }
        let documentResult = await document.result
        guard currentLoad == load else { return }
        guard case let .success(url) = documentResult else {
            phase = .failed
            return
        }
        makeHost()
        phase = .ready(url)
        // The wire timeline omits the call's input and result; the app needs both.
        if let item = try? await client.loadTurnItem(
            threadID: threadID, sourceThreadID: target.sourceThreadID,
            itemID: target.itemID, revision: target.revision
        ), currentLoad == load, case let .dynamicTool(_, input, output) = item.payload {
            toolCall = (input, output?["result"])
            host?.setToolCall(arguments: input, result: output?["result"])
        }
    }

    private static func isUnsupported(_ error: RPCError) -> Bool {
        if case .unsupportedMethod = error { return true }
        return false
    }

    /// The view is going away: the app gets its teardown request (an unmount
    /// cannot wait for the answer), and anything it waits on is declined.
    func stop() {
        guard started else { return }
        stopped = true
        declineApprovals()
        sharedFiles = nil
        if let host { Task { await host.teardown() } }
    }

    func updateHostContext() {
        host?.updateHostContext()
    }

    // MARK: Web view events

    func attach(_ webView: WKWebView) {
        self.webView = webView
    }

    func receive(envelope text: String, isMainFrame: Bool) {
        guard isMainFrame,
              let envelope = try? JSONDecoder.t3.decode(JSONValue.self, from: Data(text.utf8)),
              envelope["secret"] == .string(secret),
              let message = envelope["message"] else { return }
        if message["t3"] == .string("navigated") {
            host?.dispose()
            declineApprovals()
            phase = .navigatedAway
            return
        }
        host?.receive(message)
    }

    /// The OS reclaimed the web process. Reloaded once, with a new document
    /// and host; an app that keeps crashing its process is not reloaded forever.
    func webContentProcessDidTerminate() {
        guard !restarted else {
            host?.dispose()
            phase = .crashed
            return
        }
        restarted = true
        reloadDocument()
    }

    /// Brings a closed app back as a new document, under a freshly minted
    /// URL: the first one's token may have expired.
    func reopen() {
        host?.dispose()
        host = nil
        started = false
        phase = .loading
        closed = false
    }

    private func reloadDocument() {
        host?.dispose()
        declineApprovals()
        makeHost()
        if let toolCall { host?.setToolCall(arguments: toolCall.arguments, result: toolCall.result) }
        generation += 1
    }

    private func deliver(_ message: JSONValue) {
        guard let webView, let data = try? JSONEncoder.t3Intermediate.encode(message) else { return }
        webView.callAsyncJavaScript(
            "window.__t3McpAppReceive&&window.__t3McpAppReceive(JSON.parse(m));",
            arguments: ["m": String(decoding: data, as: UTF8.self)],
            in: nil,
            in: .page,
            completionHandler: nil
        )
    }

    // MARK: Approvals

    func resolveApproval(_ approved: Bool) {
        guard let current = approval else { return }
        approval = nil
        current.resolve(approved)
        // After the alert that answered has gone, so its dismissal cannot
        // answer the next one too.
        Task { @MainActor [weak self] in self?.presentNextApproval() }
    }

    private func ask(_ title: String, _ message: String, action: String) async -> Bool {
        await withCheckedContinuation { continuation in
            queuedApprovals.append(McpAppApproval(
                title: title,
                message: message.count > 1_200 ? String(message.prefix(1_200)) + "…" : message,
                action: action,
                resolve: { continuation.resume(returning: $0) }
            ))
            presentNextApproval()
        }
    }

    private func presentNextApproval() {
        guard approval == nil, !queuedApprovals.isEmpty else { return }
        approval = queuedApprovals.removeFirst()
    }

    private func declineApprovals() {
        let waiting = queuedApprovals + (approval.map { [$0] } ?? [])
        queuedApprovals = []
        approval = nil
        waiting.forEach { $0.resolve(false) }
    }

    // MARK: Host

    private func hostContext() -> McpAppHostContext {
        McpAppHostContext(
            theme: isDark ? "dark" : "light",
            styleVariables: McpAppStyleVariables.variables(McpAppTheme.roles(dark: isDark)),
            displayMode: mode,
            width: containerSize.width,
            height: mode == .inline ? McpAppLayout.inlineHeight : containerSize.height,
            locale: Locale.current.identifier(.bcp47),
            timeZone: TimeZone.current.identifier,
            userAgent: "t3-code/\(Self.appVersion)",
            // Full screen keeps the top and bottom for its bar and the home
            // indicator; only the sides reach the app.
            safeAreaInsets: mode == .fullscreen ? (0, horizontalInsets.right, 0, horizontalInsets.left) : (0, 0, 0, 0),
            toolDefinition: toolDefinition
        )
    }

    private static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    private func makeHost() {
        let client = apps.client
        let apps = apps
        let target = target
        let server = app.server
        func scope() -> (threadID: String, source: String, item: String) {
            (apps.threadID, target.sourceThreadID, target.itemID)
        }
        host = McpAppHost(app: app, hostVersion: Self.appVersion, callbacks: .init(
            post: { [weak self] in self?.deliver($0) },
            hostContext: { [weak self] in
                self?.hostContext() ?? McpAppHostContext(
                    theme: "light", styleVariables: [:], displayMode: .inline, width: 0, height: 0,
                    locale: "en", timeZone: "UTC", userAgent: "t3-code"
                )
            },
            callTool: { [weak self] name, arguments in
                let (threadID, source, item) = scope()
                let info = try await client.mcpAppToolInfo(threadID: threadID, sourceThreadID: source, itemID: item, name: name)
                guard info.callable else { throw McpAppHostRefusal("This app cannot call that tool.") }
                if !info.readOnly {
                    let approved = await self?.ask(
                        "Allow \(server) to run \(info.title ?? name)?",
                        McpAppSession.prettyJSON(.object(arguments)),
                        action: "Allow"
                    ) ?? false
                    guard approved else { throw McpAppHostRefusal("Declined by the user.") }
                }
                return try await client.mcpAppCallTool(
                    threadID: threadID, sourceThreadID: source, itemID: item, name: name, arguments: arguments
                )
            },
            readResource: { uri in
                let (threadID, source, item) = scope()
                return try await client.mcpAppReadResource(threadID: threadID, sourceThreadID: source, itemID: item, uri: uri)
            },
            openLink: { [weak self] url in
                // A web view cannot tell whether the reader just tapped the
                // app, so it asks rather than let an app leave T3 on a timer.
                guard let self, await self.ask("Open a link from \(server)?", url.absoluteString, action: "Open") else {
                    throw McpAppHostRefusal("Declined by the user.")
                }
                self.openURL(url)
            },
            sendMessage: { [weak self] text in
                guard let self, await self.ask("Send this message from \(server)?", text, action: "Send") else {
                    throw McpAppHostRefusal("Declined by the user.")
                }
                // A normal send, which the server queues behind a running
                // turn rather than steering it.
                try await client.sendMessage(threadID: apps.threadID, text: text, selection: nil)
            },
            updateModelContext: { content, structured in
                let (threadID, source, item) = scope()
                try await client.mcpAppUpdateModelContext(
                    threadID: threadID, sourceThreadID: source, itemID: item,
                    content: content, structuredContent: structured
                )
            },
            requestDisplayMode: { [weak self] mode in
                await self?.requestDisplayMode(mode) ?? .inline
            },
            downloadFile: { [weak self] files in
                guard let self else { throw McpAppHostRefusal("The app was closed.") }
                try await self.download(files)
            },
            onRequestTeardown: { [weak self] in
                guard let self, let host = self.host else { return }
                Task { @MainActor in
                    await host.teardown()
                    if self.mode == .fullscreen { self.onExitFullscreen() } else { self.closed = true }
                }
            }
        ))
    }

    private func requestDisplayMode(_ mode: McpAppDisplayMode) async -> McpAppDisplayMode {
        switch (self.mode, mode) {
        case (.inline, .fullscreen):
            // Full screen would cover the approval or question the agent
            // waits on, or a question this app is asking; one app at a time.
            guard !apps.awaitingUser, approval == nil, apps.fullscreen == nil else { return .inline }
            await host?.teardown()
            // The wait may have let an approval arrive: the row reloads inline.
            guard !apps.awaitingUser, apps.fullscreen == nil else {
                reloadDocument()
                return .inline
            }
            apps.fullscreen = target
            return .fullscreen
        case (.fullscreen, .inline):
            await host?.teardown()
            onExitFullscreen()
            return .inline
        default:
            return self.mode
        }
    }

    private func download(_ files: [McpAppDownload]) async throws {
        let names = files.map(\.name).joined(separator: ", ")
        guard await ask("Save a file from \(app.server)?", names, action: "Save") else {
            throw McpAppHostRefusal("Declined by the user.")
        }
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("mcp-app-downloads", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var urls: [URL] = []
        for file in files {
            let data: Data?
            switch file {
            case let .embedded(_, _, bytes):
                data = bytes
            case let .link(_, uri, _):
                // A linked file is read from the app's own server, like its other reads.
                let result = try await apps.client.mcpAppReadResource(
                    threadID: apps.threadID, sourceThreadID: target.sourceThreadID, itemID: target.itemID, uri: uri
                )
                let first: JSONValue? = if case let .array(contents)? = result["contents"] { contents.first } else { nil }
                data = McpAppHost.resourceBytes(first)
            }
            guard let data else { throw McpAppHostRefusal("\(file.name) has no contents.") }
            guard data.count <= McpAppLayout.maxDownloadBytes else {
                throw McpAppHostRefusal("\(file.name) is too large to save.")
            }
            let url = folder.appendingPathComponent(file.name)
            try data.write(to: url, options: .atomic)
            urls.append(url)
        }
        sharedFiles = McpAppSharedFiles(urls: urls)
    }

    static func prettyJSON(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
}

/// The palette as CSS for the app's style variables, resolved for one appearance.
enum McpAppTheme {
    static func roles(dark: Bool) -> McpAppStyleVariables.Roles {
        let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
        let palette = T3ThemeStore.shared.resolved
        func css(_ color: UIColor) -> String {
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            guard color.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return "" }
            return McpAppStyleVariables.css(red: red, green: green, blue: blue, alpha: alpha)
        }
        return McpAppStyleVariables.Roles(
            background: css(palette.background),
            surface: css(palette.surface),
            subtle: css(palette.subtle),
            textPrimary: css(palette.textPrimary),
            textSecondary: css(palette.textSecondary),
            textTertiary: css(palette.textTertiary),
            border: css(palette.border),
            inputBorder: css(palette.inputBorder),
            accent: css(palette.accent),
            danger: css(palette.danger),
            success: css(UIColor(T3Colors.success)),
            warning: css(UIColor(T3Colors.warning))
        )
    }
}

// MARK: - Web view

struct McpAppWebView: UIViewRepresentable {
    let session: McpAppSession
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(session: session) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Nothing an app stores outlives it, and it sees no other web content's data.
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.dataDetectorTypes = []
        configuration.userContentController.add(context.coordinator, name: McpAppLayout.messageHandlerName)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        // The outer page is exactly the box; the app scrolls inside its frame.
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        webView.accessibilityLabel = "\(session.target.app.server) app"
        session.attach(webView)
        // `baseURL: nil` leaves the outer page on `about:blank`.
        webView.loadHTMLString(
            McpAppFrameDocument.outer(src: url, allow: session.target.app.allowAttribute, secret: session.secret),
            baseURL: nil
        )
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        // The content controller holds the coordinator strongly.
        webView.configuration.userContentController.removeScriptMessageHandler(forName: McpAppLayout.messageHandlerName)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        private weak var session: McpAppSession?

        init(session: McpAppSession) {
            self.session = session
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let text = message.body as? String else { return }
            session?.receive(envelope: text, isMainFrame: message.frameInfo.isMainFrame)
        }

        /// The outer page loads once at `about:blank`; the app and the frames
        /// it nests (bounded by its CSP) load below it. Nothing replaces the
        /// outer page, and nothing opens a window.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let frame = navigationAction.targetFrame else {
                decisionHandler(.cancel)
                return
            }
            if frame.isMainFrame {
                decisionHandler(navigationAction.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
            } else {
                decisionHandler(.allow)
            }
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            session?.webContentProcessDidTerminate()
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            nil
        }

        /// Never the camera or microphone: they would inherit T3's own grants.
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(.deny)
        }

        // No JavaScript panels: completing them without presenting anything
        // keeps an app from throwing modal chrome over the thread.
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
    }
}

// MARK: - Views

/// Hosts one session: the web view once its document is known, a static note
/// otherwise, plus the app's questions and shared files.
private struct McpAppSurface: View {
    let session: McpAppSession

    @SwiftUI.Environment(\.colorScheme) private var colorScheme
    @SwiftUI.Environment(\.openURL) private var openURL

    var body: some View {
        GeometryReader { proxy in
            content
                .frame(width: proxy.size.width, height: proxy.size.height)
                .onAppear { measure(proxy) }
                .onChange(of: proxy.size) { measure(proxy) }
        }
        .task { await session.start() }
        .onAppear {
            session.isDark = colorScheme == .dark
            session.openURL = { openURL($0) }
        }
        .onDisappear { session.stop() }
        .onChange(of: colorScheme) {
            session.isDark = colorScheme == .dark
            session.updateHostContext()
        }
        .onReceive(NotificationCenter.default.publisher(for: .t3ThemeDidChange)) { _ in
            session.updateHostContext()
        }
        .alert(
            session.approval?.title ?? "",
            isPresented: Binding(
                get: { session.approval != nil },
                set: { if !$0 { session.resolveApproval(false) } }
            ),
            presenting: session.approval
        ) { approval in
            Button("Cancel", role: .cancel) { session.resolveApproval(false) }
            Button(approval.action) { session.resolveApproval(true) }
        } message: { approval in
            Text(approval.message)
        }
        .sheet(item: Binding(get: { session.sharedFiles }, set: { session.sharedFiles = $0 })) { files in
            McpAppShareSheet(urls: files.urls)
        }
    }

    @ViewBuilder
    private var content: some View {
        let server = session.target.app.server
        switch session.phase {
        case let .ready(url):
            McpAppWebView(session: session, url: url)
                .id(session.generation)
        case .loading:
            note("Loading the \(server) app")
        case .unsupported, .failed:
            note("Unable to load the \(server) app")
        case .crashed:
            note("The \(server) app stopped responding")
        case .navigatedAway:
            note("The \(server) app left its page and was stopped")
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
            .multilineTextAlignment(.center)
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func measure(_ proxy: GeometryProxy) {
        session.containerSize = proxy.size
        session.horizontalInsets = (proxy.safeAreaInsets.leading, proxy.safeAreaInsets.trailing)
        session.updateHostContext()
    }
}

private struct McpAppShareSheet: UIViewControllerRepresentable {
    let urls: [URL]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: urls, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// The inline view of one app's document. Its own view so a new document
/// (back from full screen) is a new session.
private struct McpAppInlineDocument: View {
    @State private var session: McpAppSession

    init(target: McpAppPresentation, apps: ThreadMcpApps) {
        _session = State(initialValue: McpAppSession(target: target, mode: .inline, apps: apps))
    }

    var body: some View {
        if session.closed {
            VStack(spacing: 8) {
                Text("The \(session.target.app.server) app was closed")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                Button("Show App") { session.reopen() }
                    .t3SecondaryButtonStyle()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            McpAppSurface(session: session)
        }
    }
}

/// An MCP App row of the transcript, or the plain tool call it came from when
/// this client or server cannot host it.
struct ThreadMcpAppRow<Fallback: View>: View {
    let presentation: McpAppPresentation
    @ViewBuilder let fallback: () -> Fallback

    @SwiftUI.Environment(\.threadMcpApps) private var apps

    var body: some View {
        if let apps, !apps.unsupported {
            Group {
                if apps.fullscreen?.id == presentation.id {
                    Text("The \(presentation.app.server) app is open full screen")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    McpAppInlineDocument(target: presentation, apps: apps)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: McpAppLayout.inlineHeight)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                if presentation.app.prefersBorder == true || apps.fullscreen?.id == presentation.id {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(T3Colors.border, lineWidth: 1)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("\(presentation.app.server) app")
        } else {
            fallback()
        }
    }
}

/// An app full screen, in its own presentation over the thread. Leaving it,
/// or anything the agent waits on, returns the app to its row.
struct McpAppFullscreenView: View {
    let apps: ThreadMcpApps
    @State private var session: McpAppSession

    init(presentation: McpAppPresentation, apps: ThreadMcpApps) {
        self.apps = apps
        let session = McpAppSession(target: presentation, mode: .fullscreen, apps: apps)
        session.onExitFullscreen = { [apps] in apps.fullscreen = nil }
        _session = State(initialValue: session)
    }

    var body: some View {
        NavigationStack {
            McpAppSurface(session: session)
                .background(T3Colors.background)
                .ignoresSafeArea(.container, edges: .horizontal)
                .navigationTitle(session.target.app.server)
                .navigationBarTitleDisplayMode(.inline)
                .t3NavigationChrome()
                .t3SheetToolbar(.close, onDismiss: exit)
        }
        .onAppear { if apps.awaitingUser { exit() } }
        .onChange(of: apps.awaitingUser) { if apps.awaitingUser { exit() } }
    }

    /// The app gets its teardown before the presentation goes.
    private func exit() {
        let host = session.host
        Task { @MainActor in
            await host?.teardown()
            apps.fullscreen = nil
        }
    }
}
