import ActivityKit
import CryptoKit
import Foundation
import Security
import UIKit

enum PlatformInstallationIdentity {
    private static let service = "com.t3tools.t3code.swiftui.installation"
    private static let account = "device-id"
    private static let fallbackKey = "swift-ios.installation-id.v1"

    static func value() -> String {
        if let stored = readKeychainValue() { return stored }
        let created = UUID().uuidString.lowercased()
        let insertion: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(created.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(insertion as CFDictionary, nil)
        if status == errSecSuccess { return created }
        if status == errSecDuplicateItem, let winner = readKeychainValue() { return winner }
        return value(defaults: .standard)
    }

    /// Injectable fallback used only when Keychain is unavailable and by tests.
    static func value(defaults: UserDefaults) -> String {
        if let existing = defaults.string(forKey: fallbackKey), !existing.isEmpty {
            return existing
        }
        let created = UUID().uuidString.lowercased()
        defaults.set(created, forKey: fallbackKey)
        return created
    }

    private static func readKeychainValue() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8),
              UUID(uuidString: value) != nil else {
            return nil
        }
        return value.lowercased()
    }
}

enum PlatformCloudDeliveryRegistrationFactory {
    static func registration(
        deviceID: String,
        deviceName: String,
        systemVersion: OperatingSystemVersion,
        appVersion: String?,
        bundleID: String?,
        pushToken: String?,
        pushToStartToken: String?,
        settings: FeatureSettings,
        apsEnvironment: T3ConnectDeviceRegistration.APNSEnvironment
    ) -> T3ConnectDeviceRegistration {
        T3ConnectDeviceRegistration(
            deviceID: deviceID,
            label: deviceName,
            iosMajorVersion: systemVersion.majorVersion,
            appVersion: appVersion,
            bundleID: bundleID,
            apsEnvironment: apsEnvironment,
            pushToken: pushToken,
            pushToStartToken: pushToStartToken,
            preferences: T3ConnectDevicePreferences(
                liveActivitiesEnabled: settings.liveActivitiesEnabled,
                notificationsEnabled: settings.notificationsEnabled
            )
        )
    }
}

/// Picks the single Live Activity whose push-token updates this device observes.
///
/// The relay tracks exactly one card per device, so one managed subscription
/// suffices. `Activity<Attributes>.activities` hands back a *fresh* value-type
/// wrapper on every call, which makes per-instance dedupe (a `WeakSet`, an
/// `ObjectIdentifier` set) worse than useless: it re-attaches a listener on
/// every poll and never recognizes an already-observed activity. Key off the
/// stable activity id and replace the previous subscription instead.
///
/// Ported from `remoteRegistration.ts`'s `activityPushTokenSubscription`.
enum PlatformActivityTokenSubscription {
    struct Plan: Equatable, Sendable {
        /// The one activity to observe, or nil when there is no card.
        var observe: String?
        /// True when the listener has to be torn down and re-attached because
        /// the primary card changed (or disappeared).
        var replacesSubscription: Bool
        /// Cards beyond the primary. The relay can only address one, so these
        /// are ended rather than observed.
        var redundant: [String]
    }

    static func plan(activityIDs: [String], observing current: String?) -> Plan {
        let primary = activityIDs.first
        return Plan(
            observe: primary,
            replacesSubscription: primary != current,
            redundant: Array(activityIDs.dropFirst())
        )
    }
}

/// Activity push tokens the relay recently accepted, by acceptance time.
///
/// Registration runs on sign-in, every foreground, and every connection update,
/// which arrive in bursts and spammed identical requests. But it is not a pure
/// no-op: the relay replays the current aggregate to this device on every
/// accepted registration, and that replay repairs drifted or orphaned
/// activities. So dedupe only within a short window — bursts collapse to one
/// request, while a foreground after real time away still triggers a replay.
enum PlatformActivityTokenRegistry {
    static let reregisterInterval: TimeInterval = 60
    static let maximumEntries = 8

    /// Drops expired entries and bounds what is left to the newest few, so the
    /// persisted registry cannot grow without limit across token rotations.
    static func pruned(
        _ entries: [String: TimeInterval],
        now: TimeInterval
    ) -> [String: TimeInterval] {
        let live = entries.filter { now - $0.value < reregisterInterval }
        guard live.count > maximumEntries else { return live }
        return Dictionary(
            uniqueKeysWithValues: live
                .sorted { $0.value > $1.value }
                .prefix(maximumEntries)
                .map { ($0.key, $0.value) }
        )
    }

