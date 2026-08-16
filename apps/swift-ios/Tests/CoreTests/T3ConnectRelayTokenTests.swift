import XCTest
@testable import T3Code

/// Regression cover for the Clerk token-request storm: concurrent callers used
/// to mint independently, and a 429 used to be retried on each caller's own
/// cadence, which kept a development Clerk instance permanently over quota.
@MainActor
final class T3ConnectRelayTokenTests: XCTestCase {
    private static let fixedNow = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - Coalescing

    func testConcurrentCallersShareASingleMint() async throws {
        let minter = RecordingMinter()
        minter.hold()
        let provider = T3ConnectRelayTokenProvider { try await minter.mint() }

        let first = Task { try await provider.token() }
        await minter.waitUntilMintStarted()

        let waiters = (0 ..< 4).map { _ in Task { try await provider.token() } }
        await settle()
        XCTAssertEqual(
            minter.calls,
            1,
            "Callers arriving while a mint is in flight must not open their own request."
        )

        minter.releaseMint()
        let firstToken = try await first.value
        XCTAssertEqual(firstToken, "relay-token")
        for waiter in waiters {
            let token = try await waiter.value
            XCTAssertEqual(token, "relay-token")
        }
        XCTAssertEqual(minter.calls, 1)
    }

    func testEveryWaiterOnARateLimitedMintSharesTheSameBackoff() async throws {
        let clock = TestClock(Self.fixedNow)
        let minter = RecordingMinter()
        minter.result = .failure(T3ConnectRateLimitedError())
        minter.hold()
        let provider = provider(minter: minter, clock: clock)

        let first = Task { try await provider.token() }
        await minter.waitUntilMintStarted()
        let waiters = (0 ..< 3).map { _ in Task { try await provider.token() } }
        await settle()
        minter.releaseMint()

        await assertRateLimited(retryAfter: 2) { try await first.value }
        for waiter in waiters {
            await assertRateLimited(retryAfter: 2) { try await waiter.value }
        }
        XCTAssertEqual(
            minter.calls,
            1,
            "A rate-limited mint must be shared, not repeated once per waiter."
        )

        // Success once the window closes resolves every later caller.
        minter.result = .success("relay-token")
        clock.advance(2.5)
        let resumed = (0 ..< 3).map { _ in Task { try await provider.token() } }
        for task in resumed {
            let token = try await task.value
            XCTAssertEqual(token, "relay-token")
        }
        XCTAssertEqual(minter.calls, 2)
    }

    // MARK: - Backoff

    func testRateLimitBacksOffInsteadOfRetryingImmediately() async throws {
        let clock = TestClock(Self.fixedNow)
        let minter = RecordingMinter()
        minter.result = .failure(T3ConnectRateLimitedError())
        let provider = provider(minter: minter, clock: clock)

        await assertRateLimited(retryAfter: 2) { try await provider.token() }
        XCTAssertEqual(minter.calls, 1)

        // A caller inside the window fails fast without touching the network,
        // even though the next mint would now succeed.
        minter.result = .success("relay-token")
        clock.advance(1)
        await assertRateLimited(retryAfter: 1) { try await provider.token() }
        XCTAssertEqual(minter.calls, 1)

        clock.advance(1.5)
        let token = try await provider.token()
        XCTAssertEqual(token, "relay-token")
        XCTAssertEqual(minter.calls, 2)
        XCTAssertNil(provider.rateLimitRemaining)
    }

    func testConsecutiveRateLimitsGrowExponentiallyUpToTheCeiling() async throws {
        let clock = TestClock(Self.fixedNow)
        let minter = RecordingMinter()
        minter.result = .failure(T3ConnectRateLimitedError())
        let provider = provider(
            minter: minter,
            clock: clock,
            policy: T3ConnectRateLimitPolicy(
                initialDelay: 2,
                multiplier: 2,
                maximumDelay: 10,
                jitterRange: 1 ... 1
            )
        )

        for expected in [2.0, 4.0, 8.0, 10.0, 10.0] {
            await assertRateLimited(retryAfter: expected) { try await provider.token() }
            clock.advance(expected + 0.1)
        }
        XCTAssertEqual(minter.calls, 5)

        // A success is the only proof the quota recovered, so it resets the ramp.
        minter.result = .success("relay-token")
        let token = try await provider.token()
        XCTAssertEqual(token, "relay-token")
        minter.result = .failure(T3ConnectRateLimitedError())
        await assertRateLimited(retryAfter: 2) { try await provider.token() }
    }

