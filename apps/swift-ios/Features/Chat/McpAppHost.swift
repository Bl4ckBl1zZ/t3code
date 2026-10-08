import Foundation

// Port of packages/client-runtime/src/mcpApps/host.ts: the host side of the MCP
// Apps bridge (spec 2026-01-26, plus the draft `ui/download-file` and
// `ui/notifications/request-teardown` the SDK sends). JSON-RPC 2.0 between the
// client and one app document, transport-free: the web view supplies how a
// message is posted, the session supplies how the environment is reached.

enum McpAppDisplayMode: String, Equatable, Sendable {
    case inline
    case fullscreen
}

/// Thrown by host callbacks to refuse a request with a message the app shows.
struct McpAppHostRefusal: LocalizedError, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// A file an app asked the host to save: embedded, or linked on its server.
enum McpAppDownload: Equatable {
    case embedded(name: String, mimeType: String, data: Data)
    case link(name: String, uri: String, mimeType: String?)

    var name: String {
        switch self {
        case let .embedded(name, _, _), let .link(name, _, _): name
        }
    }
}

/// The context an app reads its surroundings from (spec "Host Context").
struct McpAppHostContext: Equatable {
    var theme: String
    var styleVariables: [String: String]
    var displayMode: McpAppDisplayMode
    var availableDisplayModes: [McpAppDisplayMode] = [.inline, .fullscreen]
    /// Inline rows and full screen are both fixed boxes the app must fit.
    var width: Double
    var height: Double
    var locale: String
    var timeZone: String
    var userAgent: String
    var safeAreaInsets: (top: Double, right: Double, bottom: Double, left: Double) = (0, 0, 0, 0)
    var toolDefinition: JSONValue?

    static func == (lhs: McpAppHostContext, rhs: McpAppHostContext) -> Bool {
        lhs.json == rhs.json
    }

    var json: [String: JSONValue] {
        var context: [String: JSONValue] = [
            "theme": .string(theme),
            "styles": .object(["variables": .object(styleVariables.mapValues(JSONValue.string))]),
            "displayMode": .string(displayMode.rawValue),
            "availableDisplayModes": .array(availableDisplayModes.map { .string($0.rawValue) }),
            "containerDimensions": .object(["width": .number(width.rounded()), "height": .number(height.rounded())]),
            "platform": .string("mobile"),
            "locale": .string(locale),
            "timeZone": .string(timeZone),
            "userAgent": .string(userAgent),
            "deviceCapabilities": .object(["touch": .bool(true), "hover": .bool(false)]),
            "safeAreaInsets": .object([
                "top": .number(safeAreaInsets.top), "right": .number(safeAreaInsets.right),
                "bottom": .number(safeAreaInsets.bottom), "left": .number(safeAreaInsets.left),
            ]),
        ]
        if let toolDefinition { context["toolInfo"] = .object(["tool": toolDefinition]) }
        return context
    }
}

/// Maps T3's palette roles onto the spec's standardized style variables, by
/// meaning (`mcpAppStyleVariables`), so apps written for any host pick up the
/// thread's colors and type. Roles the native palette lacks stay unset.
enum McpAppStyleVariables {
    struct Roles {
        var background: String
        var surface: String
        var subtle: String
        var textPrimary: String
        var textSecondary: String
        var textTertiary: String
        var border: String
        var inputBorder: String
        var accent: String
        var danger: String
        var success: String
        var warning: String
    }

    static let fontSans = "-apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    static let fontMono = "ui-monospace, SFMono-Regular, Menlo, monospace"

    static func variables(_ roles: Roles) -> [String: String] {
        [
            "--color-background-primary": roles.background,
            "--color-background-secondary": roles.surface,
            "--color-background-tertiary": roles.subtle,
            "--color-background-inverse": roles.textPrimary,
            "--color-text-primary": roles.textPrimary,
            "--color-text-secondary": roles.textSecondary,
            "--color-text-tertiary": roles.textTertiary,
            "--color-text-inverse": roles.background,
            "--color-text-danger": roles.danger,
            "--color-text-success": roles.success,
            "--color-text-warning": roles.warning,
            "--color-border-primary": roles.border,
            "--color-border-secondary": roles.inputBorder,
            "--color-border-danger": roles.danger,
            "--color-ring-primary": roles.accent,
            "--font-sans": fontSans,
            "--font-mono": fontMono,
            "--border-radius-md": "10px",
        ].filter { !$0.value.isEmpty }
    }