    /// True when this fingerprint was accepted recently enough that re-sending
    /// it would only cost a round trip.
    static func isFresh(
        _ entries: [String: TimeInterval],
        fingerprint: String,
        now: TimeInterval
    ) -> Bool {
        guard let acceptedAt = entries[fingerprint] else { return false }
        return now - acceptedAt < reregisterInterval
    }

    static func recording(
        _ entries: [String: TimeInterval],
        fingerprint: String,
        now: TimeInterval
    ) -> [String: TimeInterval] {
        var next = pruned(entries, now: now)
        next[fingerprint] = now
        return pruned(next, now: now)
    }
}

/// Keeps the relay's device record aligned with this installation. Token values
/// only travel over DPoP-authenticated relay requests; local success caches store
/// SHA-256 fingerprints rather than reusable push credentials.
@MainActor
final class PlatformCloudDeliveryCoordinator {
    static let shared = PlatformCloudDeliveryCoordinator()

    private let defaults: UserDefaults
    private let tokenSink: PlatformPersistedDeviceTokenSink
    private let deviceID: String

    private weak var controller: T3ConnectController?
    private var settings: FeatureSettings?
    private var needsRegistration = false
    private var registrationTask: Task<Void, Never>?
    private var observerTasks: [Task<Void, Never>] = []
    private var pushToStartTask: Task<Void, Never>?
    private var activityUpdatesTask: Task<Void, Never>?
    /// Exactly one managed token subscription, plus the id it belongs to.
    private var activityTokenTask: Task<Void, Never>?
    private var observedActivityID: String?
    private var pendingActivityTokens: Set<String> = []
    private var retryTask: Task<Void, Never>?

    private let deviceFingerprintKey = "swift-ios.cloud-delivery-device.v1"
    private let deviceRegisteredAtKey = "swift-ios.cloud-delivery-device-date.v1"
    private let activityFingerprintKey = "swift-ios.cloud-delivery-activities.v1"
    private let healingInterval: TimeInterval = 60

    init(
        defaults: UserDefaults = .standard,
        tokenSink: PlatformPersistedDeviceTokenSink? = nil,
        deviceID: String? = nil
    ) {
        self.defaults = defaults
        self.tokenSink = tokenSink ?? .shared
        self.deviceID = deviceID ?? PlatformInstallationIdentity.value()
    }

    deinit {
        registrationTask?.cancel()
        pushToStartTask?.cancel()
        activityUpdatesTask?.cancel()
        retryTask?.cancel()
        observerTasks.forEach { $0.cancel() }
        activityTokenTask?.cancel()
    }

