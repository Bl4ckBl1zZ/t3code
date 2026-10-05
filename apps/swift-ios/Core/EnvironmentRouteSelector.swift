import Foundation

/// Picks the route one client talks to its environment over.
///
/// Connecting walks the saved routes in preference order. With more than one
/// route, every direct address is checked at once through the public
/// descriptor (no credential is sent), but each route only waits for its own
/// check, so a reachable LAN address connects without waiting on a silent
/// tailnet one. A route that answers as another environment is never sent a
/// credential. A silent route is skipped on the first pass, so a LAN address
/// from another network costs one short check rather than a connection
/// timeout; it is tried after the others, once it confirms it is this
/// environment. T3 Connect has no cheap check and is tried in its place.
///
/// While connected over a fallback route, `checkForBetterRoute()` preflights
/// the routes ranked above it (descriptor plus an authenticated session read)
/// and prefers the best that passes for the next connection. A route that
/// passed but then failed to connect is not preferred again for five minutes,
/// so a flaky LAN cannot bounce the connection.
///
/// An environment with one route connects exactly as before routes existed:
/// no checks, no preflight.
public final class EnvironmentRouteSelector: @unchecked Sendable {
    /// Reads the public descriptor at a base URL within a deadline and returns
    /// the environment id that answered, or nil when nothing answered.
    public typealias Probe = @Sendable (URL, TimeInterval) async -> String?
    /// Whether this route's credential is accepted, without opening a socket.
    public typealias Preflight = @Sendable (Environment) async -> Bool

    static let checkTimeout: TimeInterval = 2.5
    static let confirmTimeout: TimeInterval = 8
    static let betterRouteInterval: Duration = .seconds(60)
    static let betterRouteCooldown: Duration = .seconds(300)

    enum RouteCheck: Equatable {
        case answered
        case silent
        case otherEnvironment
        case unchecked
    }

    private let lock = NSLock()
    private var environment: Environment
    private var currentID: String
    private var preferredID: String?
    private var cooldownUntil: [String: ContinuousClock.Instant] = [:]
    private let probe: Probe
    private let preflight: Preflight
    private let clock = ContinuousClock()

    public init(
        environment: Environment,
        probe: @escaping Probe,
        preflight: @escaping Preflight
    ) {
        self.environment = environment
        currentID = environment.routes[0].id
        self.probe = probe
        self.preflight = preflight
    }

    /// The environment routed through the route in use, for requests that
    /// follow the connection.
    public func current() -> Environment {
        locked {
            let route = environment.routes.first { $0.id == currentID } ?? environment.routes[0]
            return environment.routed(through: route)
        }
    }

    public func currentRouteID() -> String {
        locked { currentID }
    }

    /// The saved routes, preferred first.
    public func routes() -> [EnvironmentRoute] {
        locked { environment.routes }
    }

    /// Takes a new route list without dropping the connection. Returns true
    /// when the connection should be replaced so the new order takes effect:
    /// the route in use is gone, or a user edit put another route first.
    @discardableResult
    public func adopt(_ routes: [EnvironmentRoute], preferFirst: Bool) -> Bool {
        guard !routes.isEmpty else { return false }
        return locked {
            environment.routes = routes
            let currentGone = !routes.contains { $0.id == currentID }
            if currentGone {
                currentID = routes[0].id
            }
            guard preferFirst || currentGone, routes[0].id != currentID || currentGone else {
                return false
            }
            preferredID = routes[0].id
            return true
        }
    }

    /// Runs `operation` over the first route that accepts it, as described on
    /// the type. Every failure moves on to the next route, so a signed-out
    /// T3 Connect cannot hide a working LAN; the most preferred route's error
    /// is reported when none works.
    public func connect<T>(_ operation: (Environment) async throws -> T) async throws -> T {
        let (environment, ordered, preferred) = takeAttemptOrder()
        guard ordered.count > 1 else {
            let result = try await operation(environment.routed(through: ordered[0]))
            didConnect(over: ordered[0], preferred: preferred)
            return result
        }

        let expectedID = environment.id
        let probe = self.probe
        let checkTimeout = Self.checkTimeout
        var checks: [String: Task<RouteCheck, Never>] = [:]
        for route in ordered where !route.isRelay {
            let url = route.httpBaseURL
            checks[route.id] = Task { () -> RouteCheck in
                guard let answered = await probe(url, checkTimeout) else { return .silent }
                return answered == expectedID ? .answered : .otherEnvironment
            }
        }
        defer { checks.values.forEach { $0.cancel() } }

        var firstError: (any Error)?
        var silent: [EnvironmentRoute] = []
        for route in ordered {
            try Task.checkCancellation()
            let check = await checks[route.id]?.value ?? .unchecked
            switch check {
            case .otherEnvironment:
                continue
            case .silent:
                silent.append(route)
                continue
            case .answered, .unchecked:
                break
            }
            do {
                let result = try await operation(environment.routed(through: route))
                didConnect(over: route, preferred: preferred)
                return result
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                firstError = firstError ?? error
            }
        }
        for route in silent {
            try Task.checkCancellation()
            // A check is not proof: confirm this address serves this
            // environment before sending it a credential.
            guard await probe(route.httpBaseURL, Self.confirmTimeout) == expectedID else { continue }
            do {
                let result = try await operation(environment.routed(through: route))
                didConnect(over: route, preferred: preferred)
                return result
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                firstError = firstError ?? error
            }
        }
        if let preferred { coolDown(preferred) }
        throw firstError ?? EnvironmentRouteError.unreachable(environment.label)
    }

