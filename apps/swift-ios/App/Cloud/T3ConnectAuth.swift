import ClerkKit
import Foundation

public struct T3ConnectAccount: Equatable, Sendable {
    public let id: String
    public let email: String?
    public let imageURL: URL?
}

public enum T3ConnectAuthError: LocalizedError, Equatable, Sendable {
    case noSession
    /// Clerk refused to mint a relay token because the instance is over its
    /// request quota. `retryAfter` is the window this client has armed, so a
    /// caller with its own retry loop can reschedule instead of spending the
    /// next window too. The fork's Clerk instance is a development instance,
    /// whose limits are low enough that this is a routine state, not a bug.
    case rateLimited(retryAfter: TimeInterval)

    public var errorDescription: String? {
        switch self {
        case .noSession:
            "Sign in to your T3 account to use T3 Connect."
        case let .rateLimited(retryAfter):
            "T3 Connect is rate limited. Retrying in \(Self.phrase(retryAfter))."
        }
    }

    /// Non-nil only while this client is deliberately backing off.
    public var retryAfter: TimeInterval? {
        guard case let .rateLimited(retryAfter) = self else { return nil }
        return retryAfter
    }

    private static func phrase(_ seconds: TimeInterval) -> String {
        let whole = max(1, Int(seconds.rounded(.up)))
        guard whole >= 60 else { return "\(whole)s" }
        return "\(Int((Double(whole) / 60).rounded(.up)))m"
    }
}

enum T3ConnectAuthCallback {
    static let scheme = PlatformRoute.nativeScheme
    static let redirectURL = "\(scheme)://clerk-callback"
}

/// ClerkKit reports API failures as `ClerkAPIError`, which keeps the decoded
/// error code but drops the HTTP status and every response header — including
/// `Retry-After`. A 429 therefore has to be recognised from the payload, and
/// the only advertised delay that survives is whatever Clerk echoed into
/// `meta`.
enum T3ConnectClerkRateLimit {
    static func translated(_ error: any Error) -> any Error {
        if error is T3ConnectRateLimitedError { return error }
        guard let apiError = error as? ClerkAPIError,
              isRateLimited(
                  code: apiError.code,
                  message: apiError.longMessage ?? apiError.message
              )
        else { return error }
        return T3ConnectRateLimitedError(retryAfter: retryAfterHint(apiError.meta))
    }

    static func isRateLimited(code: String, message: String?) -> Bool {
        let haystack = "\(code) \(message ?? "")".lowercased()
        return haystack.contains("rate_limit")
            || haystack.contains("rate limit")
            || haystack.contains("too_many_requests")
            || haystack.contains("too many requests")
    }

    static func retryAfterHint(_ meta: JSON?) -> TimeInterval? {
        guard let meta else { return nil }
        for key in ["retry_after", "retryAfter", "retry_after_seconds"] {
            if let value = meta[key]?.doubleValue, value > 0 { return value }
            if let text = meta[key]?.stringValue,
               let seconds = T3ConnectRetryAfter.seconds(from: text) {
                return seconds
            }
        }
        return nil
    }
}

/// Small ClerkKit boundary. Clerk owns encrypted session persistence and the
/// ASWebAuthenticationSession callback; the app only asks for the relay JWT.
///
/// Both network calls it makes are coalesced. ClerkKit caches the template
/// token, but a cold or rejected cache lets every concurrent caller open its
/// own request, and a development Clerk instance runs out of quota long before
/// that stops being noticeable.
@MainActor
public final class T3ConnectClerkSession {
    private let clerk: Clerk
    private let tokens: T3ConnectRelayTokenProvider
    private var inFlightRefresh: InFlightRefresh?

    private struct InFlightRefresh {
        let id: UUID
        let task: Task<Void, Error>
    }

    public init(
        configuration: T3ConnectConfiguration,
        rateLimitPolicy: T3ConnectRateLimitPolicy = .standard
    ) {
        let clerk = Clerk.configure(
            publishableKey: configuration.clerkPublishableKey,
            options: .init(
                redirectConfig: .init(
                    redirectUrl: T3ConnectAuthCallback.redirectURL,
                    callbackUrlScheme: T3ConnectAuthCallback.scheme
                )
            )
        )
        self.clerk = clerk
        let jwtTemplate = configuration.clerkJWTTemplate
        tokens = T3ConnectRelayTokenProvider(policy: rateLimitPolicy) {
            do {
                let token = try await clerk.auth.getToken(
                    .init(template: jwtTemplate, expirationBuffer: 20)
                )
                guard let token, !token.isEmpty else { throw T3ConnectAuthError.noSession }
                return token
            } catch {
                throw T3ConnectClerkRateLimit.translated(error)
            }
        }
    }

    var client: Clerk { clerk }

    public var account: T3ConnectAccount? {
        guard let user = clerk.user else { return nil }
        return T3ConnectAccount(
            id: user.id,
            email: user.primaryEmailAddress?.emailAddress,
            imageURL: URL(string: user.imageUrl)
        )
    }

    public var isLoaded: Bool { clerk.isLoaded }

    /// Non-nil while the relay token is in a backoff window, so a caller can
    /// tell "rate limited, retrying" apart from "sign-in failed".
    public var rateLimitRemaining: TimeInterval? { tokens.rateLimitRemaining }

    public func refresh() async throws {
        if let inFlightRefresh { return try await inFlightRefresh.task.value }
        let clerk = clerk
        let task = Task<Void, Error> {
            do {
                _ = try await clerk.refreshClient()
            } catch {
                throw T3ConnectClerkRateLimit.translated(error)
            }
        }
        let id = UUID()
        inFlightRefresh = InFlightRefresh(id: id, task: task)
        do {
            try await task.value
            finishRefresh(id: id)
        } catch {
            finishRefresh(id: id)
            throw error
        }
    }

    public func signOut() async throws {
        try await clerk.auth.signOut()
        tokens.reset()
        inFlightRefresh?.task.cancel()
        inFlightRefresh = nil
    }

    public func relayToken() async throws -> String {
        try await tokens.token()
    }

    private func finishRefresh(id: UUID) {
        guard inFlightRefresh?.id == id else { return }
        inFlightRefresh = nil
    }
}
