import Foundation
import UIKit

public struct TokenExchangeResult: Decodable, Sendable {
    public let accessToken: String
    public let issuedTokenType: String
    public let tokenType: String
    public let expiresIn: Double
    public let scope: String

    private enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case issuedTokenType = "issued_token_type"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
        case scope
    }
}

/// How this install introduces itself when it trades a pairing code for a
/// session. The host shows the label and device type in Settings → Connections,
/// and every client shows them in its Devices list.
public struct PairingClientIdentity: Equatable, Sendable {
    /// The subset of the server's `AuthClientMetadataDeviceType` an iOS
    /// install can be.
    public enum DeviceType: String, Sendable {
        case mobile
        case tablet
    }

    public var label: String?
    public var deviceType: DeviceType

    public init(label: String?, deviceType: DeviceType = .mobile) {
        self.label = label
        self.deviceType = deviceType
    }

    /// This device: its name ("iPhone" unless the user-assigned name is
    /// available to the app) and, on iPad, the tablet type so hosts draw an iPad.
    @MainActor
    public static var current: PairingClientIdentity {
        let device = UIDevice.current
        let name = device.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return PairingClientIdentity(
            label: name.isEmpty ? device.model : name,
            deviceType: DeviceType(idiom: device.userInterfaceIdiom)
        )
    }
}

extension PairingClientIdentity.DeviceType {
    /// iPads, including iPad apps running on a Mac, pair as tablets.
    init(idiom: UIUserInterfaceIdiom) {
        self = idiom == .pad ? .tablet : .mobile
    }
}

public enum PairingRouteError: LocalizedError, Equatable, Sendable {
    case differentEnvironment(String)

    public var errorDescription: String? {
        switch self {
        case let .differentEnvironment(label):
            "That pairing link is for \(label), not this machine. Add a route with a link from the same machine."
        }
    }
}