    /// A CSS color for components in 0...1: hex when opaque, `rgba()` otherwise.
    static func css(red: Double, green: Double, blue: Double, alpha: Double) -> String {
        func byte(_ value: Double) -> Int { Int((min(1, max(0, value)) * 255).rounded()) }
        if alpha >= 1 {
            return String(format: "#%02x%02x%02x", byte(red), byte(green), byte(blue))
        }
        return "rgba(\(byte(red)), \(byte(green)), \(byte(blue)), \(String(format: "%.3g", max(0, alpha))))"
    }
}

@MainActor
final class McpAppHost {
    static let maxMessageBytes = 256 * 1024
    /// Requests an app may have in flight at once; more are refused, not queued.
    static let maxPendingRequests = 16
    /// How long the host waits for an app to answer `ui/resource-teardown`.
    static let teardownTimeout: Duration = .seconds(2)

    struct Callbacks {
        /// Posts one JSON-RPC message to the app document.
        var post: (JSONValue) -> Void
        var hostContext: () -> McpAppHostContext
        var callTool: (_ name: String, _ arguments: [String: JSONValue]) async throws -> JSONValue
        var readResource: (_ uri: String) async throws -> JSONValue
        var openLink: (URL) async throws -> Void
        var sendMessage: (String) async throws -> Void
        var updateModelContext: (_ content: [JSONValue]?, _ structured: [String: JSONValue]?) async throws -> Void
        /// Switches to a mode both sides offer, returning the resulting mode.
        var requestDisplayMode: (McpAppDisplayMode) async -> McpAppDisplayMode
        var downloadFile: ([McpAppDownload]) async throws -> Void
        var onRequestTeardown: () -> Void
        var onSizeChanged: (_ width: Double?, _ height: Double?) -> Void = { _, _ in }
    }

    private let app: McpAppReference
    private let hostVersion: String
    private let callbacks: Callbacks
    private var initialized = false
    private(set) var isDisposed = false
    private var toolCall: (arguments: JSONValue?, result: JSONValue?)?
    private var toolCallSent = false
    private var pending = 0
    private var sentContext: [String: JSONValue]?
    /// Modes the app declared at initialize; nil when it declared none.
    private var appDisplayModes: [String]?
    private var nextHostRequestID = 0
    private var hostRequests: [String: () -> Void] = [:]

    init(app: McpAppReference, hostVersion: String, callbacks: Callbacks) {
        self.app = app
        self.hostVersion = hostVersion
        self.callbacks = callbacks
    }

    // MARK: Inbound

    /// Handles one message the app posted; the caller has already checked its source.
    func receive(_ data: JSONValue) {
        guard !isDisposed, case let .object(message) = data, message["jsonrpc"] == .string("2.0") else { return }
        let id = Self.requestID(message["id"])
        if Self.jsonBytes(data) > Self.maxMessageBytes {
            if let id, message["method"]?.stringValue != nil { fail(id, -32600, "Message too large.") }
            return
        }
        guard let method = message["method"]?.stringValue else {
            if let id, message["result"] != nil || message["error"] != nil { handleResponse(id) }
            return
        }
        let params: [String: JSONValue] = if case let .object(params)? = message["params"] { params } else { [:] }
        if let id {
            handleRequest(id, method, params)
        } else {
            handleNotification(method, params)
        }
    }

    /// The original call's arguments and result reach the app once it has
    /// initialized, whichever happens last, and only once.
    func setToolCall(arguments: JSONValue?, result: JSONValue?) {
        if toolCall == nil { toolCall = (arguments, result) }
        sendToolCall()
    }

    /// Sends `host-context-changed` with the fields that differ from what the
    /// app last saw.
    func updateHostContext() {
        // The spec forbids messages before the app finishes initializing.
        guard initialized, let previous = sentContext else { return }
        let next = callbacks.hostContext().json
        var changes: [String: JSONValue] = [:]
        for (key, value) in next where previous[key] != value { changes[key] = value }
        sentContext = next
        if !changes.isEmpty { notify("ui/notifications/host-context-changed", .object(changes)) }
    }

