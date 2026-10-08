import Foundation

// The capability groups `canForkProjectedAssistantItem` reads
// (packages/client-runtime/src/state/threadWorkflows.ts), narrowed to those
// flags. Decoding is tolerant: a flag this build cannot read is false, which
// only matters when a descriptor is present at all — an absent group means
// "no evidence" and leaves the portable server-side fork available.

/// `OrchestrationV2ThreadCapabilities`, narrowed to forking.
public struct OrchestrationV2ThreadForkCapabilities: Codable, Equatable, Sendable {
    public let canForkThread: Bool
    public let canForkFromTurn: Bool

    public init(canForkThread: Bool = false, canForkFromTurn: Bool = false) {
        self.canForkThread = canForkThread
        self.canForkFromTurn = canForkFromTurn
    }

    private enum CodingKeys: String, CodingKey { case canForkThread, canForkFromTurn }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        canForkThread = try container.decodeIfPresent(Bool.self, forKey: .canForkThread) ?? false
        canForkFromTurn = try container.decodeIfPresent(Bool.self, forKey: .canForkFromTurn) ?? false
    }
}

/// `OrchestrationV2IdentityCapabilities`, narrowed to thread ids. The strength
/// stays a string (`strong`, `weak`, `none`) so a new level still decodes.
public struct OrchestrationV2IdentityCapabilities: Codable, Equatable, Sendable {
    public let nativeThreadIds: String?

    public init(nativeThreadIds: String? = nil) {
        self.nativeThreadIds = nativeThreadIds
    }
}

/// `OrchestrationV2ContextCapabilities`, narrowed to full-thread handoff.
public struct OrchestrationV2ContextHandoffCapabilities: Codable, Equatable, Sendable {
    public let supportsFullThreadHandoff: Bool

    public init(supportsFullThreadHandoff: Bool = false) {
        self.supportsFullThreadHandoff = supportsFullThreadHandoff
    }

    private enum CodingKeys: String, CodingKey { case supportsFullThreadHandoff }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        supportsFullThreadHandoff = try container.decodeIfPresent(Bool.self, forKey: .supportsFullThreadHandoff) ?? false
    }
}

/// What a provider session can do about forking one of its responses.
public struct ThreadForkCapabilities: Equatable, Sendable {
    public let canForkThread: Bool
    public let canForkFromTurn: Bool
    public let hasStrongNativeThreadIDs: Bool
    public let supportsFullThreadHandoff: Bool

    public init(
        canForkThread: Bool,
        canForkFromTurn: Bool,
        hasStrongNativeThreadIDs: Bool,
        supportsFullThreadHandoff: Bool
    ) {
        self.canForkThread = canForkThread
        self.canForkFromTurn = canForkFromTurn
        self.hasStrongNativeThreadIDs = hasStrongNativeThreadIDs
        self.supportsFullThreadHandoff = supportsFullThreadHandoff
    }

    /// Nil unless all three groups arrived: a descriptor missing one is no
    /// evidence either way, the same as no descriptor.
    public init?(_ capabilities: OrchestrationV2ProviderCapabilities?) {
        guard let threads = capabilities?.threads,
              let identity = capabilities?.identity,
              let context = capabilities?.context else { return nil }
        self.init(
            canForkThread: threads.canForkThread,
            canForkFromTurn: threads.canForkFromTurn,
            hasStrongNativeThreadIDs: identity.nativeThreadIds == "strong",
            supportsFullThreadHandoff: context.supportsFullThreadHandoff
        )
    }

    /// The provider can fork its own thread but only at its head, so the fork
    /// takes the latest stable point rather than the named run.
    public var forksLatestOnly: Bool { canForkThread && !canForkFromTurn }

    /// `canForkProjectedAssistantItem` past its item checks.
    public func allowsFork(isLatestRun: Bool) -> Bool {
        let native = canForkThread && (canForkFromTurn || isLatestRun) && hasStrongNativeThreadIDs
        return native || supportsFullThreadHandoff
    }
}
