import Foundation

/// The network a route travels over, ranked so a newly added route lands
/// after every saved route of the same or a faster kind.
public enum EnvironmentRouteNetwork: Int, Comparable, Sendable {
    case loopback
    case lan
    case tailnet
    case publicInternet
    case relay

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// One way to reach a saved environment: T3 Connect, or a direct URL on the
/// LAN, a tailnet, or the internet.
///
/// A saved environment holds several routes in preference order. The client
/// connects over the first one that answers as that environment and moves back
/// to a better one when it becomes reachable again. Each route names the
/// Keychain account of the credential it uses, so a route the server reported
/// (`learned`) can borrow the credential of the route it was learned over,
/// and routes saved before routes existed keep the credential stored under
/// the environment id.
public struct EnvironmentRoute: Codable, Equatable, Hashable, Identifiable, Sendable {
    /// An environment has at most one T3 Connect route.
    public static let relayID = "relay"

    public let id: String
    public var httpBaseURL: URL
    public var webSocketBaseURL: URL
    /// How requests over this route authenticate: a bearer token or the T3
    /// Connect DPoP credential.
    public var kind: EnvironmentKind
    /// The Keychain account holding this route's credential.
    public var credentialID: String
    /// Set on a route the server reported while this device was connected,
    /// rather than one the user paired. Learned routes are replaced when the
    /// server reports a different address and are never offered for removal.
    public var learned: Bool

    public init(
        id: String,
        httpBaseURL: URL,
        webSocketBaseURL: URL,
        kind: EnvironmentKind,
        credentialID: String,
        learned: Bool = false
    ) {
        self.id = id
        self.httpBaseURL = httpBaseURL
        self.webSocketBaseURL = webSocketBaseURL
        self.kind = kind
        self.credentialID = credentialID
        self.learned = learned
    }

    /// A route the user paired or connected through T3 Connect.
    public static func saved(
        httpBaseURL: URL,
        webSocketBaseURL: URL,
        kind: EnvironmentKind,
        credentialID: String
    ) -> EnvironmentRoute {
        EnvironmentRoute(
            id: kind == .managedDPoP ? relayID : directID(httpBaseURL),
            httpBaseURL: httpBaseURL,
            webSocketBaseURL: webSocketBaseURL,
            kind: kind,
            credentialID: credentialID
        )
    }

    public static func directID(_ httpBaseURL: URL) -> String {
        "direct:\(origin(httpBaseURL))"
    }

    /// Whether this is the T3 Connect tunnel itself, as opposed to a direct
    /// address that borrows the T3 Connect credential.
    public var isRelay: Bool { kind == .managedDPoP && !learned }

    public var network: EnvironmentRouteNetwork {
        if isRelay { return .relay }
        let host = httpBaseURL.host ?? ""
        if HostClassification.isLoopback(host) { return .loopback }
        if HostClassification.isTailnet(host) { return .tailnet }
        return HostClassification.isPrivateNetwork(host) ? .lan : .publicInternet
    }

    /// Short user-facing description: "LAN", "Tailscale", "T3 Connect", or a host.
    public var label: String {
        switch network {
        case .relay: "T3 Connect"
        case .loopback: "This device"
        case .lan: "LAN"
        case .tailnet: "Tailscale"
        case .publicInternet: httpBaseURL.host ?? "Remote link"
        }
    }

    /// The address shown under a route, or nil for T3 Connect.
    public var address: String? {
        isRelay ? nil : Self.origin(httpBaseURL)
    }