    /// Runs a request over the route in use. When the route itself fails (no
    /// network path, or T3 Connect reporting the machine unreachable) and
    /// there are other routes, the request is retried once over the routes in
    /// order. Use only for requests that are safe to repeat.
    public func perform<T>(_ operation: (Environment) async throws -> T) async throws -> T {
        let routed = current()
        let routeCount = locked { environment.routes.count }
        do {
            return try await operation(routed)
        } catch {
            guard routeCount > 1, Self.isRouteFailure(error) else { throw error }
            return try await connect(operation)
        }
    }

    /// Preflights the routes ranked above the one in use and prefers the best
    /// that would connect. Returns true when one did, so the caller replaces
    /// its connection. T3 Connect never passes: it is a fallback, not a
    /// destination.
    public func checkForBetterRoute() async -> Bool {
        let (environment, candidates) = betterRouteCandidates(now: clock.now)
        for route in candidates {
            guard await probe(route.httpBaseURL, Self.checkTimeout) == environment.id else {
                continue
            }
            guard await preflight(environment.routed(through: route)) else { continue }
            return prefer(route.id)
        }
        return false
    }

    /// Direct routes ranked above the one in use that are not cooling down.
    private func betterRouteCandidates(
        now: ContinuousClock.Instant
    ) -> (Environment, [EnvironmentRoute]) {
        locked {
            guard let index = environment.routes.firstIndex(where: { $0.id == currentID }),
                  index > 0 else {
                return (environment, [])
            }
            let candidates = environment.routes[..<index].filter { route in
                guard !route.isRelay else { return false }
                guard let until = cooldownUntil[route.id] else { return true }
                return until <= now
            }
            return (environment, Array(candidates))
        }
    }

    /// Whether an error means the route, not the request, failed.
    static func isRouteFailure(_ error: any Error) -> Bool {
        if error is CancellationError { return false }
        if let urlError = error as? URLError {
            return urlError.code != .cancelled
        }
        if case let .status(status, _, _)? = error as? HTTPError {
            return [502, 503, 504].contains(status)
        }
        return false
    }

    /// The routes for one attempt: a preferred route (set by a better-route
    /// check or a user edit) first, the rest in saved order. The preference is
    /// used once.
    private func takeAttemptOrder() -> (Environment, [EnvironmentRoute], String?) {
        locked {
            let pending = preferredID
            preferredID = nil
            var routeOrder = environment.routes
            if let pending, let index = routeOrder.firstIndex(where: { $0.id == pending }) {
                routeOrder.insert(routeOrder.remove(at: index), at: 0)
            }
            return (environment, routeOrder, pending)
        }
    }

    private func didConnect(over route: EnvironmentRoute, preferred: String?) {
        let now = clock.now
        locked {
            currentID = route.id
            if let preferred, preferred != route.id {
                cooldownUntil[preferred] = now.advanced(by: Self.betterRouteCooldown)
            }
        }
    }

    /// Prefers a route for the next attempt unless it is already in use.
    private func prefer(_ routeID: String) -> Bool {
        locked {
            guard currentID != routeID else { return false }
            preferredID = routeID
            return true
        }
    }

    private func coolDown(_ routeID: String) {
        let now = clock.now
        locked { cooldownUntil[routeID] = now.advanced(by: Self.betterRouteCooldown) }
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}

public enum EnvironmentRouteError: LocalizedError, Equatable, Sendable {
    case unreachable(String)

    public var errorDescription: String? {
        switch self {
        case let .unreachable(label):
            "\(label) did not answer on any saved route."
        }
    }
}
