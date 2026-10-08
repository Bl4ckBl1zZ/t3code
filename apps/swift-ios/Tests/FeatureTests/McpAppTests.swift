import XCTest

@testable import T3Code

/// Ports the pure parts of packages/shared/src/mcpApp.test.ts and
/// packages/client-runtime/src/mcpApps/host.test.ts: which tool calls are apps,
/// and the JSON-RPC rules the host enforces on a document.
@MainActor
final class McpAppTests: XCTestCase {
    // MARK: - Detection

    private let reference: JSONValue = .object([
        "attachmentId": .string("att-1"),
        "server": .string("charts"),
        "tool": .string("show chart"),
        "resourceUri": .string("ui://charts/view"),
        "csp": .object([
            "connectDomains": .array([.string("https://api.example.com"), .string("'self'"), .string("https://*.cdn.example.com:8443")]),
            "frameDomains": .array([.string("javascript:alert(1)")]),
        ]),
        "permissions": .object(["camera": .object([:]), "clipboardWrite": .object([:]), "bogus": .object([:])]),
        "prefersBorder": .bool(true),
    ])

    private func toolItem(
        toolName: String = "charts.show chart",
        status: String = "completed",
        output: JSONValue? = nil
    ) -> OrchestrationV2TurnItem {
        V2Fixture.turnItem(id: "tool", type: "dynamic_tool", status: status, extra: [
            "toolName": .string(toolName),
            "output": output ?? .object([McpApps.outputKey: reference]),
            "outputOmitted": .bool(true),
        ])
    }

    func testCompletedCallNamingItsOwnServerAndToolIsAnApp() throws {
        let app = try XCTUnwrap(McpAppReference.from(toolItem()))
        XCTAssertEqual(app.attachmentID, "att-1")
        XCTAssertEqual(app.server, "charts")
        XCTAssertEqual(app.resourceURI, "ui://charts/view")
        XCTAssertEqual(app.prefersBorder, true)
        // The stored item keeps the reference beside the tool's own result.
        let stored = toolItem(output: .object([McpApps.outputKey: reference, "result": .object(["content": .array([])])]))
        XCTAssertEqual(McpAppReference.from(stored), app)
    }

    func testAToolResultImitatingAnotherServersAppIsNotAnApp() {
        XCTAssertNil(McpAppReference.from(toolItem(toolName: "evil.show chart")))
        XCTAssertNil(McpAppReference.from(toolItem(toolName: "charts.other")))
    }

    func testOnlyCompletedCallsWithAUIResourceAreApps() {
        XCTAssertNil(McpAppReference.from(toolItem(status: "running")))
        guard case var .object(fields) = reference else { return XCTFail() }
        fields["resourceUri"] = .string("https://charts.example.com/view")
        XCTAssertNil(McpAppReference.from(toolItem(output: .object([McpApps.outputKey: .object(fields)]))))
        fields["resourceUri"] = .string("ui://charts/view")
        fields["server"] = .string("   ")
        XCTAssertNil(McpAppReference(json: .object(fields)))
        let command = V2Fixture.turnItem(id: "c", type: "command_execution", extra: ["input": .string("ls")])
        XCTAssertNil(McpAppReference.from(command))
    }

    func testDeclaredOriginsAreFilteredAndOnlyClipboardWriteIsDelegated() throws {
        let app = try XCTUnwrap(McpAppReference(json: reference))
        XCTAssertEqual(app.csp, ["connectDomains": ["https://api.example.com", "https://*.cdn.example.com:8443"]])
        XCTAssertEqual(app.permissions, ["camera", "clipboardWrite"])
        XCTAssertEqual(app.allowAttribute, "clipboard-write")
        XCTAssertEqual(app.sandboxCapability, .object([
            "csp": .object(["connectDomains": .array([.string("https://api.example.com"), .string("https://*.cdn.example.com:8443")])]),
            "permissions": .object(["clipboardWrite": .object([:])]),
        ]))
    }

    func testDocumentFileNameMatchesTheServersAssetName() throws {
        XCTAssertEqual(try XCTUnwrap(McpAppReference(json: reference)).documentFileName, "show-chart.html")
        guard case var .object(fields) = reference else { return XCTFail() }
        fields["tool"] = .string("??")
        XCTAssertEqual(try XCTUnwrap(McpAppReference(json: .object(fields))).documentFileName, "-.html")
    }

