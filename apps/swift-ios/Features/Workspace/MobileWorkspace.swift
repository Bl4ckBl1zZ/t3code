import Foundation

/// One environment's slice of the server config, in the order environments were
/// connected, so anything that takes the first matching environment picks the
/// same one between runs rather than whichever one hashing puts first.
public struct MobileWorkspaceEnvironmentConfig: Equatable, Sendable {
    public let environmentID: String
    public let providers: [ServerProviderSnapshot]
    /// The folder behind the server's Scratch project ("No project"). Absent
    /// on servers that cannot start a thread without one.
    public var scratchWorkspaceRoot: String? = nil

    public init(
        environmentID: String,
        providers: [ServerProviderSnapshot]
    ) {
        self.environmentID = environmentID
        self.providers = providers
    }
}
