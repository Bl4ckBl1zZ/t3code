import Foundation

/// Whether a shell's `lastErrorClass` (`OrchestrationV2ProviderFailureClass`)
/// says the run stopped on a provider usage limit rather than breaking. The
/// list reads such a thread as Limited instead of Failed, as web does.
public func isUsageLimitFailureClass(_ failureClass: String?) -> Bool {
    failureClass == "usage_limit"
}
