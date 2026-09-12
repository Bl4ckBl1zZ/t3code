import Foundation

public struct NativeProviderAuthState: Codable, Equatable, Sendable {
    public let instanceId: String
    public let phase: String
    public let flowId: String?
    public let authorizationUrl: String?
    public let expiresAt: String?
    public let message: String?
    public var isActive: Bool { ["starting", "waiting", "verifying"].contains(phase) }
    public var signInURL: URL? {
        guard phase == "waiting", let authorizationUrl, let url = URL(string: authorizationUrl),
              url.scheme == "https", url.host == "accounts.google.com" else { return nil }
        return url
    }
}

public struct NativeProviderInstallState: Codable, Equatable, Sendable {
    public let driver: String
    public let operationId: String?
    public let phase: String
    public let downloadedBytes: Double
    public let totalBytes: Double?
    public let version: String?
    public let installedVersion: String?
    public let canRemove: Bool
    public let message: String?
    public var isActive: Bool { ["downloading", "extracting", "verifying"].contains(phase) }
}

public struct NativeProviderSetupCapabilities: Codable, Equatable, Sendable {
    public let canAuthenticate: Bool
    public let canInstall: Bool
}

public enum NativeProviderSetupAction: Sendable {
    case startAuth, logout, startInstall, removeInstall
    case completeAuth(flowID: String, callbackURL: String)
    case cancelAuth(flowID: String)
    case cancelInstall(operationID: String)

    public var method: String {
        switch self {
        case .startAuth: "provider.auth.start"
        case .completeAuth: "provider.auth.complete"
        case .cancelAuth: "provider.auth.cancel"
        case .logout: "provider.auth.logout"
        case .startInstall: "provider.install.start"
        case .cancelInstall: "provider.install.cancel"
        case .removeInstall: "provider.install.remove"
        }
    }
    public func payload(instanceID: String) -> JSONValue {
        var value: [String: JSONValue] = ["instanceId": .string(instanceID)]
        switch self {
        case let .completeAuth(flowID, callbackURL): value["flowId"] = .string(flowID); value["callbackUrl"] = .string(callbackURL)
        case let .cancelAuth(flowID): value["flowId"] = .string(flowID)
        case let .cancelInstall(operationID): value["operationId"] = .string(operationID)
        default: break
        }
        return .object(value)
    }
}