    func testAppsBecomeTheirOwnTimelineRowsThatNeverFold() {
        let projected = OrchestrationV2ProjectedTurnItem(
            position: 0, visibility: .inherited, sourceThreadId: "source", sourceItemId: "tool", item: toolItem()
        )
        let entries = ThreadTimelineFeed.entries(timelineItems: [projected], messages: [])
        guard case let .mcpApp(app)? = entries.last else { return XCTFail("Expected an app row: \(entries)") }
        // A fork shows its source's app, which runs against the source.
        XCTAssertEqual(app.presentation.sourceThreadID, "source")
        XCTAssertEqual(app.presentation.itemID, "tool")
        XCTAssertEqual(app.runID, "run-1")

        let forged = OrchestrationV2ProjectedTurnItem(
            position: 0, visibility: .local, sourceThreadId: "t", sourceItemId: "tool",
            item: toolItem(toolName: "evil.show chart")
        )
        guard case .workLog? = ThreadTimelineFeed.entries(timelineItems: [forged], messages: []).last else {
            return XCTFail("A forged app stays a plain tool row")
        }
    }

    func testRequestErrorReasonsAreWordedForTheUser() {
        XCTAssertEqual(
            McpAppRequestErrorReason.message(for: "session-stopped"),
            "The app's thread is not running. Send a message in the thread that created it to use the app again."
        )
        XCTAssertEqual(McpAppRequestErrorReason.message(for: "something-new"), "The app's MCP server request failed.")
    }

    // MARK: - Host

    private final class Harness {
        var posted: [JSONValue] = []
        var context = McpAppHostContext(
            theme: "dark", styleVariables: ["--color-text-primary": "#ffffff"], displayMode: .inline,
            width: 390, height: 420, locale: "en-US", timeZone: "Europe/Berlin", userAgent: "t3-code/1.0"
        )
        var gates: [CheckedContinuation<Void, Never>] = []
        var onPost: ((JSONValue) -> Void)?
    }

    private func makeHost(
        _ harness: Harness,
        callTool: @escaping (String, [String: JSONValue]) async throws -> JSONValue = { _, _ in .object([:]) }
    ) -> McpAppHost {
        McpAppHost(
            app: McpAppReference(json: reference)!,
            hostVersion: "1.0",
            callbacks: .init(
                post: { message in
                    harness.posted.append(message)
                    harness.onPost?(message)
                },
                hostContext: { harness.context },
                callTool: callTool,
                readResource: { _ in .object(["contents": .array([])]) },
                openLink: { _ in },
                sendMessage: { _ in },
                updateModelContext: { _, _ in },
                requestDisplayMode: { $0 },
                downloadFile: { _ in },
                onRequestTeardown: {}
            )
        )
    }

    private func request(_ id: Int, _ method: String, _ params: [String: JSONValue] = [:]) -> JSONValue {
        .object(["jsonrpc": .string("2.0"), "id": .number(Double(id)), "method": .string(method), "params": .object(params)])
    }

    private func notification(_ method: String, _ params: [String: JSONValue] = [:]) -> JSONValue {
        .object(["jsonrpc": .string("2.0"), "method": .string(method), "params": .object(params)])
    }

    private func initialize(_ host: McpAppHost, declaring modes: [String]? = nil) {
        var params: [String: JSONValue] = ["protocolVersion": .string(McpApps.protocolVersion)]
        if let modes {
            params["appCapabilities"] = .object(["availableDisplayModes": .array(modes.map(JSONValue.string))])
        }
        host.receive(request(1, "ui/initialize", params))
        host.receive(notification("ui/notifications/initialized"))
    }

    func testInitializeDescribesAMobileHostAndItsSandbox() throws {
        let harness = Harness()
        let host = makeHost(harness)
        host.receive(request(1, "ui/initialize", ["protocolVersion": .string("1999-01-01")]))
        let result = try XCTUnwrap(harness.posted.first?["result"])
        XCTAssertEqual(result["protocolVersion"], .string(McpApps.protocolVersion))
        XCTAssertEqual(result["hostInfo"]?["name"], .string("t3-code"))
        let context = try XCTUnwrap(result["hostContext"])
        XCTAssertEqual(context["platform"], .string("mobile"))
        XCTAssertEqual(context["theme"], .string("dark"))
        XCTAssertEqual(context["displayMode"], .string("inline"))
        XCTAssertEqual(context["containerDimensions"], .object(["width": .number(390), "height": .number(420)]))
        XCTAssertEqual(context["deviceCapabilities"], .object(["touch": .bool(true), "hover": .bool(false)]))
        XCTAssertEqual(context["styles"]?["variables"]?["--color-text-primary"], .string("#ffffff"))
        XCTAssertEqual(result["hostCapabilities"]?["sandbox"]?["permissions"], .object(["clipboardWrite": .object([:])]))
    }

