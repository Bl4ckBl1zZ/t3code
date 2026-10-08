import Foundation
import Network
import UIKit

/// Moments when the live connection may have died without a word: the app
/// coming back from the background, and the device switching networks.
/// Mirrors web and mobile's `ConnectionWakeup`
/// (`packages/client-runtime/src/connection/wakeups.ts`).
enum ConnectionWakeup: Equatable, Sendable {
    /// Ask the socket for a Pong; replace it only if it stays silent.
    case probe(reason: String)
    /// Replace the socket outright. After a long suspension iOS has usually
    /// killed it, and a probe would hold a dead socket until its deadline.
    case reconnect(reason: String)

    /// Mobile's `MOBILE_BACKGROUND_RECONNECT_AFTER_MS`.
    static let reconnectAfterBackground: TimeInterval = 10

    /// Mirrors `mobileApplicationActiveWakeup` in `apps/mobile`.
    static func applicationActive(backgroundedAt: Date?, activeAt: Date) -> ConnectionWakeup {
        guard let backgroundedAt,
              activeAt.timeIntervalSince(backgroundedAt) >= reconnectAfterBackground else {
            return .probe(reason: "foreground")
        }
        return .reconnect(reason: "foreground")
    }
}

/// The parts of a network path that decide whether saved routes still reach.
struct NetworkPathSummary: Equatable, Sendable {
    let isSatisfied: Bool
    let interfaces: Set<String>

    init(isSatisfied: Bool, interfaces: Set<String>) {
        self.isSatisfied = isSatisfied
        self.interfaces = interfaces
    }

    init(_ path: NWPath) {
        isSatisfied = path.status == .satisfied
        interfaces = Set(path.availableInterfaces.map(\.name))
    }

    /// A move worth checking the socket for: the network came back, or the
    /// device moved to a different one while staying online. The first report
    /// after starting describes where the device already is.
    static func isWakeup(from previous: NetworkPathSummary?, to next: NetworkPathSummary) -> Bool {
        guard let previous, next.isSatisfied else { return false }
        return !previous.isSatisfied || previous.interfaces != next.interfaces
    }
}

/// Reports ``ConnectionWakeup``s from app lifecycle notifications and network
/// path changes. Owned by the client that owns the connection; stops when
/// released.
@MainActor
final class ConnectionWakeupMonitor {
    private var observers: [NSObjectProtocol] = []
    private let pathMonitor = NWPathMonitor()
    private var backgroundedAt: Date?
    private var lastPath: NetworkPathSummary?

    init(onWakeup: @escaping @MainActor (ConnectionWakeup) -> Void) {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.backgroundedAt = .now }
        })
        observers.append(center.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let wakeup = ConnectionWakeup.applicationActive(
                    backgroundedAt: self.backgroundedAt,
                    activeAt: .now
                )
                self.backgroundedAt = nil
                onWakeup(wakeup)
            }
        })
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let summary = NetworkPathSummary(path)
            Task { @MainActor in
                guard let self else { return }
                let previous = self.lastPath
                self.lastPath = summary
                if NetworkPathSummary.isWakeup(from: previous, to: summary) {
                    onWakeup(.probe(reason: "network-changed"))
                }
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "com.t3code.connection-wakeups"))
    }

    deinit {
        pathMonitor.cancel()
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}