    func testJitterIsAppliedToTheComputedBackoff() {
        let policy = T3ConnectRateLimitPolicy(
            initialDelay: 2,
            multiplier: 2,
            maximumDelay: 300,
            jitterRange: 0.8 ... 1.2
        )
        XCTAssertEqual(policy.delay(attempt: 1, jitter: { $0.lowerBound }), 1.6, accuracy: 0.0001)
        XCTAssertEqual(policy.delay(attempt: 1, jitter: { $0.upperBound }), 2.4, accuracy: 0.0001)
        XCTAssertEqual(policy.delay(attempt: 40, jitter: { $0.upperBound }), 300)
    }

    // MARK: - Retry-After

    func testRetryAfterHintIsHonouredOverTheComputedBackoff() async throws {
        let clock = TestClock(Self.fixedNow)
        let minter = RecordingMinter()
        minter.result = .failure(T3ConnectRateLimitedError(retryAfterHeader: "45"))
        let provider = provider(minter: minter, clock: clock)

        await assertRateLimited(retryAfter: 45) { try await provider.token() }

        clock.advance(44)
        await assertRateLimited(retryAfter: 1) { try await provider.token() }
        XCTAssertEqual(minter.calls, 1)

        minter.result = .success("relay-token")
        clock.advance(1.5)
        let token = try await provider.token()
        XCTAssertEqual(token, "relay-token")
        XCTAssertEqual(minter.calls, 2)
    }

    func testRetryAfterParsesDeltaSecondsAndHTTPDates() {
        XCTAssertEqual(T3ConnectRetryAfter.seconds(from: "120"), 120)
        XCTAssertEqual(T3ConnectRetryAfter.seconds(from: "  7 "), 7)
        XCTAssertNil(T3ConnectRetryAfter.seconds(from: "0"))
        XCTAssertNil(T3ConnectRetryAfter.seconds(from: "-5"))
        XCTAssertNil(T3ConnectRetryAfter.seconds(from: nil))
        XCTAssertNil(T3ConnectRetryAfter.seconds(from: ""))
        XCTAssertNil(T3ConnectRetryAfter.seconds(from: "soon"))

        let now = Date(timeIntervalSince1970: 1_445_412_420) // 2015-10-21T07:27:00Z
        XCTAssertEqual(
            T3ConnectRetryAfter.seconds(from: "Wed, 21 Oct 2015 07:28:00 GMT", now: now),
            60
        )
        // An elapsed date is not a licence to retry immediately; the caller
        // falls back to the exponential window instead.
        XCTAssertNil(
            T3ConnectRetryAfter.seconds(from: "Wed, 21 Oct 2015 07:26:00 GMT", now: now)
        )
    }

    func testAdvertisedDelayIsClampedToTheCeiling() {
        let policy = T3ConnectRateLimitPolicy(maximumDelay: 30)
        XCTAssertEqual(policy.delay(attempt: 1, retryAfter: 600), 30)
        XCTAssertEqual(policy.delay(attempt: 1, retryAfter: 12), 12)
    }

    // MARK: - In-flight bookkeeping

    func testInFlightMintIsClearedOnSuccessAndOnFailure() async throws {
        let minter = RecordingMinter()
        let provider = provider(minter: minter, clock: TestClock(Self.fixedNow))

        let first = try await provider.token()
        XCTAssertEqual(first, "relay-token")
        let second = try await provider.token()
        XCTAssertEqual(second, "relay-token")
        XCTAssertEqual(minter.calls, 2, "A completed mint must not wedge the provider.")

        minter.result = .failure(T3ConnectAuthError.noSession)
        do {
            _ = try await provider.token()
            XCTFail("A failing mint must surface its error.")
        } catch let error as T3ConnectAuthError {
            XCTAssertEqual(error, .noSession)
        }
        XCTAssertNil(
            provider.rateLimitRemaining,
            "Only a rate-limited rejection may arm the backoff."
        )

        minter.result = .success("fresh-token")
        let third = try await provider.token()
        XCTAssertEqual(third, "fresh-token")
        XCTAssertEqual(minter.calls, 4)
    }