    func testToolCallReachesTheAppOnceAfterItInitializesWithNullsNormalized() {
        let harness = Harness()
        let host = makeHost(harness)
        host.setToolCall(
            arguments: .object(["q": .string("x")]),
            result: .object(["content": .array([.string("a")]), "_meta": .null, "structuredContent": .null, "isError": .bool(false)])
        )
        XCTAssertTrue(harness.posted.isEmpty, "Nothing reaches the app before it initializes")
        initialize(host)
        let methods = harness.posted.compactMap { $0["method"]?.stringValue }
        XCTAssertEqual(methods, ["ui/notifications/tool-input", "ui/notifications/tool-result"])
        XCTAssertEqual(harness.posted.last?["params"], .object(["content": .array([.string("a")])]))
        host.setToolCall(arguments: nil, result: nil)
        host.receive(notification("ui/notifications/initialized"))
        XCTAssertEqual(harness.posted.compactMap { $0["method"]?.stringValue }.count, 2)
    }

    func testMalformedEnvelopesAreIgnoredAndUnknownMethodsRefused() {
        let harness = Harness()
        let host = makeHost(harness)
        host.receive(.object(["id": .number(1), "method": .string("ping")]))
        host.receive(.string("ping"))
        XCTAssertTrue(harness.posted.isEmpty)
        host.receive(request(2, "ping"))
        XCTAssertEqual(harness.posted.last?["result"], .object([:]))
        host.receive(request(3, "sampling/createMessage"))
        XCTAssertEqual(harness.posted.last?["error"]?["code"], .number(-32601))
    }

    func testOversizedRequestsAreRefusedWithoutRunning() {
        let harness = Harness()
        var ran = false
        let host = makeHost(harness) { _, _ in
            ran = true
            return .object([:])
        }
        let huge = String(repeating: "x", count: McpAppHost.maxMessageBytes)
        host.receive(request(7, "tools/call", ["name": .string("t"), "arguments": .object(["blob": .string(huge)])]))
        XCTAssertEqual(harness.posted.last?["id"], .number(7))
        XCTAssertEqual(harness.posted.last?["error"]?["code"], .number(-32600))
        XCTAssertFalse(ran)
    }

    func testAtMostSixteenRequestsRunAtOnce() async {
        let harness = Harness()
        let blocked = expectation(description: "all calls running")
        blocked.expectedFulfillmentCount = McpAppHost.maxPendingRequests
        let host = makeHost(harness) { _, _ in
            await withCheckedContinuation {
                harness.gates.append($0)
                blocked.fulfill()
            }
            return .object(["content": .array([])])
        }
        for id in 1...McpAppHost.maxPendingRequests {
            host.receive(request(id, "tools/call", ["name": .string("slow")]))
        }
        XCTAssertTrue(harness.posted.isEmpty)
        host.receive(request(99, "tools/call", ["name": .string("slow")]))
        XCTAssertEqual(harness.posted.last?["id"], .number(99))
        XCTAssertEqual(harness.posted.last?["error"]?["message"], .string("Too many requests in flight."))

        // Every slot answers once its call settles.
        let answered = expectation(description: "all answered")
        answered.expectedFulfillmentCount = McpAppHost.maxPendingRequests
        harness.onPost = { if $0["result"] != nil { answered.fulfill() } }
        await fulfillment(of: [blocked], timeout: 2)
        harness.gates.forEach { $0.resume() }
        await fulfillment(of: [answered], timeout: 2)
    }

    func testRefusalsReachTheAppAsErrors() async {
        let harness = Harness()
        let host = makeHost(harness) { _, _ in throw McpAppHostRefusal("Declined by the user.") }
        let failed = expectation(description: "refused")
        harness.onPost = { if $0["error"] != nil { failed.fulfill() } }
        host.receive(request(4, "tools/call", ["name": .string("write")]))
        await fulfillment(of: [failed], timeout: 2)
        XCTAssertEqual(harness.posted.last?["error"]?["message"], .string("Declined by the user."))
    }

    func testRequestsAreValidatedBeforeTheHostActs() {
        let harness = Harness()
        let host = makeHost(harness)
        host.receive(request(1, "ui/open-link", ["url": .string("javascript:alert(1)")]))
        XCTAssertEqual(harness.posted.last?["error"]?["code"], .number(-32602))
        host.receive(request(2, "ui/message", ["role": .string("assistant"), "content": .array([
            .object(["type": .string("text"), "text": .string("hi")]),
        ])]))
        XCTAssertEqual(harness.posted.last?["error"]?["code"], .number(-32602))
        host.receive(request(3, "ui/message", ["role": .string("user"), "content": .array([
            .object(["type": .string("image"), "data": .string("…")]),
        ])]))
        XCTAssertEqual(harness.posted.last?["error"]?["code"], .number(-32602))
        host.receive(request(4, "ui/update-model-context", ["content": .string("not blocks")]))
        XCTAssertEqual(harness.posted.last?["error"]?["code"], .number(-32602))
        host.receive(request(5, "ui/download-file", ["contents": .array([])]))
        XCTAssertEqual(harness.posted.last?["error"]?["code"], .number(-32602))
        host.receive(request(6, "tools/call", ["name": .string("t"), "arguments": .array([])]))
        XCTAssertEqual(harness.posted.last?["error"]?["code"], .number(-32602))
    }

