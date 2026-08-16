import Foundation

// Presentation for the thread's Ports header menu. Ported from
// apps/mobile/src/features/threads/threadPortsMenu.ts, together with the two
// endpoint types it reads — packages/shared/src/threadEndpoints.ts's
// `ThreadEndpoint` and packages/shared/src/endpointReachability.ts's
// `EndpointReachability` — so both clients describe the same rows identically.
//
// Mobile inverts the desktop hierarchy: the name leads and the address follows.
// A phone is never the machine running the server, so the announced
// `localhost:5173` names the handset and would be a lie — only the *resolved*
// address is worth showing, and only once it is known to be reachable.

public enum ThreadEndpointStatus: String, Equatable, Sendable {
    /// A live listening socket backs this endpoint.
    case live
    /// Announced in output but not yet confirmed listening.
    case starting
    /// Was live, has stopped answering — held briefly so restarts do not flicker.
    case stale
    /// Pinned by configuration with nothing serving it. Only pinned rows reach this.
    case idle
}

public enum ThreadEndpointSource: String, Equatable, Sendable {
    case declared
    case stdout
    case scanner
}

/// Whether the device looking at an endpoint can actually open it.
///
/// Resolved upstream, where the environment's own address is known: a
/// presentation module cannot rewrite a loopback URL because it has nothing to
/// rewrite it against.
public enum EndpointReachability: Equatable, Sendable {
    /// `direct` when the environment is this machine; otherwise routed over the LAN/tailnet.
    public enum Route: String, Equatable, Sendable {
        case direct
        case privateNetwork = "private-network"
    }

    case reachable(url: String, via: Route)
    /// Carries the sentence a row shows in place of an address. A reason is the
    /// only honest alternative to handing back a loopback URL that would
    /// silently resolve to the handset.
    case unreachable(reason: String)
}

/// A dev server this thread is running, plus how this device reaches it.
///
/// The merge that produces these lives server-adjacent
/// (packages/shared/src/threadEndpoints.ts); this is the row it hands the menu.
public struct ThreadEndpoint: Equatable, Sendable, Identifiable {
    /// Stable identity across ticks. One local port is one endpoint, whichever
    /// host form announced it; a remote endpoint is identified by `host:port`,
    /// since there is no local port to collapse it onto.
    public let key: String
    /// The announced URL. Openable only after resolution — see `reachability`.
    public let url: String
    public let host: String
    public let port: Int
    public let status: ThreadEndpointStatus
    public let source: ThreadEndpointSource
    public let terminalID: String?
    /// Project script attributed to the owning terminal, when there is one.
    public let scriptID: String?
    public let processName: String?
    /// True for the project's configured `previewUrl`: the row is listed whether
    /// or not anything is serving it, and sorts above the discovered ones.
    public let pinned: Bool
    /// True when this endpoint lives on the environment's loopback, which is the
    /// only place either liveness signal can see. False means the status is the
    /// absence of evidence, not evidence of absence — rows presenting one say so.
    public let local: Bool
    /// Epoch ms when this endpoint was first observed; drives stable ordering.
    public let firstSeenAtMs: Int
    public let reachability: EndpointReachability
    /// Resolved `host:port` to display, or nil when unreachable. Precomputed
    /// rather than derived here: it is the host of the *resolved* URL, and a
    /// pinned row may point somewhere other than what it announced.
    public let displayAddress: String?

    public var id: String { key }

    public init(
        key: String,
        url: String,
        host: String,
        port: Int,
        status: ThreadEndpointStatus,
        source: ThreadEndpointSource,
        terminalID: String?,
        scriptID: String?,
        processName: String?,
        pinned: Bool,
        local: Bool,
        firstSeenAtMs: Int,
        reachability: EndpointReachability,
        displayAddress: String?
    ) {
        self.key = key
        self.url = url
        self.host = host
        self.port = port
        self.status = status
        self.source = source
        self.terminalID = terminalID
        self.scriptID = scriptID
        self.processName = processName
        self.pinned = pinned
        self.local = local
        self.firstSeenAtMs = firstSeenAtMs
        self.reachability = reachability
        self.displayAddress = displayAddress
    }
}

public enum ThreadPortsMenu {
    /// Tint applied to the toolbar icon once something is actually serving.
    /// Kept as the hex the other client uses so the two agree exactly; the view
    /// layer turns it into a colour, as with every other ported presentation.
    public static let liveTint = "#10b981"

    public static func tintColor(for endpoints: [ThreadEndpoint]) -> String? {
        endpoints.contains { $0.status == .live } ? liveTint : nil
    }

    /// Neutral wording: rows can be starting or no longer responding, so
    /// describing them all as "serving" would announce something untrue.
    public static func accessibilityLabel(for endpoints: [ThreadEndpoint]) -> String {
        if endpoints.count == 1 { return "1 port in this thread" }
        return "\(endpoints.count) ports in this thread"
    }

    /// SF Symbol per endpoint state, so the list reads without relying on colour.
    public static func icon(for endpoint: ThreadEndpoint) -> String {
        if case .unreachable = endpoint.reachability { return "exclamationmark.triangle" }
        if endpoint.status == .starting { return "clock" }
        if endpoint.status == .stale { return "moon.zzz" }
        // Pinned rows keep the pin while idle: nothing is expected to be serving
        // a configured address, so the sleeping icon every other idle row gets
        // would read as a fault rather than as the project's standing address.
        if endpoint.pinned { return "pin.fill" }
        return endpoint.status == .idle ? "moon.zzz" : "globe"
    }

    /// Primary line: what the user recognises. The script they ran, else the
    /// process serving it, else the bare port.
    public static func label(for endpoint: ThreadEndpoint, scripts: [ProjectScript]) -> String {
        if let scriptID = endpoint.scriptID,
           let script = scripts.first(where: { $0.id == scriptID }) {
            return script.name
        }
        if let processName = endpoint.processName,
           !processName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return processName
        }
        // A pinned remote origin is named by its host, never by its port: nothing
        // announced it, so there is no script or process to name it after, and
        // "Port 443" says nothing about which host the row would open.
        if endpoint.pinned, !endpoint.local { return endpoint.host }
        return "Port \(endpoint.port)"
    }

    /// Secondary line: the address this device will actually hit, or why it
    /// cannot. Never the announced URL — that is the one thing guaranteed to be
    /// wrong here.
    public static func subtitle(for endpoint: ThreadEndpoint) -> String {
        if case let .unreachable(reason) = endpoint.reachability { return reason }
        let address = endpoint.displayAddress ?? "port \(endpoint.port)"
        switch endpoint.status {
        case .starting:
            return "Starting…"
        case .stale:
            return "\(address) · no longer responding"
        case .live:
            return endpoint.pinned ? "Pinned · \(address)" : address
        case .idle:
            // Both liveness signals only ever see the machine running the
            // environment, so "not running" is a claim only a local endpoint
            // earns. A pinned remote origin — a tunnel, a staging host — is
            // reported as what it is: configuration.
            return endpoint.local ? "\(address) · not running" : "Pinned"
        }
    }

    /// Endpoints that can be opened right now, in menu order. A stale row stays
    /// listed and stays copyable, but opening it would hit nothing.
    public static func openable(_ endpoints: [ThreadEndpoint]) -> [ThreadEndpoint] {
        endpoints.filter { endpoint in
            guard case .reachable = endpoint.reachability else { return false }
            return endpoint.status != .stale
        }
    }
}
