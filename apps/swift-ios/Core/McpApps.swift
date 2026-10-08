import Foundation

// MCP Apps (https://github.com/modelcontextprotocol/ext-apps, spec 2026-01-26).
// Mirrors packages/shared/src/mcpApp.ts and packages/contracts/src/mcpApps.ts:
// a completed tool call can carry an interactive HTML app that the server
// captured as a thread attachment. The client hosts it in an opaque-origin
// frame; its requests reach its own MCP server through the `mcpApps.*` RPCs.

public enum McpApps {
    public static let protocolVersion = "2026-01-26"
    /// Where the server records the app reference inside a tool item's output.
    public static let outputKey = "t3McpApp"
    static let resourceScheme = "ui://"
    static let maxNameLength = 256
    static let maxResourceURILength = 4096
    static let maxDomains = 32
    static let maxDomainLength = 256
    static let cspKeys = ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"]
    static let permissionKeys = ["camera", "microphone", "geolocation", "clipboardWrite"]

    // Scheme-qualified origins with an optional leading `*.` wildcard. Anything
    // else could widen or break the policy the server builds from them.
    private static let domainPattern = try! NSRegularExpression(
        pattern: #"^(?:https?|wss?)://(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$"#,
        options: [.caseInsensitive]
    )

    static func isWellFormedDomain(_ value: String) -> Bool {
        guard value.utf16.count <= maxDomainLength else { return false }
        let range = NSRange(value.startIndex..., in: value)
        return domainPattern.firstMatch(in: value, range: range) != nil
    }
}

/// What a tool item's output carries so a client can host the app.
public struct McpAppReference: Equatable, Sendable {
    public let attachmentID: String
    /// The MCP server the tool belongs to, as the provider names it.
    public let server: String
    public let tool: String
    public let resourceURI: String
    /// The well-formed part of the resource's declared `_meta.ui.csp`.
    public let csp: [String: [String]]?
    /// The permission names the resource declared (`_meta.ui.permissions`).
    public let permissions: Set<String>
    public let prefersBorder: Bool?

    /// Port of `readMcpAppReference`: nil unless every required field is a
    /// bounded, non-blank string and the resource is a `ui://` URI.
    public init?(json: JSONValue?) {
        guard case let .object(value)? = json else { return nil }
        func boundedName(_ key: String) -> String? {
            guard let text = value[key]?.stringValue,
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.utf16.count <= McpApps.maxNameLength else { return nil }
            return text
        }
        guard let attachmentID = boundedName("attachmentId"),
              let server = boundedName("server"),
              let tool = boundedName("tool"),
              let resourceURI = value["resourceUri"]?.stringValue,
              resourceURI.utf16.count <= McpApps.maxResourceURILength,
              resourceURI.hasPrefix(McpApps.resourceScheme) else { return nil }
        self.attachmentID = attachmentID
        self.server = server
        self.tool = tool
        self.resourceURI = resourceURI
        csp = Self.readCSP(value["csp"])
        if case let .object(declared)? = value["permissions"] {
            permissions = Set(McpApps.permissionKeys.filter {
                if case .object = declared[$0] { return true }
                return false
            })
        } else {
            permissions = []
        }
        if case let .bool(border)? = value["prefersBorder"] { prefersBorder = border } else { prefersBorder = nil }
    }

    /// The app a completed tool call carries, if any. A tool's own result can
    /// imitate the output shape, so the reference only counts when it names
    /// the very server and tool the item records: a server can then only ever
    /// point at an app of its own.
    public static func from(_ item: OrchestrationV2TurnItem) -> McpAppReference? {
        guard item.type == "dynamic_tool", item.base.rawStatus == "completed",
              case let .dynamicTool(toolName, _, output) = item.payload,
              let app = McpAppReference(json: output?[McpApps.outputKey]),
              toolName == "\(app.server).\(app.tool)" else { return nil }
        return app
    }

    /// Port of `mcpAppFileName`: the asset name the document is served under.
    public var documentFileName: String {
        var name = ""
        var inRun = false
        for scalar in tool.unicodeScalars {
            let isWord = scalar.isASCII && (CharacterSet.alphanumerics.contains(scalar) || scalar == "_" || scalar == "." || scalar == "-")
            if isWord {
                name.unicodeScalars.append(scalar)
                inRun = false
            } else if !inRun {
                name += "-"
                inRun = true
            }
        }
        let bounded = String(name.prefix(80))
        return "\(bounded.isEmpty ? "app" : bounded).html"
    }