    func testResetClearsTheBackoffWindow() async throws {
        let clock = TestClock(Self.fixedNow)
        let minter = RecordingMinter()
        minter.result = .failure(T3ConnectRateLimitedError(retryAfter: 120))
        let provider = provider(minter: minter, clock: clock)

        await assertRateLimited(retryAfter: 120) { try await provider.token() }
        provider.reset()
        XCTAssertNil(provider.rateLimitRemaining)

        minter.result = .success("relay-token")
        let token = try await provider.token()
        XCTAssertEqual(token, "relay-token")
    }

    // MARK: - Surfacing

    func testRateLimitedErrorReadsAsRetryingRatherThanSignInFailed() {
        let error = T3ConnectAuthError.rateLimited(retryAfter: 45)
        XCTAssertEqual(error.retryAfter, 45)
        XCTAssertEqual(error.errorDescription, "T3 Connect is rate limited. Retrying in 45s.")
        XCTAssertEqual(
            T3ConnectAuthError.rateLimited(retryAfter: 130).errorDescription,
            "T3 Connect is rate limited. Retrying in 3m."
        )
        XCTAssertNil(T3ConnectAuthError.noSession.retryAfter)
    }

    func testClerkRateLimitClassifierMatchesCodesAndMessages() {
        XCTAssertTrue(
            T3ConnectClerkRateLimit.isRateLimited(code: "too_many_requests", message: nil)
        )
        XCTAssertTrue(
            T3ConnectClerkRateLimit.isRateLimited(code: "rate_limit_exceeded", message: nil)
        )
        XCTAssertTrue(
            T3ConnectClerkRateLimit.isRateLimited(
                code: "unknown_error",
                message: "Too many requests. Please try again later."
            )
        )
        XCTAssertFalse(
            T3ConnectClerkRateLimit.isRateLimited(code: "session_not_found", message: "No session")
        )
    }

    // MARK: - Helpers

    private func provider(
        minter: RecordingMinter,
        clock: TestClock,
        policy: T3ConnectRateLimitPolicy = T3ConnectRateLimitPolicy(
            initialDelay: 2,
            multiplier: 2,
            maximumDelay: 300,
            jitterRange: 1 ... 1
        )
    ) -> T3ConnectRelayTokenProvider {
        T3ConnectRelayTokenProvider(
            policy: policy,
            now: { clock.now },
            jitter: { $0.lowerBound }
        ) {
            try await minter.mint()
        }
    }

    private func assertRateLimited(
        retryAfter expected: TimeInterval,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: () async throws -> String
    ) async {
        do {
            let token = try await body()
            XCTFail("Expected a rate-limited failure, got \(token).", file: file, line: line)
        } catch let error as T3ConnectAuthError {
            XCTAssertEqual(error.retryAfter, expected, file: file, line: line)
        } catch {
            XCTFail("Expected a rate-limited failure, got \(error).", file: file, line: line)
        }
    }

    /// Lets already-enqueued main-actor callers reach their suspension point.
    private func settle(_ turns: Int = 8) async {
        for _ in 0 ..< turns { await Task.yield() }
    }
}

@MainActor
private final class RecordingMinter {
    private(set) var calls = 0
    var result: Result<String, Error> = .success("relay-token")

    private var isHeld = false
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private var startedContinuation: CheckedContinuation<Void, Never>?
    private var startedBeforeWait = false

    func hold() { isHeld = true }

    func releaseMint() {
        isHeld = false
        releaseContinuation?.resume()
        releaseContinuation = nil
    }

    func waitUntilMintStarted() async {
        if startedBeforeWait {
            startedBeforeWait = false
            return
        }
        await withCheckedContinuation { startedContinuation = $0 }
    }

    func mint() async throws -> String {
        calls += 1
        if let startedContinuation {
            self.startedContinuation = nil
            startedContinuation.resume()
        } else {
            startedBeforeWait = true
        }
        if isHeld {
            await withCheckedContinuation { releaseContinuation = $0 }
        }
        return try result.get()
    }
}

/// The provider reads its clock from a non-isolated closure, so the test clock
/// has to be safe to read off the main actor.
private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date

    init(_ value: Date) {
        self.value = value
    }

    var now: Date {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func advance(_ seconds: TimeInterval) {
        lock.lock()
        value = value.addingTimeInterval(seconds)
        lock.unlock()
    }
}
