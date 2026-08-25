import Foundation

/// Who is on the other end of a `/ws` upgrade.
///
/// The server reads these off the upgrade URL next to `wsTicket` and records
/// them on the auth session and the `client.connected` analytics event. Without
/// them every SwiftUI session is an unlabeled row in Settings -> Connections and
/// an anonymous data point in analytics, which is what made connection churn
/// impossible to attribute to a device.
///
/// Everything here is best-effort by design: the server ignores absent or
/// malformed values rather than refusing the connection, so a missing field
/// costs attribution and nothing else.
public struct ClientConnectionIdentity: Equatable, Sendable {
    /// Matches the server's `ClientSurface`. The SwiftUI client is a phone/tablet
    /// client, so it reports the same surface the Expo client does.
    public static let surface = "mobile"

    /// The server only accepts "iOS" or "Android" here.
    public static let operatingSystem = "iOS"

    public let appVersion: String?
    public let osMajorVersion: Int?
    public let deviceModel: String?

    public init(appVersion: String?, osMajorVersion: Int?, deviceModel: String?) {
        self.appVersion = appVersion
        self.osMajorVersion = osMajorVersion
        self.deviceModel = deviceModel
    }

    public static let current = ClientConnectionIdentity(
        appVersion: bundleShortVersion(),
        osMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
        deviceModel: hardwareModelIdentifier()
    )

    /// Query items to merge into a `/ws` upgrade URL. Named to match the
    /// server's `readClientConnectionOrigin` / `readMobileDeviceAnalyticsProps`.
    public var queryItems: [URLQueryItem] {
        var items = [URLQueryItem(name: "clientSurface", value: Self.surface)]
        if let appVersion, !appVersion.isEmpty {
            items.append(URLQueryItem(name: "clientAppVersion", value: appVersion))
        }
        items.append(URLQueryItem(name: "clientOs", value: Self.operatingSystem))
        if let osMajorVersion, osMajorVersion > 0 {
            items.append(
                URLQueryItem(name: "clientOsMajorVersion", value: String(osMajorVersion))
            )
        }
        if let deviceModel, !deviceModel.isEmpty {
            items.append(URLQueryItem(name: "clientDeviceModel", value: deviceModel))
        }
        return items
    }

    /// Every parameter this type owns, for callers that rebuild a URL and have
    /// to clear stale values first.
    public static let queryItemNames: Set<String> = [
        "clientSurface",
        "clientAppVersion",
        "clientOs",
        "clientOsMajorVersion",
        "clientDeviceModel",
    ]

    private static func bundleShortVersion() -> String? {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
        guard let version = version as? String else { return nil }
        let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
        // The server drops anything longer than 64 characters, so a malformed
        // Info.plist costs the version rather than the whole identity.
        return trimmed.isEmpty || trimmed.count > 64 ? nil : trimmed
    }

    /// The raw hardware identifier ("iPhone17,2"), not a marketing name.
    ///
    /// The Expo client reports `expo-device`'s marketing string ("iPhone 15
    /// Pro"), which needs a lookup table that goes stale with every release.
    /// Identifiers are unambiguous and need no maintenance, and `apps/mobile` is
    /// being retired, so the mixed-vocabulary window in analytics is temporary.
    private static func hardwareModelIdentifier() -> String? {
        // `hw.machine` is the host architecture on a Simulator, so every
        // simulated device would report "arm64"; the Simulator exports the
        // device it is pretending to be instead.
        let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"]
        if let simulated, !simulated.isEmpty {
            return sanitizedModel(simulated)
        }

        var size = 0
        guard sysctlbyname("hw.machine", nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.machine", &bytes, &size, nil, 0) == 0 else { return nil }
        return sanitizedModel(String(cString: bytes))
    }

    private static func sanitizedModel(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // 80 is the server's cap; over it the field is dropped entirely, so
        // send nothing rather than something the server will silently discard.
        return trimmed.isEmpty || trimmed.count > 80 ? nil : trimmed
    }
}