    func install(controller: T3ConnectController) {
        self.controller = controller
        guard observerTasks.isEmpty else {
            requestRegistration()
            return
        }

        for name in [Notification.Name.platformDeviceTokenChanged, .platformLiveActivityChanged] {
            observerTasks.append(Task { @MainActor [weak self] in
                for await _ in NotificationCenter.default.notifications(named: name) {
                    guard !Task.isCancelled else { return }
                    self?.refreshActivityTokenObservers()
                    self?.requestRegistration()
                }
            })
        }
        // Foregrounding is the full local reconciliation: the card is repainted
        // from the aggregate the app already holds, and the activity token is
        // re-registered so the relay replays the authoritative state to this
        // device. Both repair drift that accumulated while pushes could not be
        // delivered, without waiting for the next snapshot revision.
        observerTasks.append(Task { @MainActor [weak self] in
            for await _ in NotificationCenter.default.notifications(
                named: UIApplication.didBecomeActiveNotification
            ) {
                guard !Task.isCancelled, let self else { return }
                PlatformAgentAwarenessCoordinator.shared.repaintLiveActivity()
                refreshActivityTokenObservers()
                requestRegistration()
            }
        })
        observerTasks.append(Task { @MainActor [weak self] in
            for await _ in NotificationCenter.default.notifications(named: .t3ConnectSessionChanged) {
                guard !Task.isCancelled, let self else { return }
                if controller.account == nil {
                    clearSuccessfulRegistrationCache()
                    pendingActivityTokens.removeAll()
                    PlatformAgentAwarenessCoordinator.shared
                        .resetAndResynchronizeLiveActivity()
                }
                refreshActivityTokenObservers()
                requestRegistration()
            }
        })

        if #available(iOS 17.2, *) {
            pushToStartTask = Task { @MainActor [weak self] in
                for await _ in Activity<LiveActivityAttributes>.pushToStartTokenUpdates {
                    guard !Task.isCancelled else { return }
                    self?.requestRegistration()
                }
            }
        }
        activityUpdatesTask = Task { @MainActor [weak self] in
            for await activity in Activity<LiveActivityAttributes>.activityUpdates {
                guard !Task.isCancelled, let self else { return }
                if let token = activity.pushToken?.hexadecimalString {
                    pendingActivityTokens.insert(token)
                }
                refreshActivityTokenObservers()
                requestRegistration()
            }
        }
        refreshActivityTokenObservers()
        requestRegistration()
    }

    func synchronize(settings: FeatureSettings) {
        self.settings = settings
        refreshActivityTokenObservers()
        requestRegistration()
    }

    private func refreshActivityTokenObservers() {
        let activities = Activity<LiveActivityAttributes>.activities
        let plan = PlatformActivityTokenSubscription.plan(
            activityIDs: activities.map(\.id),
            observing: observedActivityID
        )

        // A token already minted for any live card is still worth registering,
        // even for a card we are about to drop the subscription for.
        for activity in activities {
            if let token = activity.pushToken?.hexadecimalString {
                pendingActivityTokens.insert(token)
            }
        }

        guard plan.replacesSubscription else { return }
        activityTokenTask?.cancel()
        activityTokenTask = nil
        observedActivityID = plan.observe
        guard let primary = activities.first else { return }
        activityTokenTask = Task { @MainActor [weak self] in
            for await token in primary.pushTokenUpdates {
                guard !Task.isCancelled else { return }
                self?.pendingActivityTokens.insert(token.hexadecimalString)
                self?.requestRegistration()
            }
        }
    }

    /// End of an active rate-limit window, if one is open. A pending retry
    /// inside this window must survive `requestRegistration()`, or the
    /// notification traffic that drives registration would cancel the backoff
    /// and reopen the storm it exists to stop.
    private var rateLimitedUntil: Date?

    private func requestRegistration() {
        if let rateLimitedUntil, rateLimitedUntil > Date() {
            needsRegistration = true
            return
        }
        rateLimitedUntil = nil
        retryTask?.cancel()
        retryTask = nil
        needsRegistration = true
        guard registrationTask == nil else { return }
        registrationTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while needsRegistration, !Task.isCancelled {
                needsRegistration = false
                await registerCurrentState()
                await Task.yield()
            }
            registrationTask = nil
            if needsRegistration { requestRegistration() }
        }
    }

    private func registerCurrentState() async {
        guard let controller, let settings else { return }
        let registration = currentRegistration(settings: settings)
        guard registration.iosMajorVersion >= 18 else { return }
        controller.rememberRegisteredDevice(id: deviceID)

        let accountBeforeRequest = controller.account?.id
        let fingerprint = Self.fingerprint(
            registration,
            accountID: accountBeforeRequest
        )
        let canReuseRegistration = accountBeforeRequest != nil
            && defaults.string(forKey: deviceFingerprintKey) == fingerprint
            && Date.now.timeIntervalSince(
                defaults.object(forKey: deviceRegisteredAtKey) as? Date ?? .distantPast
            ) < healingInterval

        do {
            if !canReuseRegistration {
                try await controller.registerDevice(registration)
                guard accountBeforeRequest == nil
                    || controller.account?.id == accountBeforeRequest else {
                    needsRegistration = true
                    return
                }
                defaults.set(
                    Self.fingerprint(registration, accountID: controller.account?.id),
                    forKey: deviceFingerprintKey
                )
                defaults.set(Date.now, forKey: deviceRegisteredAtKey)
            }

            guard let accountID = controller.account?.id else { return }
            let now = Date.now.timeIntervalSince1970
            // Expired acceptances are pruned on every pass, so a device that
            // rotates activity tokens for weeks never accumulates a registry it
            // has to scan — and an entry that ages out lets the next foreground
            // re-register, which is what makes the relay replay the aggregate.
            var completed = PlatformActivityTokenRegistry.pruned(
                (defaults.dictionary(forKey: activityFingerprintKey) ?? [:])
                    .compactMapValues { ($0 as? NSNumber)?.doubleValue },
                now: now
            )
            for token in Array(pendingActivityTokens) {
                let tokenFingerprint = Self.fingerprint(
                    "\(deviceID)|\(token)",
                    accountID: accountID
                )
                guard !PlatformActivityTokenRegistry.isFresh(
                    completed,
                    fingerprint: tokenFingerprint,
                    now: now
                ) else {
                    pendingActivityTokens.remove(token)
                    continue
                }
                try await controller.registerLiveActivity(
                    T3ConnectLiveActivityRegistration(
                        deviceID: deviceID,
                        activityPushToken: token
                    )
                )
                guard controller.account?.id == accountID else {
                    needsRegistration = true
                    return
                }
                completed = PlatformActivityTokenRegistry.recording(
                    completed,
                    fingerprint: tokenFingerprint,
                    now: now
                )
                pendingActivityTokens.remove(token)
            }
            defaults.set(completed, forKey: activityFingerprintKey)
            scheduleRetry(after: healingInterval)
        } catch is CancellationError {
            return
        } catch let error as T3ConnectAuthError {
            // A rate-limit window is the one auth failure worth retrying on a
            // timer: it clears on its own. Every other auth failure waits for an
            // account, network, foreground, or token event.
            if let retryAfter = error.retryAfter {
                rateLimitedUntil = Date().addingTimeInterval(retryAfter)
                scheduleRetry(after: retryAfter + 1)
            }
            return
        } catch let error as T3ConnectRelayError {
            guard case .invalidConfiguration = error else {
                scheduleRetry(after: 15)
                return
            }
        } catch {
            // Signed-out and offline states are expected. The next account,
            // network, foreground, or token event retries without noisy UI.
            scheduleRetry(after: 15)
            return
        }
    }

    private func scheduleRetry(after delay: TimeInterval) {
        retryTask?.cancel()
        retryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            retryTask = nil
            refreshActivityTokenObservers()
            requestRegistration()
        }
    }

    private func clearSuccessfulRegistrationCache() {
        defaults.removeObject(forKey: deviceFingerprintKey)
        defaults.removeObject(forKey: deviceRegisteredAtKey)
        defaults.removeObject(forKey: activityFingerprintKey)
    }

    private func currentRegistration(settings: FeatureSettings) -> T3ConnectDeviceRegistration {
        let version = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String
        let pushToStartToken: String? = if #available(iOS 17.2, *) {
            Activity<LiveActivityAttributes>.pushToStartToken?.hexadecimalString
        } else {
            nil
        }
        var effectiveSettings = settings
        effectiveSettings.notificationsEnabled = settings.notificationsEnabled
            && PlatformNotificationService.shared.enabled
            && tokenSink.currentToken != nil
        effectiveSettings.liveActivitiesEnabled = settings.liveActivitiesEnabled
            && ActivityAuthorizationInfo().areActivitiesEnabled
        return PlatformCloudDeliveryRegistrationFactory.registration(
            deviceID: deviceID,
            deviceName: UIDevice.current.name,
            systemVersion: ProcessInfo.processInfo.operatingSystemVersion,
            appVersion: version,
            bundleID: Bundle.main.bundleIdentifier,
            pushToken: tokenSink.currentToken,
            pushToStartToken: pushToStartToken,
            settings: effectiveSettings,
            apsEnvironment: Self.apsEnvironment
        )
    }

    private static var apsEnvironment: T3ConnectDeviceRegistration.APNSEnvironment {
        #if DEBUG
            .sandbox
        #else
            .production
        #endif
    }

    private static func fingerprint<Value: Encodable>(
        _ value: Value,
        accountID: String?
    ) -> String {
        let data = (try? JSONEncoder.t3.encode(value)) ?? Data()
        return fingerprint(Data((accountID ?? "unloaded").utf8) + data)
    }

    private static func fingerprint(_ value: String, accountID: String?) -> String {
        fingerprint(Data("\(accountID ?? "unloaded")|\(value)".utf8))
    }

    private static func fingerprint(_ data: Data) -> String {
        Data(SHA256.hash(data: data)).hexadecimalString
    }
}

private extension Data {
    var hexadecimalString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