    func testDisplayModesTheAppDidNotDeclareKeepTheCurrentMode() {
        let harness = Harness()
        let host = makeHost(harness)
        initialize(host, declaring: ["inline"])
        host.receive(request(5, "ui/request-display-mode", ["mode": .string("fullscreen")]))
        XCTAssertEqual(harness.posted.last?["result"], .object(["mode": .string("inline")]))
        host.receive(request(6, "ui/request-display-mode", ["mode": .string("pip")]))
        XCTAssertEqual(harness.posted.last?["result"], .object(["mode": .string("inline")]))
    }

    func testHostContextChangesSendOnlyWhatChanged() {
        let harness = Harness()
        let host = makeHost(harness)
        host.updateHostContext()
        XCTAssertTrue(harness.posted.isEmpty, "Nothing is sent before initialization")
        initialize(host)
        let before = harness.posted.count
        host.updateHostContext()
        XCTAssertEqual(harness.posted.count, before, "An unchanged context sends nothing")
        harness.context.theme = "light"
        host.updateHostContext()
        XCTAssertEqual(harness.posted.last?["method"], .string("ui/notifications/host-context-changed"))
        XCTAssertEqual(harness.posted.last?["params"], .object(["theme": .string("light")]))
    }

    func testTeardownWaitsForTheAppsAnswerThenStopsPosting() async throws {
        let harness = Harness()
        let host = makeHost(harness)
        initialize(host)
        harness.onPost = { message in
            guard message["method"] == .string("ui/resource-teardown"), let id = message["id"] else { return }
            Task { @MainActor in host.receive(.object(["jsonrpc": .string("2.0"), "id": id, "result": .object([:])])) }
        }
        await host.teardown()
        XCTAssertTrue(host.isDisposed)
        let count = harness.posted.count
        host.receive(request(9, "ping"))
        XCTAssertEqual(harness.posted.count, count)
    }

    func testDownloadsReadEmbeddedAndLinkedFilesWithSafeNames() throws {
        let files = try XCTUnwrap(McpAppHost.downloads(.array([
            .object(["type": .string("resource"), "resource": .object([
                "uri": .string("ui://charts/a.csv"), "text": .string("a,b"), "mimeType": .string("text/csv"),
            ])]),
            .object(["type": .string("resource_link"), "uri": .string("file:///tmp/report.pdf?x=1"), "name": .string("../evil:name")]),
        ])))
        XCTAssertEqual(files, [
            .embedded(name: "a.csv", mimeType: "text/csv", data: Data("a,b".utf8)),
            .link(name: "..-evil-name", uri: "file:///tmp/report.pdf?x=1", mimeType: nil),
        ])
        XCTAssertNil(McpAppHost.downloads(.array([.object(["type": .string("resource"), "resource": .object([:])])])))
    }

    // MARK: - Host context and frame

    func testStyleVariablesMapPaletteRolesByMeaning() {
        let roles = McpAppStyleVariables.Roles(
            background: "#000000", surface: "#111111", subtle: "#222222", textPrimary: "#ffffff",
            textSecondary: "#cccccc", textTertiary: "#999999", border: "#333333", inputBorder: "#444444",
            accent: "#0000ff", danger: "#ff0000", success: "#00ff00", warning: "",
        )
        let variables = McpAppStyleVariables.variables(roles)
        XCTAssertEqual(variables["--color-background-primary"], "#000000")
        XCTAssertEqual(variables["--color-text-inverse"], "#000000")
        XCTAssertEqual(variables["--color-background-inverse"], "#ffffff")
        XCTAssertEqual(variables["--color-ring-primary"], "#0000ff")
        XCTAssertNil(variables["--color-text-warning"], "An unresolved role stays unset")
        XCTAssertEqual(McpAppStyleVariables.css(red: 1, green: 0.5, blue: 0, alpha: 1), "#ff8000")
        XCTAssertEqual(McpAppStyleVariables.css(red: 0, green: 0, blue: 0, alpha: 0.5), "rgba(0, 0, 0, 0.5)")
    }

    func testFrameIsSandboxedToAnOpaqueOriginAndItsSourceCannotBreakOut() throws {
        let src = try XCTUnwrap(URL(string: "https://host.example/a?x=</script><script>alert(1)"))
        let html = McpAppFrameDocument.outer(src: src, allow: "clipboard-write", secret: "s3cret")
        XCTAssertTrue(html.contains("sandbox=\"allow-scripts allow-forms\""))
        XCTAssertFalse(html.contains("allow-same-origin"))
        XCTAssertFalse(html.contains("</script><script>alert"))
        XCTAssertEqual(html.components(separatedBy: "</script>").count, 2)
    }
}
