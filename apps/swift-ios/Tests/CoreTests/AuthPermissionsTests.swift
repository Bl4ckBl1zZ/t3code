import XCTest
@testable import T3Code

/// Ported from `packages/contracts/src/auth.test.ts`, plus the wire shapes the
/// app decodes from servers before and after granular permissions.
final class AuthPermissionsTests: XCTestCase {
    func testSessionFromAnOlderServerKeepsEveryFeatureItsBroadScopesCover() throws {
        let session = try JSONDecoder.t3.decode(AuthSessionState.self, from: Data(#"""
        {"authenticated":true,
         "auth":{"policy":"remote-reachable","bootstrapMethods":["one-time-token"],
                 "sessionMethods":["bearer-access-token"],"sessionCookieName":"t3_session"},
         "scopes":["orchestration:read","orchestration:operate","terminal:operate","review:write","relay:read"],
         "sessionMethod":"bearer-access-token","expiresAt":"2026-11-01T00:00:00.000Z"}
        """#.utf8))

        XCTAssertNil(session.permissions)
        XCTAssertNil(session.auth?.serverUpdateScope)
        for scope in [
            AuthScope.filesystemRead, AuthScope.filesystemWrite, AuthScope.sourceControlWrite,
            AuthScope.settingsWrite, AuthScope.providersManage, AuthScope.environmentMaintain,
            AuthScope.diagnosticsRead, AuthScope.terminalRead, AuthScope.orchestrationOperate,
        ] {
            XCTAssertTrue(session.grants(scope), scope)
        }
        XCTAssertFalse(session.grants(AuthScope.accessRead))
        XCTAssertFalse(session.hasLegacyPermissions)
    }

    func testSessionFromAGranularServerIsJudgedByItsPermissions() throws {
        let session = try JSONDecoder.t3.decode(AuthSessionState.self, from: Data(#"""
        {"authenticated":true,
         "auth":{"policy":"remote-reachable","bootstrapMethods":[],"sessionMethods":[],
                 "sessionCookieName":"t3_session","serverUpdateScope":"environment:maintain"},
         "scopes":["orchestration:read","orchestration:operate","terminal:operate","review:write","relay:read"],
         "permissions":["orchestration:read","orchestration:operate","terminal:operate","review:write","relay:read"]}
        """#.utf8))

        XCTAssertEqual(session.auth?.serverUpdateScope, AuthScope.environmentMaintain)
        XCTAssertEqual(session.permissions?.count, 5)
        XCTAssertTrue(session.grants(AuthScope.orchestrationOperate))
        XCTAssertFalse(session.grants(AuthScope.filesystemRead))
        XCTAssertFalse(session.grants(AuthScope.sourceControlWrite))
        XCTAssertTrue(session.hasLegacyPermissions)
    }

    func testClientSessionsDecodeWithAndWithoutPermissions() throws {
        let row = #"""
        {"sessionId":"s","subject":"device","scopes":["orchestration:read"],%@
         "method":"bearer-access-token","client":{"deviceType":"mobile"},
         "issuedAt":"2026-10-01T00:00:00.000Z","expiresAt":"2026-11-01T00:00:00.000Z",
         "lastConnectedAt":null,"connected":true,"current":true}
        """#
        let old = try JSONDecoder.t3.decode(
            AuthClientSession.self,
            from: Data(String(format: row, "").utf8)
        )
        let granular = try JSONDecoder.t3.decode(
            AuthClientSession.self,
            from: Data(String(format: row, #""permissions":["orchestration:read","filesystem:read"],"#).utf8)
        )

        XCTAssertNil(old.permissions)
        XCTAssertEqual(granular.permissions, ["orchestration:read", "filesystem:read"])
    }

    func testUnknownPermissionsGrantNothingAndNeverFallBackToBroaderScopes() {
        let session = session(scopes: ["orchestration:operate"], permissions: ["future:permission"])

        XCTAssertFalse(session.grants(AuthScope.orchestrationOperate))
        XCTAssertFalse(session.grants(AuthScope.settingsWrite))
    }

    func testSessionGrants() {
        let cases: [(String, AuthSessionState, String, Bool)] = [
            ("exact permissions over the legacy presentation",
             session(scopes: ["orchestration:operate"], permissions: ["filesystem:read"]),
             AuthScope.settingsWrite, false),
            ("a permission absent from the legacy presentation",
             session(scopes: [], permissions: ["filesystem:read"]),
             AuthScope.filesystemRead, true),
            ("the parent on a server that predates the split",
             session(scopes: ["orchestration:operate"]),
             AuthScope.settingsWrite, true),
            ("only the exact scope on a server that knows the split",
             session(scopes: ["orchestration:operate"], serverUpdateScope: "environment:maintain"),
             AuthScope.settingsWrite, false),
            ("the exact scope regardless of server version",
             session(scopes: ["settings:write"]),
             AuthScope.settingsWrite, true),
            ("nothing for an unauthenticated session",
             session(authenticated: false, scopes: ["orchestration:operate"]),
             AuthScope.settingsWrite, false),
            ("no parent for scopes that were never split",
             session(scopes: ["orchestration:operate"]),
             AuthScope.accessWrite, false),
            ("terminal reading through terminal operation on an older server",
             session(scopes: ["terminal:operate"]),
             AuthScope.terminalRead, true),
        ]
        for (label, session, scope, expected) in cases {
            XCTAssertEqual(session.grants(scope), expected, label)
        }
    }

    func testLegacyPermissionNoticeRecognizesOldGrantsOnAnUpgradedServer() {
        for scope in ["orchestration:read", "orchestration:operate", "terminal:operate"] {
            XCTAssertTrue(session(permissions: [scope]).hasLegacyPermissions, scope)
        }
        // A permission this build does not know is dropped, as the contract does.
        XCTAssertTrue(session(permissions: ["orchestration:operate", "future:permission"]).hasLegacyPermissions)
    }

    func testLegacyPermissionNoticeWaitsForANewServerAndAnAuthenticatedSession() {
        XCTAssertFalse(session(scopes: ["orchestration:operate"]).hasLegacyPermissions)
        XCTAssertFalse(session(authenticated: false, permissions: ["orchestration:operate"]).hasLegacyPermissions)
    }

    func testLegacyPermissionNoticeSkipsNewGrantsAndOldGrantsThatLostNothing() {
        let standard = [
            "orchestration:read", "orchestration:operate", "settings:write", "providers:manage",
            "environment:maintain", "preview:operate", "diagnostics:read", "terminal:read",
            "terminal:operate", "source-control:write", "filesystem:read", "filesystem:write",
            "relay:read",
        ]
        for permissions in [standard, ["orchestration:read", "filesystem:read"], ["access:read"], []] {
            XCTAssertFalse(session(permissions: permissions).hasLegacyPermissions, "\(permissions)")
        }
    }

    func testSettingsPatchNeedsTheDomainsItChanges() {
        XCTAssertEqual(
            AuthScope.required(forSettingsPatch: ServerSettingsPatchInput(pullRequestMergeMethod: .some("squash")).json),
            [AuthScope.settingsWrite]
        )
        XCTAssertEqual(
            AuthScope.required(forSettingsPatch: ServerSettingsPatchInput(providerInstances: [:]).json),
            [AuthScope.providersManage]
        )
        XCTAssertEqual(
            AuthScope.required(forSettingsPatch: ServerSettingsPatchInput(usageLimitSources: [:]).json),
            [AuthScope.providersManage]
        )
        // Claude's compaction window is written under `providers`.
        XCTAssertEqual(
            AuthScope.required(forSettingsPatch: ServerSettingsPatchInput(claudeAutoCompactWindow: "200000").json),
            [AuthScope.providersManage]
        )
        XCTAssertEqual(
            AuthScope.required(forSettingsPatch: ServerSettingsPatchInput(
                environmentIcon: .some("laptop"),
                claudeAutoCompactWindow: ""
            ).json),
            [AuthScope.settingsWrite, AuthScope.providersManage]
        )
        XCTAssertEqual(AuthScope.required(forSettingsPatch: .object([:])), [AuthScope.settingsWrite])
    }

    func testOnlySplitOffPermissionsAskToPairAgain() throws {
        let required = try XCTUnwrap(AuthPermissionRequired(AuthScope.filesystemRead))
        XCTAssertEqual(
            required.errorDescription,
            "Pair this device again to browse and preview files. This connection's permissions don't include it."
        )
        XCTAssertNil(AuthPermissionRequired(AuthScope.orchestrationOperate))
        XCTAssertNil(AuthPermissionRequired(AuthScope.accessWrite))
    }

    func testHTTPDenialNamingAPermissionAsksToPairAgain() async throws {
        let message = try await httpDenialMessage(#"""
        {"_tag":"EnvironmentScopeRequiredError",
         "message":"The authenticated token is missing required scope: filesystem:read.",
         "requiredScope":"orchestration:read","requiredPermission":"filesystem:read"}
        """#)
        XCTAssertTrue(message.hasPrefix("Pair this device again to browse and preview files."), message)

        let older = try await httpDenialMessage(#"""
        {"message":"The authenticated token is missing required scope: access:read.","requiredScope":"access:read"}
        """#)
        XCTAssertTrue(older.hasPrefix("The authenticated token is missing required scope: access:read."), older)
    }

    func testRPCDenialNamingAPermissionAsksToPairAgain() async throws {
        let message = try await rpcDenialMessage(.object([
            "_tag": .string("EnvironmentAuthorizationError"),
            "message": .string("The authenticated token is missing required scope: source-control:write."),
            "requiredScope": .string("orchestration:operate"),
            "requiredPermission": .string("source-control:write"),
        ]))
        XCTAssertEqual(
            message,
            "Pair this device again to use Git and pull request actions. This connection's permissions don't include it."
        )

        let older = try await rpcDenialMessage(.object([
            "_tag": .string("EnvironmentAuthorizationError"),
            "message": .string("The authenticated token is missing required scope: orchestration:operate."),
            "requiredScope": .string("orchestration:operate"),
        ]))
        XCTAssertEqual(older, "The authenticated token is missing required scope: orchestration:operate.")
    }

    // MARK: - Helpers

    private func session(
        authenticated: Bool = true,
        scopes: [String]? = nil,
        permissions: [String]? = nil,
        serverUpdateScope: String? = nil
    ) -> AuthSessionState {
        AuthSessionState(
            authenticated: authenticated,
            auth: ServerAuthDescriptor(serverUpdateScope: serverUpdateScope),
            scopes: scopes,
            permissions: permissions,
            sessionMethod: nil,
            expiresAt: nil
        )
    }

    private func httpDenialMessage(_ body: String) async throws -> String {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let api = EnvironmentAPI(
            transport: DenyingHTTPTransport(body: Data(body.utf8)),
            credentials: InMemoryCredentialStore(credentials: [
                environment.id: EnvironmentCredential(accessToken: "token"),
            ])
        )
        do {
            _ = try await api.shellSnapshot(for: environment)
            XCTFail("The denial was not surfaced")
            return ""
        } catch let HTTPError.status(status, message, _) {
            XCTAssertEqual(status, 403)
            return message
        }
    }

    private func rpcDenialMessage(_ error: JSONValue) async throws -> String {
        let client = WebSocketRPCClient(
            connector: DenyingWebSocketConnector(connection: DenyingWebSocketConnection(error: error)),
            connectionWaitTimeout: .seconds(2),
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )
        var failure: (any Error)?
        do {
            _ = try await client.request("projects.listEntries", as: JSONValue.self)
        } catch {
            failure = error
        }
        await client.stop()
        guard case let RPCError.remote(message)? = failure else {
            XCTFail("The denial was not surfaced: \(String(describing: failure))")
            return ""
        }
        return message
    }
}

private struct DenyingHTTPTransport: HTTPTransport {
    let body: Data

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 403,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (body, response)
    }
}

private struct DenyingWebSocketConnector: WebSocketConnecting {
    let connection: DenyingWebSocketConnection

    func connect(to _: URL) async throws -> any WebSocketConnection {
        connection
    }
}

/// Fails every request the way the server's RPC authorization does.
private actor DenyingWebSocketConnection: WebSocketConnection {
    private let error: JSONValue
    private var queuedResponses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?

    init(error: JSONValue) {
        self.error = error
    }

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard case let .number(requestID) = request["id"] else { return }
        let response = JSONValue.object([
            "_tag": .string("Exit"),
            "requestId": .number(requestID),
            "exit": .object([
                "_tag": .string("Failure"),
                "cause": .array([.object(["_tag": .string("Fail"), "error": error])]),
            ]),
        ])
        let encoded = try JSONEncoder.t3.encode(response)
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: encoded)
        } else {
            queuedResponses.append(encoded)
        }
    }

    func receive() async throws -> Data {
        if !queuedResponses.isEmpty {
            return queuedResponses.removeFirst()
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiver = continuation
        }
    }

    func close() {
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }
}