    /// Asks the app to wrap up before its document goes away, resolving once it
    /// answers or after a short timeout, then disposes the host.
    func teardown() async {
        // Before initialization the app has nothing to save and may not listen.
        guard !isDisposed, initialized else {
            isDisposed = true
            return
        }
        let id = "t3-host-\(nextHostRequestID)"
        nextHostRequestID += 1
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            hostRequests[id] = { continuation.resume() }
            post(.object(["jsonrpc": .string("2.0"), "id": .string(id), "method": .string("ui/resource-teardown"), "params": .object([:])]))
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: Self.teardownTimeout)
                self?.hostRequests.removeValue(forKey: id)?()
            }
        }
        isDisposed = true
    }

    func dispose() {
        isDisposed = true
        // Nothing will answer now; release a teardown that is still waiting.
        let waiting = hostRequests.values
        hostRequests.removeAll()
        waiting.forEach { $0() }
    }

    // MARK: Requests

    private func handleRequest(_ id: JSONValue, _ method: String, _ params: [String: JSONValue]) {
        switch method {
        case "ui/initialize":
            if case let .object(capabilities)? = params["appCapabilities"],
               case let .array(modes)? = capabilities["availableDisplayModes"] {
                appDisplayModes = modes.compactMap(\.stringValue)
            } else {
                appDisplayModes = nil
            }
            let context = callbacks.hostContext().json
            sentContext = context
            respond(id, .object([
                "protocolVersion": .string(McpApps.protocolVersion),
                "hostInfo": .object(["name": .string("t3-code"), "version": .string(hostVersion)]),
                "hostCapabilities": .object([
                    "openLinks": .object([:]),
                    "serverTools": .object([:]),
                    "serverResources": .object([:]),
                    "logging": .object([:]),
                    "message": .object(["text": .object([:])]),
                    "updateModelContext": .object(["text": .object([:]), "structuredContent": .object([:])]),
                    "downloadFile": .object([:]),
                    "sandbox": app.sandboxCapability,
                ]),
                "hostContext": .object(context),
            ]))
        case "ping":
            respond(id, .object([:]))
        case "tools/call":
            let arguments = params["arguments"] ?? .object([:])
            guard let name = params["name"]?.stringValue,
                  !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  case let .object(args) = arguments else {
                fail(id, -32602, "tools/call needs a tool name and object arguments.")
                return
            }
            answer(id) { [callbacks] in Self.normalizedToolResult(try await callbacks.callTool(name, args)) }
        case "resources/read":
            guard let uri = params["uri"]?.stringValue,
                  !uri.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                fail(id, -32602, "resources/read needs a uri.")
                return
            }
            answer(id) { [callbacks] in try await callbacks.readResource(uri) }
        case "ui/open-link":
            guard let text = params["url"]?.stringValue, let url = Self.openableLink(text) else {
                fail(id, -32602, "Only http(s) links can be opened.")
                return
            }
            answer(id) { [callbacks] in
                try await callbacks.openLink(url)
                return .object([:])
            }
        case "ui/message":
            switch Self.messageText(params) {
            case let .failure(refusal):
                fail(id, -32602, refusal.message)
            case let .success(text):
                answer(id) { [callbacks] in
                    try await callbacks.sendMessage(text)
                    return .object([:])
                }
            }
        case "ui/request-display-mode":
            let current = callbacks.hostContext().displayMode
            let requested = params["mode"]?.stringValue.flatMap(McpAppDisplayMode.init(rawValue:))
            // A mode the host lacks, or the app did not declare, keeps the current one.
            guard let mode = requested,
                  callbacks.hostContext().availableDisplayModes.contains(mode),
                  appDisplayModes.map({ $0.contains(mode.rawValue) }) ?? true,
                  mode != current else {
                respond(id, .object(["mode": .string(current.rawValue)]))
                return
            }
            answer(id) { [callbacks] in
                .object(["mode": .string(await callbacks.requestDisplayMode(mode).rawValue)])
            }
        case "ui/update-model-context":
            let content = params["content"]
            let structured = params["structuredContent"]
            var blocks: [JSONValue]?
            var object: [String: JSONValue]?
            if let content {
                guard case let .array(value) = content else {
                    fail(id, -32602, "Model context needs content blocks or an object of structured content.")
                    return
                }
                blocks = value
            }
            if let structured {
                guard case let .object(value) = structured else {
                    fail(id, -32602, "Model context needs content blocks or an object of structured content.")
                    return
                }
                object = value
            }
            answer(id) { [callbacks, blocks, object] in
                try await callbacks.updateModelContext(blocks, object)
                return .object([:])
            }
        case "ui/download-file":
            guard let files = Self.downloads(params["contents"]) else {
                fail(id, -32602, "ui/download-file needs embedded resources or resource links.")
                return
            }
            answer(id) { [callbacks] in
                do {
                    try await callbacks.downloadFile(files)
                    return .object([:])
                } catch is McpAppHostRefusal {
                    // The draft reports a refused or failed download in the result.
                    return .object(["isError": .bool(true)])
                }
            }
        default:
            fail(id, -32601, "Method not found: \(method)")
        }
    }

    private func handleNotification(_ method: String, _ params: [String: JSONValue]) {
        switch method {
        case "ui/notifications/initialized":
            guard !initialized else { return }
            initialized = true
            sendToolCall()
            // The theme or size may have changed since the initialize response.
            updateHostContext()
        case "ui/notifications/size-changed":
            let width = Self.number(params["width"])
            let height = Self.number(params["height"])
            if width != nil || height != nil { callbacks.onSizeChanged(width, height) }
        case "ui/notifications/request-teardown":
            callbacks.onRequestTeardown()
        default:
            // notifications/message (logging) and unknown notifications are ignored.
            break
        }
    }

    private func handleResponse(_ id: JSONValue) {
        guard let key = Self.idKey(id), let settle = hostRequests.removeValue(forKey: key) else { return }
        settle()
    }

    // MARK: Outbound

    private func post(_ message: JSONValue) {
        if !isDisposed { callbacks.post(message) }
    }

    private func notify(_ method: String, _ params: JSONValue) {
        post(.object(["jsonrpc": .string("2.0"), "method": .string(method), "params": params]))
    }

    private func respond(_ id: JSONValue, _ result: JSONValue) {
        post(.object(["jsonrpc": .string("2.0"), "id": id, "result": result]))
    }

    private func fail(_ id: JSONValue, _ code: Int, _ message: String) {
        post(.object([
            "jsonrpc": .string("2.0"), "id": id,
            "error": .object(["code": .number(Double(code)), "message": .string(message)]),
        ]))
    }

    private func answer(_ id: JSONValue, _ run: @escaping @MainActor () async throws -> JSONValue) {
        guard pending < Self.maxPendingRequests else {
            fail(id, -32000, "Too many requests in flight.")
            return
        }
        pending += 1
        Task { @MainActor [weak self] in
            do {
                let result = try await run()
                self?.pending -= 1
                self?.respond(id, result)
            } catch {
                self?.pending -= 1
                self?.fail(id, -32000, Self.errorMessage(error))
            }
        }
    }

    private func sendToolCall() {
        guard initialized, let toolCall, !toolCallSent else { return }
        toolCallSent = true
        var arguments = JSONValue.object([:])
        if case let .object(entries)? = toolCall.arguments { arguments = .object(entries) }
        notify("ui/notifications/tool-input", .object(["arguments": arguments]))
        if let result = toolCall.result {
            notify("ui/notifications/tool-result", Self.normalizedToolResult(result))
        }
    }

    // MARK: Pure helpers

    static func errorMessage(_ error: Error) -> String {
        if let refusal = error as? McpAppHostRefusal { return refusal.message }
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? "Request failed." : message
    }

    /// Bytes of the message as JSON, which is what the size limit counts.
    static func jsonBytes(_ value: JSONValue) -> Int {
        (try? JSONEncoder.t3Intermediate.encode(value).count) ?? Int.max
    }

    /// A JSON-RPC id: a string or a finite number.
    static func requestID(_ value: JSONValue?) -> JSONValue? {
        switch value {
        case .string?, .integer?, .unsignedInteger?: value
        case let .number(number)? where number.isFinite: value
        default: nil
        }
    }

    private static func idKey(_ id: JSONValue) -> String? {
        switch id {
        case let .string(text): text
        case let .number(number): String(number)
        case let .integer(number): String(number)
        case let .unsignedInteger(number): String(number)
        default: nil
        }
    }

    private static func number(_ value: JSONValue?) -> Double? {
        switch value {
        case let .number(number)?: number
        case let .integer(number)?: Double(number)
        case let .unsignedInteger(number)?: Double(number)
        default: nil
        }
    }

    static func openableLink(_ text: String) -> URL? {
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host != nil else { return nil }
        return url
    }

    /// `ui/message`: user role, text blocks only. The SDK sends an array of
    /// blocks; the spec text shows one.
    static func messageText(_ params: [String: JSONValue]) -> Result<String, McpAppHostRefusal> {
        let blocks: [JSONValue] = if case let .array(values)? = params["content"] { values } else { [params["content"] ?? .null] }
        let texts = blocks.map { block -> String? in
            guard case let .object(entries) = block, entries["type"] == .string("text") else { return nil }
            return entries["text"]?.stringValue
        }
        guard params["role"] == .string("user"), !texts.isEmpty, !texts.contains(nil) else {
            return .failure(McpAppHostRefusal("Only text messages from the user role are supported."))
        }
        let text = texts.compactMap { $0 }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .failure(McpAppHostRefusal("ui/message needs non-empty text.")) }
        return .success(text)
    }

    /// A `CallToolResult` as the spec's schema accepts it. Providers report
    /// absent fields as null (Codex sends `_meta: null`), which the SDK rejects.
    static func normalizedToolResult(_ result: JSONValue) -> JSONValue {
        var normalized: [String: JSONValue] = [:]
        if case let .array(content)? = result["content"] { normalized["content"] = .array(content) } else { normalized["content"] = .array([]) }
        if case .object? = result["structuredContent"] { normalized["structuredContent"] = result["structuredContent"] }
        if result["isError"] == .bool(true) { normalized["isError"] = .bool(true) }
        if case .object? = result["_meta"] { normalized["_meta"] = result["_meta"] }
        return .object(normalized)
    }

    /// An MCP resource's bytes: `text` as UTF-8, `blob` from base64.
    static func resourceBytes(_ content: JSONValue?) -> Data? {
        if let text = content?["text"]?.stringValue { return Data(text.utf8) }
        if let blob = content?["blob"]?.stringValue { return Data(base64Encoded: blob) }
        return nil
    }

    /// `ui/download-file` contents: MCP embedded resources and resource links.
    static func downloads(_ contents: JSONValue?) -> [McpAppDownload]? {
        guard case let .array(entries)? = contents, !entries.isEmpty else { return nil }
        var files: [McpAppDownload] = []
        for entry in entries {
            guard case .object = entry else { return nil }
            if entry["type"] == .string("resource"), case let .object(resource)? = entry["resource"] {
                guard let data = resourceBytes(.object(resource)) else { return nil }
                files.append(.embedded(
                    name: downloadName(uri: resource["uri"]?.stringValue, name: resource["name"]?.stringValue),
                    mimeType: resource["mimeType"]?.stringValue ?? "application/octet-stream",
                    data: data
                ))
            } else if entry["type"] == .string("resource_link"), let uri = entry["uri"]?.stringValue {
                files.append(.link(
                    name: downloadName(uri: uri, name: entry["name"]?.stringValue),
                    uri: uri,
                    mimeType: entry["mimeType"]?.stringValue
                ))
            } else {
                return nil
            }
        }
        return files
    }

    /// The name an app gave a download, or the last part of its URI, with path
    /// separators, reserved and control characters replaced.
    static func downloadName(uri: String?, name: String?) -> String {
        let raw: String
        if let name, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            raw = name
        } else if let uri {
            raw = uri.split(whereSeparator: { "/?#".contains($0) }).last.map(String.init) ?? "download"
        } else {
            raw = "download"
        }
        let reserved = Set("\\/:*?\"<>|".unicodeScalars)
        var safe = ""
        for scalar in raw.unicodeScalars {
            safe.unicodeScalars.append(reserved.contains(scalar) || scalar.value < 32 ? "-" : scalar)
        }
        let bounded = String(safe.prefix(200))
        return bounded.isEmpty ? "download" : bounded
    }
}