public actor PairingService {
    private let transport: any HTTPTransport
    private let environmentStore: EnvironmentStore
    private let credentialStore: any CredentialStore

    public init(
        transport: any HTTPTransport = URLSessionHTTPTransport(),
        environmentStore: EnvironmentStore,
        credentialStore: any CredentialStore
    ) {
        self.transport = transport
        self.environmentStore = environmentStore
        self.credentialStore = credentialStore
    }

    @discardableResult
    public func pair(
        url pairingURL: String,
        label clientLabel: String? = nil,
        deviceType: PairingClientIdentity.DeviceType = .mobile,
        expectedEnvironmentID: String? = nil
    ) async throws -> Environment {
        try await pair(
            target: PairingURL.resolve(pairingURL),
            client: PairingClientIdentity(label: clientLabel, deviceType: deviceType),
            expectedEnvironmentID: expectedEnvironmentID
        )
    }

    @discardableResult
    public func pair(
        host: String,
        code: String,
        label clientLabel: String? = nil,
        deviceType: PairingClientIdentity.DeviceType = .mobile
    ) async throws -> Environment {
        try await pair(
            target: PairingURL.resolve(host: host, pairingCode: code),
            client: PairingClientIdentity(label: clientLabel, deviceType: deviceType),
            expectedEnvironmentID: nil
        )
    }

    /// Pairs one address. Pairing an environment that is already saved adds
    /// the address as a route (or refreshes the route already saved for it)
    /// instead of replacing the environment, so its other routes and their
    /// credentials keep working. `expectedEnvironmentID` is set when adding a
    /// route to a chosen environment: a link for another machine is refused
    /// before any credential is exchanged.
    private func pair(
        target: PairingTarget,
        client: PairingClientIdentity,
        expectedEnvironmentID: String?
    ) async throws -> Environment {
        let api = EnvironmentAPI(transport: transport, credentials: credentialStore)
        let descriptor = try await api.descriptor(at: target.httpBaseURL)
        if let expectedEnvironmentID, descriptor.environmentId != expectedEnvironmentID {
            throw PairingRouteError.differentEnvironment(descriptor.label)
        }
        let access = try await exchange(target: target, client: client)
        guard access.tokenType == "Bearer" else {
            throw HTTPError.status(
                400,
                message: "The environment issued an unsupported \(access.tokenType) token.",
                traceID: nil
            )
        }
        let existing = try await environmentStore.load()
            .first(where: { $0.id == descriptor.environmentId })
        let routeID = EnvironmentRoute.directID(target.httpBaseURL)
        let credentialID = Self.credentialID(
            forRoute: routeID,
            environmentID: descriptor.environmentId,
            existing: existing
        )
        let route = EnvironmentRoute(
            id: routeID,
            httpBaseURL: target.httpBaseURL,
            webSocketBaseURL: target.webSocketBaseURL,
            kind: .bearer,
            credentialID: credentialID
        )
        var environment: Environment
        if let existing {
            environment = existing
            environment.label = descriptor.label
            environment.descriptor = descriptor
            environment.routes = EnvironmentRoutes.upserting(route, into: existing.routes)
            // Pairing again is asking to use it; adding a route to a
            // switched-off environment leaves it off.
            if expectedEnvironmentID == nil { environment.isEnabled = true }
        } else {
            environment = Environment(
                id: descriptor.environmentId,
                label: descriptor.label,
                routes: [route],
                descriptor: descriptor
            )
        }
        let credential = EnvironmentCredential(
            accessToken: access.accessToken,
            expiresAt: Date().addingTimeInterval(access.expiresIn),
            scopes: access.scope.split(separator: " ").map(String.init)
        )
        // Store the secret first. A catalog record must never point at a
        // credential that failed to persist.
        // An unreadable old credential is simply replaced, as before routes.
        let previousCredential = try? await credentialStore.credential(for: credentialID)
        try await credentialStore.setCredential(credential, for: credentialID)
        do {
            try await environmentStore.upsert(environment)
            if try await environmentStore.activeEnvironmentID() == nil {
                try await environmentStore.setActiveEnvironment(id: environment.id)
            }
        } catch {
            if let previousCredential {
                try? await credentialStore.setCredential(previousCredential, for: credentialID)
            } else {
                try? await credentialStore.removeCredential(for: credentialID)
            }
            throw error
        }
        return environment
    }

    /// The Keychain account for a paired route's token. Pairing the same
    /// address again reuses its account; an environment's first route keeps
    /// the environment id, as before routes existed; every other paired
    /// route gets its own account.
    static func credentialID(
        forRoute routeID: String,
        environmentID: String,
        existing: Environment?
    ) -> String {
        guard let existing else { return environmentID }
        if let same = existing.routes.first(where: { $0.id == routeID && !$0.learned }) {
            return same.credentialID
        }
        if !existing.routes.contains(where: { $0.credentialID == environmentID }) {
            return environmentID
        }
        return "\(environmentID)#\(routeID)"
    }

    private func exchange(
        target: PairingTarget,
        client: PairingClientIdentity
    ) async throws -> TokenExchangeResult {
        var fields = [
            URLQueryItem(
                name: "grant_type",
                value: "urn:ietf:params:oauth:grant-type:token-exchange"
            ),
            URLQueryItem(name: "subject_token", value: target.credential),
            URLQueryItem(
                name: "subject_token_type",
                value: "urn:t3:params:oauth:token-type:environment-bootstrap"
            ),
            URLQueryItem(
                name: "requested_token_type",
                value: "urn:ietf:params:oauth:token-type:access_token"
            ),
            URLQueryItem(name: "client_device_type", value: client.deviceType.rawValue),
            URLQueryItem(name: "client_os", value: "iOS"),
        ]
        if let label = client.label, !label.isEmpty {
            fields.append(URLQueryItem(name: "client_label", value: label))
        }
        var form = URLComponents()
        form.queryItems = fields
        var request = URLRequest(url: endpoint(target.httpBaseURL, path: "/oauth/token"))
        request.httpMethod = "POST"
        request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        request.setValue(
            "application/x-www-form-urlencoded",
            forHTTPHeaderField: "Content-Type"
        )
        let (data, response) = try await transport.data(for: HTTPRequestPolicy.prepare(request))
        guard (200..<300).contains(response.statusCode) else {
            let body = try? JSONDecoder.t3.decode(JSONValue.self, from: data)
            throw HTTPError.status(
                response.statusCode,
                message: body?["reason"]?.stringValue ?? "Pairing failed.",
                traceID: body?["traceId"]?.stringValue
            )
        }
        return try JSONDecoder.t3.decode(TokenExchangeResult.self, from: data)
    }
}