    /// `scheme://host[:port]`, lowercased, without a trailing slash.
    public static func origin(_ url: URL) -> String {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else {
            return url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        let hostPart = host.contains(":") ? "[\(host)]" : host
        let portPart = url.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(hostPart)\(portPart)"
    }

    private enum CodingKeys: String, CodingKey {
        case id, httpBaseURL, webSocketBaseURL, kind, credentialID, learned
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        httpBaseURL = try container.decode(URL.self, forKey: .httpBaseURL)
        webSocketBaseURL = try container.decode(URL.self, forKey: .webSocketBaseURL)
        kind = try container.decode(EnvironmentKind.self, forKey: .kind)
        credentialID = try container.decode(String.self, forKey: .credentialID)
        learned = try container.decodeIfPresent(Bool.self, forKey: .learned) ?? false
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(httpBaseURL, forKey: .httpBaseURL)
        try container.encode(webSocketBaseURL, forKey: .webSocketBaseURL)
        try container.encode(kind, forKey: .kind)
        try container.encode(credentialID, forKey: .credentialID)
        if learned { try container.encode(true, forKey: .learned) }
    }
}

/// An address the server reports it listens on, from `ServerConfig.directEndpoints`.
public struct ServerDirectEndpoint: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case lan
        case tailnet
    }

    public let kind: Kind
    public let httpBaseUrl: String

    public init(kind: Kind, httpBaseUrl: String) {
        self.kind = kind
        self.httpBaseUrl = httpBaseUrl
    }
}

/// Pure route-list rules shared by pairing, T3 Connect, learning, and Settings.
public enum EnvironmentRoutes {
    /// Where a new route goes: after every saved route of the same or a faster
    /// network, so LAN lands ahead of Tailscale and both ahead of T3 Connect.
    public static func inserting(
        _ route: EnvironmentRoute,
        into routes: [EnvironmentRoute]
    ) -> [EnvironmentRoute] {
        var next = routes
        let index = routes.firstIndex { $0.network > route.network } ?? routes.count
        next.insert(route, at: index)
        return next
    }

    /// Replaces the route with the same id in place, and any other route to the
    /// same address, or inserts it by network.
    public static func upserting(
        _ route: EnvironmentRoute,
        into routes: [EnvironmentRoute]
    ) -> [EnvironmentRoute] {
        let address = route.isRelay ? nil : EnvironmentRoute.origin(route.httpBaseURL)
        let others = routes.filter { existing in
            existing.id == route.id
                || address == nil
                || existing.isRelay
                || EnvironmentRoute.origin(existing.httpBaseURL) != address
        }
        if others.contains(where: { $0.id == route.id }) {
            return others.map { $0.id == route.id ? route : $0 }
        }
        return inserting(route, into: others)
    }

    /// The routes after the server reports where it listens, or nil when
    /// nothing changes. Each newly reported address becomes a learned route
    /// that authenticates like the route in use: the paired token for a direct
    /// route, the T3 Connect credential for relay. A learned route the server
    /// still reports keeps its place, so the user's order holds; one it no
    /// longer reports is dropped, so a changed LAN address replaces the old
    /// one. Routes the user saved are never touched, an address already saved
    /// is not learned twice, and loopback addresses (which name whichever
    /// device opens them) are ignored.
    public static func mergingLearned(
        into routes: [EnvironmentRoute],
        activeRoute: EnvironmentRoute,
        reported: [ServerDirectEndpoint],
        allowInsecure: Bool = true
    ) -> [EnvironmentRoute]? {
        var reportedOrigins: [String] = []
        var reportedURLs: [String: URL] = [:]
        for endpoint in reported {
            guard let url = URL(string: endpoint.httpBaseUrl),
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https",
                  let host = url.host, !host.isEmpty,
                  scheme == "https" || allowInsecure,
                  !HostClassification.isLoopback(host) else { continue }
            let origin = EnvironmentRoute.origin(url)
            if reportedURLs[origin] == nil { reportedOrigins.append(origin) }
            reportedURLs[origin] = url
        }

        var known = Set(
            routes.filter { !$0.learned && !$0.isRelay }
                .map { EnvironmentRoute.origin($0.httpBaseURL) }
        )
        let kept = routes.filter { route in
            guard route.learned else { return true }
            let origin = EnvironmentRoute.origin(route.httpBaseURL)
            guard reportedURLs[origin] != nil, !known.contains(origin) else { return false }
            known.insert(origin)
            return true
        }
        var next = kept
        for origin in reportedOrigins where !known.contains(origin) {
            guard let url = reportedURLs[origin],
                  let httpBaseURL = URL(string: "\(origin)/"),
                  let webSocketBaseURL = webSocketBaseURL(for: url) else { continue }
            known.insert(origin)
            next = inserting(
                EnvironmentRoute(
                    id: "learned:\(origin)",
                    httpBaseURL: httpBaseURL,
                    webSocketBaseURL: webSocketBaseURL,
                    // A route learned over another learned route inherits what
                    // that one uses: the T3 Connect credential, or the paired
                    // token it borrows.
                    kind: activeRoute.kind == .managedDPoP ? .managedDPoP : .bearer,
                    credentialID: activeRoute.credentialID,
                    learned: true
                ),
                into: next
            )
        }
        return signature(next) == signature(routes) ? nil : next
    }

