import Foundation

public struct T3ConnectPreparedEnvironmentConnection: Sendable {
    public let authorization: T3ConnectEnvironmentAccessToken
    public let webSocketURL: URL

    public init(
        authorization: T3ConnectEnvironmentAccessToken,
        webSocketURL: URL
    ) {
        self.authorization = authorization
        self.webSocketURL = webSocketURL
    }
}

/// Converts the relay's short-lived environment bootstrap credential into the
/// DPoP access token and one-time WebSocket ticket understood by a T3 server.
/// The same signer must authorize every later HTTP request for that token.
///
/// The exchange names no scope, so the server grants its whole managed set.
/// That set changes as servers split scopes into permissions, and a fresh
/// exchange is how a managed connection picks the new set up.
public actor T3ConnectManagedEnvironmentAuthorizer {
    private struct AccessTokenResponse: Decodable, Sendable {
        let accessToken: String
        let issuedTokenType: String
        let tokenType: String
        let expiresIn: Double
        let scope: String

        private enum CodingKeys: String, CodingKey {
            case accessToken = "access_token"
            case issuedTokenType = "issued_token_type"
            case tokenType = "token_type"
            case expiresIn = "expires_in"
            case scope
        }
    }

    private struct WebSocketTicketResponse: Decodable, Sendable {
        let ticket: String
        let expiresAt: String
    }

    private struct ErrorBody: Decodable, Sendable {
        let message: String?
        let reason: String?
        let traceId: String?
    }

    private let transport: any HTTPTransport
    private let signer: T3ConnectDPoPSigner

    public init(
        transport: any HTTPTransport = URLSessionHTTPTransport(),
        signer: T3ConnectDPoPSigner = T3ConnectDPoPSigner()
    ) {
        self.transport = transport
        self.signer = signer
    }

    public func prepare(
        _ credential: T3ConnectManagedEnvironmentCredential,
        clientLabel: String? = nil
    ) async throws -> T3ConnectPreparedEnvironmentConnection {
        let accessToken = try await exchange(
            credential,
            clientLabel: clientLabel
        )
        let webSocketURL = try await webSocketURL(using: accessToken)
        return T3ConnectPreparedEnvironmentConnection(
            authorization: accessToken,
            webSocketURL: webSocketURL
        )
    }

    public func exchange(
        _ credential: T3ConnectManagedEnvironmentCredential,
        clientLabel: String? = nil,
        deviceType: PairingClientIdentity.DeviceType = .mobile
    ) async throws -> T3ConnectEnvironmentAccessToken {
        guard let httpBaseURL = credential.endpoint.httpBaseURL else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The managed environment HTTP URL is invalid."
            )
        }
        let thumbprint = try await signer.thumbprint()
        guard thumbprint == credential.proofKeyThumbprint else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The managed credential is bound to a different device identity."
            )
        }
        let target = endpoint(httpBaseURL, path: ["oauth", "token"])
        let proof = try await signer.proof(method: "POST", url: target)
        var fields = [
            "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
            "subject_token": credential.bootstrapCredential,
            "subject_token_type": "urn:t3:params:oauth:token-type:environment-bootstrap",
            "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
            "client_device_type": deviceType.rawValue,
            "client_os": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        if let clientLabel, !clientLabel.isEmpty {
            fields["client_label"] = clientLabel
        }
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.httpBody = Self.formEncoded(fields)
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        let response = try await send(request, as: AccessTokenResponse.self)
        let grantedScopes = response.scope.split(separator: " ").map(String.init)
        guard response.tokenType == "DPoP",
              response.issuedTokenType
                == "urn:ietf:params:oauth:token-type:access_token",
              response.accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false,
              response.expiresIn.isFinite,
              response.expiresIn > 0,
              !grantedScopes.isEmpty else {
            throw T3ConnectRelayError.invalidResponse
        }
        return T3ConnectEnvironmentAccessToken(
            environmentID: credential.environmentID,
            label: credential.label,
            endpoint: credential.endpoint,
            accessToken: response.accessToken,
            expiresAt: Date().addingTimeInterval(response.expiresIn),
            scopes: grantedScopes,
            proofKeyThumbprint: thumbprint
        )
    }

    /// Adds a fresh request-bound proof. Call this immediately before sending;
    /// reusing a proof defeats replay protection and is rejected by the server.
    public func authorize(
        _ request: URLRequest,
        using authorization: T3ConnectEnvironmentAccessToken
    ) async throws -> URLRequest {
        guard let url = request.url else { throw T3ConnectDPoPError.invalidURL }
        let proof = try await signer.proof(
            method: request.httpMethod ?? "GET",
            url: url,
            accessToken: authorization.accessToken
        )
        guard proof.thumbprint == authorization.proofKeyThumbprint else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The environment token is bound to a different device identity."
            )
        }
        var authorized = request
        authorized.setValue(
            "DPoP \(authorization.accessToken)",
            forHTTPHeaderField: "Authorization"
        )
        authorized.setValue(proof.value, forHTTPHeaderField: "DPoP")
        return authorized
    }

    public func proofKeyThumbprint() async throws -> String {
        try await signer.thumbprint()
    }

    public func descriptor(at httpBaseURL: URL) async throws -> EnvironmentDescriptor {
        try await send(
            URLRequest(
                url: endpoint(
                    httpBaseURL,
                    path: [".well-known", "t3", "environment"]
                )
            ),
            as: EnvironmentDescriptor.self
        )
    }

    public func webSocketURL(
        using authorization: T3ConnectEnvironmentAccessToken
    ) async throws -> URL {
        guard
            let httpBaseURL = authorization.endpoint.httpBaseURL,
            let webSocketBaseURL = authorization.endpoint.webSocketBaseURL,
            httpBaseURL.scheme?.lowercased() == "https",
            httpBaseURL.host?.isEmpty == false,
            webSocketBaseURL.scheme?.lowercased() == "wss",
            webSocketBaseURL.host?.isEmpty == false
        else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The managed environment endpoint is invalid."
            )
        }
        let target = endpoint(
            httpBaseURL,
            path: ["api", "auth", "websocket-ticket"]
        )
        var ticketRequest = URLRequest(url: target)
        ticketRequest.httpMethod = "POST"
        ticketRequest = try await authorize(ticketRequest, using: authorization)
        let ticket = try await send(ticketRequest, as: WebSocketTicketResponse.self)
        guard !ticket.ticket.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw T3ConnectRelayError.invalidResponse
        }

        var components = URLComponents(
            url: webSocketBaseURL,
            resolvingAgainstBaseURL: false
        )
        if components?.path.isEmpty == true || components?.path == "/" {
            components?.path = "/ws"
        }
        var queryItems = components?.queryItems ?? []
        queryItems.removeAll { $0.name == "wsTicket" }
        queryItems.append(URLQueryItem(name: "wsTicket", value: ticket.ticket))
        queryItems.removeAll { $0.name == OrchestrationProtocol.queryItemName }
        queryItems.append(OrchestrationProtocol.queryItem)
        components?.queryItems = queryItems
        guard let url = components?.url else { throw T3ConnectDPoPError.invalidURL }
        return url
    }

    private func endpoint(_ baseURL: URL, path: [String]) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.path = ""
        components?.query = nil
        components?.fragment = nil
        let origin = components?.url ?? baseURL
        return path.reduce(origin) { partial, component in
            partial.appendingPathComponent(component)
        }
    }

    private func send<Response: Decodable & Sendable>(
        _ request: URLRequest,
        as type: Response.Type
    ) async throws -> Response {
        let (data, response) = try await transport.data(for: HTTPRequestPolicy.prepare(request))
        guard (200..<300).contains(response.statusCode) else {
            let body = try? JSONDecoder.t3.decode(ErrorBody.self, from: data)
            throw T3ConnectRelayError.response(
                status: response.statusCode,
                message: body?.message ?? body?.reason ?? "Environment authorization failed.",
                traceID: body?.traceId
            )
        }
        do {
            return try JSONDecoder.t3.decode(type, from: data)
        } catch {
            throw T3ConnectRelayError.invalidResponse
        }
    }

    private static func formEncoded(_ fields: [String: String]) -> Data {
        var components = URLComponents()
        components.queryItems = fields.keys.sorted().map {
            URLQueryItem(name: $0, value: fields[$0])
        }
        return Data((components.percentEncodedQuery ?? "").utf8)
    }
}

