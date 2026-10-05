import Foundation

/// Why this build cannot talk to a server, from its public descriptor.
public struct EnvironmentCompatibilityIssue: Equatable, Sendable {
    public let reason: String
    /// The server is older and can be updated from this app.
    public let serverUpdateRequired: Bool

    public init(reason: String, serverUpdateRequired: Bool) {
        self.reason = reason
        self.serverUpdateRequired = serverUpdateRequired
    }
}

/// Raised when a server answers with an orchestration protocol this build
/// cannot speak. It is the same server on every route, so a route walk stops.
public struct EnvironmentIncompatibleError: LocalizedError, Equatable, Sendable {
    public let issue: EnvironmentCompatibilityIssue

    public init(_ issue: EnvironmentCompatibilityIssue) {
        self.issue = issue
    }

    public var errorDescription: String? { issue.reason }
}

extension OrchestrationProtocol {
    /// The issue with talking to a server, or nil when it is compatible.
    ///
    /// A server that names no version predates negotiation. Upstream reads
    /// that as version 1; this fork's servers that predate negotiation all
    /// speak this wire, so they count as compatible, the same rule as
    /// `orchestrationProtocolCompatibilityError` in the client runtime.
    public static func compatibilityIssue(
        with descriptor: EnvironmentDescriptor
    ) -> EnvironmentCompatibilityIssue? {
        guard let serverVersion = descriptor.orchestrationProtocolVersion,
              serverVersion != version else {
            return nil
        }
        if serverVersion > version {
            return EnvironmentCompatibilityIssue(
                reason: "This app is not supported by \(descriptor.label). Update the app to connect.",
                serverUpdateRequired: false
            )
        }
        return EnvironmentCompatibilityIssue(
            reason: "This app requires a newer server. Update T3 Code on \(descriptor.label) to connect.",
            serverUpdateRequired: canUpdateFromApp(descriptor)
        )
    }

    /// Whether this app can drive the server's update: only desktop-managed
    /// servers whose desktop app accepts remote updates. Other servers need
    /// an exact npm version this app does not know, so they get manual
    /// guidance instead.
    public static func canUpdateFromApp(_ descriptor: EnvironmentDescriptor) -> Bool {
        descriptor.capabilities.serverSelfUpdate == "desktop-managed"
            && descriptor.capabilities.desktopAppUpdate == true
    }
}
