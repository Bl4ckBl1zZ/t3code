import Foundation

/// A mint that was rejected because the caller is over its request quota.
///
/// The provider only backs off for this type, so a signed-out or offline
/// failure keeps its ordinary semantics. Anything that can see the raw
/// response hands the `Retry-After` header over verbatim; the Clerk boundary
/// recovers what it can from the SDK's error payload instead.
public struct T3ConnectRateLimitedError: Error, Equatable, Sendable {
    /// The server-advertised delay in seconds, when one was supplied.
    public let retryAfter: TimeInterval?

    public init(retryAfter: TimeInterval? = nil) {
        self.retryAfter = retryAfter
    }

    public init(retryAfterHeader: String?, now: Date = Date()) {
        retryAfter = T3ConnectRetryAfter.seconds(from: retryAfterHeader, now: now)
    }
}

/// RFC 9110 `Retry-After`: either delta-seconds or an HTTP-date.
public enum T3ConnectRetryAfter {
    public static func seconds(from header: String?, now: Date = Date()) -> TimeInterval? {
        guard let header else { return nil }
        let trimmed = header.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let delta = TimeInterval(trimmed) {
            return delta > 0 ? delta : nil
        }
        guard let date = httpDate(trimmed) else { return nil }
        let interval = date.timeIntervalSince(now)
        return interval > 0 ? interval : nil
    }

    /// A date in the past means the window has already closed, which the
    /// caller reads as "no advertised delay" rather than "retry immediately",
    /// so the exponential backoff still applies.
    private static func httpDate(_ value: String) -> Date? {
        for format in httpDateFormats {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = format
            if let date = formatter.date(from: value) { return date }
        }
        return nil
    }

    private static let httpDateFormats = [
        "EEE',' dd MMM yyyy HH':'mm':'ss zzz",
        "EEEE',' dd'-'MMM'-'yy HH':'mm':'ss zzz",
        "EEE MMM d HH':'mm':'ss yyyy",
    ]
}

/// How long the client refuses to mint after a rate-limited rejection.
public struct T3ConnectRateLimitPolicy: Equatable, Sendable {
    /// The wait after the first rejection that carried no server hint.
    public var initialDelay: TimeInterval
    public var multiplier: Double
    /// Ceiling for both the computed backoff and a server-advertised delay, so
    /// a hostile or malformed `Retry-After` cannot park the account forever.
    public var maximumDelay: TimeInterval
    /// Spreads the retries of a device that wakes several callers at once.
    public var jitterRange: ClosedRange<Double>

    public static let standard = T3ConnectRateLimitPolicy()

    public init(
        initialDelay: TimeInterval = 2,
        multiplier: Double = 2,
        maximumDelay: TimeInterval = 300,
        jitterRange: ClosedRange<Double> = 0.8...1.2
    ) {
        self.initialDelay = initialDelay
        self.multiplier = multiplier
        self.maximumDelay = maximumDelay
        self.jitterRange = jitterRange
    }

    /// A server-advertised delay wins and is not jittered: guessing shorter
    /// spends the next window, and guessing longer idles for no reason.
    public func delay(
        attempt: Int,
        retryAfter: TimeInterval? = nil,
        jitter: (ClosedRange<Double>) -> Double = { Double.random(in: $0) }
    ) -> TimeInterval {
        if let retryAfter, retryAfter > 0 {
            return min(maximumDelay, retryAfter)
        }
        // Clamped so a long-lived backoff cannot overflow `pow` into a value
        // that stops comparing usefully against the ceiling.
        let exponent = min(Double(max(0, attempt - 1)), 16)
        let backoff = initialDelay * pow(multiplier, exponent)
        return min(maximumDelay, max(0, backoff * jitter(jitterRange)))
    }
}

/// Coalesces relay-token mints and enforces a client-side rate-limit backoff.
///
/// Every T3 Connect request needs a Clerk template JWT, and the callers that
/// need one — the connect screen, device registration, managed environment
/// refresh, voice — all discover a cold token cache at the same moments.
/// Without a single in-flight mint each of them opens its own
/// `/v1/client/sessions/{id}/tokens/{template}` request, which is what
/// exhausts a development Clerk instance's quota. Once the quota is gone a
/// caller that keeps retrying on its own cadence never lets the window close,
/// so a rejection also arms a backoff that later callers fail fast against
/// instead of queueing more requests behind it.
///
/// This mirrors the per-environment coalescing in
/// `T3ConnectRuntimeAuthorization`: one stored task keyed by an id, cleared by
/// whoever created it on success and on failure alike.
@MainActor
public final class T3ConnectRelayTokenProvider {
    public typealias Mint = @MainActor @Sendable () async throws -> String

    private struct InFlightMint {
        let id: UUID
        let task: Task<String, Error>
    }

    private let mint: Mint
    private let policy: T3ConnectRateLimitPolicy
    private let now: @Sendable () -> Date
    private let jitter: @Sendable (ClosedRange<Double>) -> Double

    private var inFlight: InFlightMint?
    private var rateLimitedUntil: Date?
    private var consecutiveRateLimits = 0

    public init(
        policy: T3ConnectRateLimitPolicy = .standard,
        now: @escaping @Sendable () -> Date = { Date() },
        jitter: @escaping @Sendable (ClosedRange<Double>) -> Double = { Double.random(in: $0) },
        mint: @escaping Mint
    ) {
        self.policy = policy
        self.now = now
        self.jitter = jitter
        self.mint = mint
    }

    /// The delay still owed before another mint is attempted, or nil when the
    /// provider is not backing off.
    public var rateLimitRemaining: TimeInterval? {
        guard let rateLimitedUntil else { return nil }
        let remaining = rateLimitedUntil.timeIntervalSince(now())
        return remaining > 0 ? remaining : nil
    }

    public func token() async throws -> String {
        if let remaining = rateLimitRemaining {
            throw T3ConnectAuthError.rateLimited(retryAfter: remaining)
        }
        rateLimitedUntil = nil
        if let inFlight { return try await inFlight.task.value }

        let id = UUID()
        let task = Task<String, Error> { @MainActor [self] in
            do {
                let token = try await mint()
                guard !token.isEmpty else { throw T3ConnectAuthError.noSession }
                clearBackoff()
                return token
            } catch {
                // Recorded inside the task so the window is already armed by
                // the time any waiter resumes and considers asking again.
                throw armBackoff(for: error)
            }
        }
        inFlight = InFlightMint(id: id, task: task)
        do {
            let token = try await task.value
            finishMint(id: id)
            return token
        } catch {
            finishMint(id: id)
            throw error
        }
    }

    /// Drops the in-flight mint and the backoff window. Signing out changes
    /// who a token would be minted for, so neither remains meaningful.
    public func reset() {
        inFlight?.task.cancel()
        inFlight = nil
        clearBackoff()
    }

    private func finishMint(id: UUID) {
        guard inFlight?.id == id else { return }
        inFlight = nil
    }

    private func clearBackoff() {
        rateLimitedUntil = nil
        consecutiveRateLimits = 0
    }

    private func armBackoff(for error: any Error) -> any Error {
        guard let rateLimit = error as? T3ConnectRateLimitedError else { return error }
        consecutiveRateLimits += 1
        let delay = policy.delay(
            attempt: consecutiveRateLimits,
            retryAfter: rateLimit.retryAfter,
            jitter: jitter
        )
        rateLimitedUntil = now().addingTimeInterval(delay)
        return T3ConnectAuthError.rateLimited(retryAfter: delay)
    }
}