    /// Camera, microphone and location would inherit this app's own grants, so
    /// clipboard writes are the only permission an MCP app is delegated.
    public var grantsClipboardWrite: Bool { permissions.contains("clipboardWrite") }

    /// The iframe `allow` attribute for what the app is actually granted.
    public var allowAttribute: String { grantsClipboardWrite ? "clipboard-write" : "" }

    /// `hostCapabilities.sandbox`: the declared origins and only the
    /// permissions the host delegates.
    public var sandboxCapability: JSONValue {
        var sandbox: [String: JSONValue] = [:]
        if let csp {
            sandbox["csp"] = .object(csp.mapValues { .array($0.map(JSONValue.string)) })
        }
        if grantsClipboardWrite {
            sandbox["permissions"] = .object(["clipboardWrite": .object([:])])
        }
        return .object(sandbox)
    }

    private static func readCSP(_ value: JSONValue?) -> [String: [String]]? {
        guard case let .object(declared)? = value else { return nil }
        var csp: [String: [String]] = [:]
        for key in McpApps.cspKeys {
            guard case let .array(entries)? = declared[key] else { continue }
            let domains = entries.compactMap(\.stringValue)
                .filter(McpApps.isWellFormedDomain)
                .prefix(McpApps.maxDomains)
            if !domains.isEmpty { csp[key] = Array(domains) }
        }
        return csp.isEmpty ? nil : csp
    }
}

/// `mcpApps.toolInfo`: whether an app may call a tool, and whether the
/// server declares it read-only, which decides whether the user is asked.
public struct McpAppToolInfo: Decodable, Equatable, Sendable {
    public let callable: Bool
    public let readOnly: Bool
    public let title: String?
    /// The server's MCP `Tool` definition, passed to the app as `toolInfo`.
    public let tool: JSONValue?
}

/// `McpAppRequestError.reason`. The tagged error crosses the wire without its
/// message, so the client owns the wording.
public enum McpAppRequestErrorReason {
    public static func message(for reason: String) -> String {
        switch reason {
        case "not-an-app": "This tool call has no MCP app."
        case "provider-unsupported": "This thread's provider cannot run MCP app requests."
        // A fork shows its source's apps, so this names the thread that made
        // the app rather than the one on screen.
        case "session-stopped":
            "The app's thread is not running. Send a message in the thread that created it to use the app again."
        case "tool-not-callable": "This app cannot call that tool."
        case "unsupported-content": "Only text and structured content are supported."
        default: "The app's MCP server request failed."
        }
    }
}

extension T3Client {
    public func mcpAppToolInfo(threadID: String, itemID: String, name: String) async throws -> McpAppToolInfo {
        try await rpcRequest(
            RPCMethod.mcpAppsToolInfo.rawValue,
            payload: .object(["threadId": .string(threadID), "itemId": .string(itemID), "name": .string(name)]),
            as: McpAppToolInfo.self
        )
    }

    /// The MCP `CallToolResult`, passed through to the app.
    public func mcpAppCallTool(
        threadID: String,
        itemID: String,
        name: String,
        arguments: [String: JSONValue]
    ) async throws -> JSONValue {
        try await rpcRequest(
            RPCMethod.mcpAppsCallTool.rawValue,
            payload: .object([
                "threadId": .string(threadID), "itemId": .string(itemID),
                "name": .string(name), "arguments": .object(arguments),
            ]),
            as: JSONValue.self
        )
    }

    /// The MCP `ReadResourceResult`, passed through to the app.
    public func mcpAppReadResource(threadID: String, itemID: String, uri: String) async throws -> JSONValue {
        try await rpcRequest(
            RPCMethod.mcpAppsReadResource.rawValue,
            payload: .object(["threadId": .string(threadID), "itemId": .string(itemID), "uri": .string(uri)]),
            as: JSONValue.self
        )
    }

    /// Replaces what the app tells the agent on `conversationThreadID`'s next
    /// turn; no content clears it.
    public func mcpAppUpdateModelContext(
        threadID: String,
        itemID: String,
        conversationThreadID: String,
        content: [JSONValue]?,
        structuredContent: [String: JSONValue]?
    ) async throws {
        var payload: [String: JSONValue] = [
            "threadId": .string(threadID), "itemId": .string(itemID),
            "conversationThreadId": .string(conversationThreadID),
        ]
        if let content { payload["content"] = .array(content) }
        if let structuredContent { payload["structuredContent"] = .object(structuredContent) }
        _ = try await rpcRequest(RPCMethod.mcpAppsUpdateModelContext.rawValue, payload: .object(payload), as: JSONValue.self)
    }
}