    // Compares addresses too: a scheme or port change keeps no id stable.
    private static func signature(_ routes: [EnvironmentRoute]) -> [String] {
        routes.map { route in "\(route.id) \(route.httpBaseURL.absoluteString)" }
    }

    /// `ws://host[:port]/` for an `http` address, `wss://` for `https`.
    static func webSocketBaseURL(for httpURL: URL) -> URL? {
        guard var components = URLComponents(url: httpURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.scheme = httpURL.scheme?.lowercased() == "https" ? "wss" : "ws"
        components.path = "/"
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        return components.url
    }

    /// Routes left after the user removes one. A learned route borrows the
    /// credential of the route it was learned over, so it cannot outlive that
    /// route: removing T3 Connect also removes routes learned through it, and
    /// removing a paired address removes routes that borrow its token.
    public static func removing(
        _ routeID: String,
        from routes: [EnvironmentRoute]
    ) -> [EnvironmentRoute] {
        guard let removed = routes.first(where: { $0.id == routeID }) else { return routes }
        return routes.filter { route in
            route.id != removed.id
                && !(route.learned && route.credentialID == removed.credentialID)
        }
    }

    /// The routes in the order of `routeIDs`, or nil unless it lists every
    /// saved route exactly once.
    public static func reordered(
        _ routes: [EnvironmentRoute],
        as routeIDs: [String]
    ) -> [EnvironmentRoute]? {
        guard routeIDs.count == routes.count, Set(routeIDs).count == routes.count else {
            return nil
        }
        let byID = Dictionary(routes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let next = routeIDs.compactMap { byID[$0] }
        return next.count == routes.count ? next : nil
    }

    /// The address an agent outside T3 (Claude Code, Codex) uses to reach this
    /// environment's MCP server: `/mcp` on the first route, in preference
    /// order, that qualifies. Mirrors `environmentMcpUrl` in the client
    /// runtime: only HTTPS and loopback addresses qualify, because MCP clients
    /// refuse to sign in through a plain-http token endpoint elsewhere. The
    /// T3 Connect route qualifies through the relay address discovery gave it.
    public static func mcpURL(_ routes: [EnvironmentRoute]) -> URL? {
        routes.lazy.compactMap { mcpURL(httpBaseURL: $0.httpBaseURL) }.first
    }

    static func mcpURL(httpBaseURL: URL?) -> URL? {
        guard let httpBaseURL,
              let scheme = httpBaseURL.scheme?.lowercased(),
              let host = httpBaseURL.host, !host.isEmpty,
              scheme == "https" || (scheme == "http" && HostClassification.isLoopback(host)),
              var components = URLComponents(url: httpBaseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = "/mcp"
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        return components.url
    }

    /// Identifies the addresses the user saved for an environment, ignoring
    /// order and learned routes. Compatibility state learned about an
    /// environment carries over while this stays the same: reordering or
    /// learning an address keeps it, adding or changing a saved route resets it.
    public static func endpointKey(_ routes: [EnvironmentRoute]) -> String {
        routes.filter { !$0.learned }
            .map { "\($0.id)|\($0.httpBaseURL.absoluteString)|\($0.webSocketBaseURL.absoluteString)" }
            .sorted()
            .joined(separator: "\n")
    }
}
