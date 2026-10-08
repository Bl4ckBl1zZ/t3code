import Foundation

/// A provider stopping on a subscription usage limit: a wait-or-switch
/// warning rather than a failed call. Mirrors the `usage_limit` failure class
/// in `packages/contracts/src/orchestrationV2.ts`.
public enum UsageLimitFailure {
    public static let failureClass = "usage_limit"

    public static func isUsageLimit(_ failureClass: String?) -> Bool {
        failureClass == Self.failureClass
    }
}