/// Adapts the T3 Connect token lifecycle to Core's environment transport.
/// Refresh work is coalesced per environment because shell, detail, and socket
/// reconnect requests can all discover expiration at the same time.
public actor T3ConnectRuntimeAuthorization: ManagedEnvironmentAuthorizing {
    public typealias BootstrapProvider = @Sendable (String) async throws
        -> T3ConnectManagedEnvironmentCredential

    private struct InFlightRefresh: Sendable {
        let id: UUID
        let task: Task<EnvironmentCredential, Error>
    }

    private let authorizer: T3ConnectManagedEnvironmentAuthorizer
    private let bootstrapProvider: BootstrapProvider
    private var refreshTasks: [String: InFlightRefresh] = [:]

    @MainActor
    public init(controller: T3ConnectController) {
        authorizer = controller.managedAuthorizer
        bootstrapProvider = { environmentID in
            try await controller.credential(forEnvironmentID: environmentID)
        }
    }

    public init(
        authorizer: T3ConnectManagedEnvironmentAuthorizer,
        bootstrapProvider: @escaping BootstrapProvider
    ) {
        self.authorizer = authorizer
        self.bootstrapProvider = bootstrapProvider
    }

    public func credentialRequiresRefresh(
        _ credential: EnvironmentCredential,
        environment: Environment
    ) async throws -> Bool {
        _ = try Self.authorization(environment: environment, credential: credential)
        return try await authorizer.proofKeyThumbprint() != credential.proofKeyThumbprint
    }

    public func authorize(
        _ request: URLRequest,
        environment: Environment,
        credential: EnvironmentCredential
    ) async throws -> URLRequest {
        let authorization = try Self.authorization(
            environment: environment,
            credential: credential
        )
        return try await authorizer.authorize(request, using: authorization)
    }

    public func refreshCredential(
        for environment: Environment,
        replacing credential: EnvironmentCredential
    ) async throws -> EnvironmentCredential {
        _ = try Self.authorization(environment: environment, credential: credential)
        if let refresh = refreshTasks[environment.id] {
            return try await refresh.task.value
        }

        let authorizer = self.authorizer
        let bootstrapProvider = self.bootstrapProvider
        let task = Task<EnvironmentCredential, Error> {
            let bootstrap = try await bootstrapProvider(environment.id)
            try Self.validate(
                bootstrap: bootstrap,
                environment: environment
            )
            guard let httpBaseURL = bootstrap.endpoint.httpBaseURL else {
                throw T3ConnectRelayError.environmentMismatch
            }
            let descriptor = try await authorizer.descriptor(at: httpBaseURL)
            guard descriptor.environmentId == environment.id else {
                throw T3ConnectRelayError.environmentMismatch
            }
            let authorization = try await authorizer.exchange(bootstrap)
            return try Self.credential(
                authorization: authorization,
                environment: environment
            )
        }
        let refreshID = UUID()
        refreshTasks[environment.id] = InFlightRefresh(id: refreshID, task: task)
        do {
            let credential = try await task.value
            finishRefresh(environmentID: environment.id, id: refreshID)
            return credential
        } catch {
            finishRefresh(environmentID: environment.id, id: refreshID)
            throw error
        }
    }

    private func finishRefresh(environmentID: String, id: UUID) {
        guard refreshTasks[environmentID]?.id == id else { return }
        refreshTasks.removeValue(forKey: environmentID)
    }

    private static func authorization(
        environment: Environment,
        credential: EnvironmentCredential
    ) throws -> T3ConnectEnvironmentAccessToken {
        guard environment.kind == .managedDPoP,
              credential.authorizationMethod == .dpop,
              credential.managedEnvironmentID == environment.id,
              let expiresAt = credential.expiresAt,
              let proofKeyThumbprint = credential.proofKeyThumbprint,
              let endpoint = managedEndpoint(for: environment) else {
            throw HTTPError.incompatibleCredential
        }
        return T3ConnectEnvironmentAccessToken(
            environmentID: environment.id,
            label: environment.label,
            endpoint: endpoint,
            accessToken: credential.accessToken,
            expiresAt: expiresAt,
            scopes: credential.scopes,
            proofKeyThumbprint: proofKeyThumbprint
        )
    }

    private static func credential(
        authorization: T3ConnectEnvironmentAccessToken,
        environment: Environment
    ) throws -> EnvironmentCredential {
        guard let relay = environment.relayRoute,
              authorization.environmentID == environment.id,
              authorization.proofKeyThumbprint.isEmpty == false,
              authorization.endpoint.httpBaseURL == relay.httpBaseURL,
              authorization.endpoint.webSocketBaseURL == relay.webSocketBaseURL else {
            throw T3ConnectRelayError.environmentMismatch
        }
        return .managedDPoP(
            accessToken: authorization.accessToken,
            expiresAt: authorization.expiresAt,
            scopes: authorization.scopes,
            environmentID: authorization.environmentID,
            proofKeyThumbprint: authorization.proofKeyThumbprint
        )
    }

    private static func validate(
        bootstrap: T3ConnectManagedEnvironmentCredential,
        environment: Environment
    ) throws {
        guard let relay = environment.relayRoute,
              bootstrap.environmentID == environment.id,
              bootstrap.proofKeyThumbprint.isEmpty == false,
              bootstrap.endpoint.httpBaseURL == relay.httpBaseURL,
              bootstrap.endpoint.webSocketBaseURL == relay.webSocketBaseURL else {
            throw T3ConnectRelayError.environmentMismatch
        }
    }

    /// The T3 Connect tunnel's endpoint. Requests may go to a LAN or tailnet
    /// address learned through it: the access token is not bound to an
    /// origin and every proof signs the URL it is sent to, but renewal always
    /// goes through the tunnel.
    private static func managedEndpoint(
        for environment: Environment
    ) -> T3ConnectManagedEndpoint? {
        guard let relay = environment.relayRoute,
              relay.httpBaseURL.scheme?.lowercased() == "https",
              relay.webSocketBaseURL.scheme?.lowercased() == "wss",
              relay.httpBaseURL.host != nil,
              relay.webSocketBaseURL.host != nil else { return nil }
        return T3ConnectManagedEndpoint(
            httpBaseUrl: relay.httpBaseURL.absoluteString,
            wsBaseUrl: relay.webSocketBaseURL.absoluteString,
            providerKind: .t3Relay
        )
    }
}
