import XCTest
@testable import T3Code

final class EnvironmentRoutesTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("environment-routes-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    // MARK: - Saved data from before routes

    func testSingleAddressCatalogKeepsItsAddressAndKeychainCredential() async throws {
        let catalogURL = directory.appendingPathComponent("environments.json")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(
            #"""
            {"version":1,"activeEnvironmentID":"env-1","environments":[
              {"id":"env-1","label":"Desk","httpBaseURL":"http://192.168.1.4:3773/",
               "webSocketBaseURL":"ws://192.168.1.4:3773/","kind":"bearer"},
              {"id":"env-2","label":"Cloud","httpBaseURL":"https://relay.example/e/env-2/",
               "webSocketBaseURL":"wss://relay.example/e/env-2/","kind":"managed-dpop"}
            ]}
            """#.utf8
        ).write(to: catalogURL)

        let store = EnvironmentStore(fileURL: catalogURL)
        let saved = try await store.load()

        XCTAssertEqual(saved.map(\.routes.count), [1, 1])
        let direct = saved[0]
        XCTAssertEqual(direct.routes[0].id, "direct:http://192.168.1.4:3773")
        XCTAssertEqual(direct.credentialID, "env-1")
        XCTAssertEqual(direct.kind, .bearer)
        XCTAssertEqual(direct.httpBaseURL, URL(string: "http://192.168.1.4:3773/"))
        XCTAssertNil(direct.relayRoute)
        let relay = saved[1]
        XCTAssertEqual(relay.routes[0].id, EnvironmentRoute.relayID)
        XCTAssertEqual(relay.credentialID, "env-2")
        XCTAssertEqual(relay.kind, .managedDPoP)
        XCTAssertEqual(relay.relayRoute?.httpBaseURL, URL(string: "https://relay.example/e/env-2/"))

        // The credential saved under the environment id still authorizes it.
        let transport = RouteTestTransport(descriptorEnvironmentID: "env-1")
        let credentials = InMemoryCredentialStore(
            credentials: ["env-1": EnvironmentCredential(accessToken: "token-1")]
        )
        let api = EnvironmentAPI(transport: transport, credentials: credentials)
        _ = try await api.session(for: direct)
        let requests = await transport.requests
        XCTAssertEqual(requests.last?.url?.host, "192.168.1.4")
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")

        // Saving again keeps the single-address fields an older build reads.
        try await store.save(saved)
        let json = try String(contentsOf: catalogURL, encoding: .utf8)
        XCTAssertTrue(json.contains("\"httpBaseURL\""))
        XCTAssertTrue(json.contains("\"routes\""))
        let reloaded = try await EnvironmentStore(fileURL: catalogURL).load()
        XCTAssertEqual(reloaded, saved)
    }

    func testPairingAnotherAddressAddsARouteWithItsOwnCredential() async throws {
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        let original = Environment(
            id: "env-1",
            label: "Desk",
            httpBaseURL: URL(string: "http://192.168.1.4:3773/")!,
            webSocketBaseURL: URL(string: "ws://192.168.1.4:3773/")!
        )
        try await store.save([original])
        let credentials = InMemoryCredentialStore(
            credentials: ["env-1": EnvironmentCredential(accessToken: "token-1")]
        )
        let service = PairingService(
            transport: RouteTestTransport(descriptorEnvironmentID: "env-1", issuedToken: "token-2"),
            environmentStore: store,
            credentialStore: credentials
        )

        let environment = try await service.pair(
            url: "http://100.101.102.103:3773/#token=pair-once",
            expectedEnvironmentID: "env-1"
        )

        let tailnetID = EnvironmentRoute.directID(URL(string: "http://100.101.102.103:3773")!)
        XCTAssertEqual(environment.routes.map(\.id), [original.routes[0].id, tailnetID])
        XCTAssertEqual(environment.routes[0].credentialID, "env-1")
        let tailnetCredentialID = environment.routes[1].credentialID
        XCTAssertNotEqual(tailnetCredentialID, "env-1")
        let originalCredential = await credentials.credential(for: "env-1")
        let tailnetCredential = await credentials.credential(for: tailnetCredentialID)
        XCTAssertEqual(originalCredential?.accessToken, "token-1")
        XCTAssertEqual(tailnetCredential?.accessToken, "token-2")
        let saved = try await store.load()
        XCTAssertEqual(saved.count, 1)
        XCTAssertEqual(saved[0].routes.map(\.id), environment.routes.map(\.id))
    }

    func testAddingARouteFromAnotherMachineIsRefusedBeforeTheExchange() async throws {
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        let transport = RouteTestTransport(descriptorEnvironmentID: "someone-else")
        let service = PairingService(
            transport: transport,
            environmentStore: store,
            credentialStore: InMemoryCredentialStore()
        )

        do {
            _ = try await service.pair(
                url: "http://192.168.1.9:3773/#token=pair-once",
                expectedEnvironmentID: "env-1"
            )
            XCTFail("A link for another machine must be refused.")
        } catch let error as PairingRouteError {
            XCTAssertEqual(error, .differentEnvironment("Desk"))
        }
        let paths = await transport.requests.map { $0.url?.path }
        XCTAssertEqual(paths, ["/.well-known/t3/environment"])
    }

    // MARK: - Route list rules

    func testNewRoutesLandByNetworkAndUpsertReplacesTheSameAddress() {
        let relay = route("https://relay.example/e/env-1/", kind: .managedDPoP)
        let tailnet = route("http://100.101.102.103:3773/")
        let lan = route("http://192.168.1.4:3773/")

        var routes = EnvironmentRoutes.inserting(tailnet, into: [relay])
        routes = EnvironmentRoutes.inserting(lan, into: routes)
        XCTAssertEqual(routes.map(\.label), ["LAN", "Tailscale", "T3 Connect"])

        let learnedLAN = EnvironmentRoute(
            id: "learned:http://192.168.1.4:3773",
            httpBaseURL: lan.httpBaseURL,
            webSocketBaseURL: lan.webSocketBaseURL,
            kind: .bearer,
            credentialID: "env-1",
            learned: true
        )
        let paired = EnvironmentRoutes.upserting(lan, into: [learnedLAN, relay])
        XCTAssertEqual(paired.map(\.id), [lan.id, relay.id])
    }

    func testLearnedRoutesBorrowTheActiveCredentialAndFollowTheServer() throws {
        let paired = route("https://desk.example/", credentialID: "env-1")
        let reported = [
            ServerDirectEndpoint(kind: .lan, httpBaseUrl: "http://192.168.1.4:3773/"),
            ServerDirectEndpoint(kind: .tailnet, httpBaseUrl: "http://100.101.102.103:3773/"),
            ServerDirectEndpoint(kind: .lan, httpBaseUrl: "http://127.0.0.1:3773/"),
            ServerDirectEndpoint(kind: .lan, httpBaseUrl: "https://desk.example/"),
            ServerDirectEndpoint(kind: .lan, httpBaseUrl: "not a url"),
        ]

        let learned = try XCTUnwrap(
            EnvironmentRoutes.mergingLearned(into: [paired], activeRoute: paired, reported: reported)
        )

        XCTAssertEqual(learned.map(\.label), ["LAN", "Tailscale", "desk.example"])
        XCTAssertEqual(learned.filter(\.learned).map(\.credentialID), ["env-1", "env-1"])
        XCTAssertEqual(learned.filter(\.learned).map(\.kind), [.bearer, .bearer])
        XCTAssertEqual(learned[0].webSocketBaseURL.absoluteString, "ws://192.168.1.4:3773/")
        XCTAssertNil(
            EnvironmentRoutes.mergingLearned(into: learned, activeRoute: paired, reported: reported),
            "Reporting the same addresses again changes nothing."
        )

        // The LAN address moved: the old learned route goes, the new one comes.
        let moved = try XCTUnwrap(
            EnvironmentRoutes.mergingLearned(
                into: learned,
                activeRoute: paired,
                reported: [ServerDirectEndpoint(kind: .lan, httpBaseUrl: "http://192.168.1.50:3773/")]
            )
        )
        XCTAssertEqual(moved.compactMap(\.address), ["http://192.168.1.50:3773", "https://desk.example"])

        // Plain HTTP is skipped where the transport forbids it.
        XCTAssertNil(
            EnvironmentRoutes.mergingLearned(
                into: [paired],
                activeRoute: paired,
                reported: [ServerDirectEndpoint(kind: .lan, httpBaseUrl: "http://192.168.1.4:3773/")],
                allowInsecure: false
            )
        )
    }

    func testRoutesLearnedThroughTConnectUseItsCredentialAndGoWithIt() throws {
        let relay = route("https://relay.example/e/env-1/", kind: .managedDPoP, credentialID: "env-1")
        let learned = try XCTUnwrap(
            EnvironmentRoutes.mergingLearned(
                into: [relay],
                activeRoute: relay,
                reported: [ServerDirectEndpoint(kind: .lan, httpBaseUrl: "http://192.168.1.4:3773/")]
            )
        )
        XCTAssertEqual(learned.map(\.label), ["LAN", "T3 Connect"])
        XCTAssertEqual(learned[0].kind, .managedDPoP)
        XCTAssertEqual(learned[0].credentialID, "env-1")
        XCTAssertFalse(learned[0].isRelay)

        let environment = Environment(id: "env-1", label: "Desk", routes: learned)
        XCTAssertEqual(environment.routed(through: learned[0]).relayRoute?.id, EnvironmentRoute.relayID)

        let paired = route("http://100.101.102.103:3773/", credentialID: "env-1#tailnet")
        let all = EnvironmentRoutes.inserting(paired, into: learned)
        XCTAssertEqual(
            EnvironmentRoutes.removing(EnvironmentRoute.relayID, from: all).map(\.id),
            [paired.id],
            "Removing T3 Connect removes the routes learned through it."
        )
    }

    func testReorderingAndLearningKeepTheEndpointKeyButAddingARouteChangesIt() throws {
        let lan = route("http://192.168.1.4:3773/")
        let relay = route("https://relay.example/e/env-1/", kind: .managedDPoP)
        let key = EnvironmentRoutes.endpointKey([lan, relay])

        let reordered = try XCTUnwrap(EnvironmentRoutes.reordered([lan, relay], as: [relay.id, lan.id]))
        XCTAssertEqual(EnvironmentRoutes.endpointKey(reordered), key)
        XCTAssertNil(EnvironmentRoutes.reordered([lan, relay], as: [relay.id]))
        XCTAssertNil(EnvironmentRoutes.reordered([lan, relay], as: [relay.id, relay.id]))

        let learned = try XCTUnwrap(
            EnvironmentRoutes.mergingLearned(
                into: [lan, relay],
                activeRoute: relay,
                reported: [ServerDirectEndpoint(kind: .tailnet, httpBaseUrl: "http://100.101.102.103:3773/")]
            )
        )
        XCTAssertEqual(EnvironmentRoutes.endpointKey(learned), key)
        XCTAssertNotEqual(
            EnvironmentRoutes.endpointKey(
                EnvironmentRoutes.inserting(route("http://100.101.102.103:3773/"), into: [lan, relay])
            ),
            key
        )
    }

    func testHostClassificationMatchesTheWebClient() {
        XCTAssertTrue(HostClassification.isLoopback("localhost"))
        XCTAssertTrue(HostClassification.isLoopback("127.0.0.2"))
        XCTAssertTrue(HostClassification.isLoopback("[::1]"))
        XCTAssertTrue(HostClassification.isTailnet("studio.tailnet.ts.net"))
        XCTAssertTrue(HostClassification.isTailnet("100.64.0.1"))
        XCTAssertFalse(HostClassification.isTailnet("100.128.0.1"))
        XCTAssertTrue(HostClassification.isTailnet("fd7a:115c:a1e0::1"))
        XCTAssertTrue(HostClassification.isPrivateNetwork("192.168.1.4"))
        XCTAssertTrue(HostClassification.isPrivateNetwork("studio.local"))
        XCTAssertTrue(HostClassification.isPrivateNetwork("fe80::1"))
        XCTAssertFalse(HostClassification.isPrivateNetwork("example.com"))
        XCTAssertFalse(HostClassification.isPrivateNetwork("8.8.8.8"))
    }

    // MARK: - Connecting over routes

    func testConnectFallsBackToTheNextRouteAndKeepsUsingIt() async throws {
        let lan = route("http://192.168.1.4:3773/")
        let relay = route("https://relay.example/e/env-1/", kind: .managedDPoP)
        let selector = EnvironmentRouteSelector(
            environment: Environment(id: "env-1", label: "Desk", routes: [lan, relay]),
            probe: { _, _ in "env-1" },
            preflight: { _ in true }
        )
        let attempts = RouteAttempts()

        let used = try await selector.connect { routed -> String in
            let id = routed.routes[0].id
            await attempts.append(id)
            if id == lan.id { throw URLError(.cannotConnectToHost) }
            return id
        }

        XCTAssertEqual(used, relay.id)
        let tried = await attempts.ids
        XCTAssertEqual(tried, [lan.id, relay.id])
        XCTAssertEqual(selector.currentRouteID(), relay.id)
        XCTAssertEqual(selector.current().httpBaseURL, relay.httpBaseURL)
    }

    func testSilentRoutesGoLastAndAnotherMachineNeverGetsACredential() async throws {
        let lan = route("http://192.168.1.4:3773/")
        let stranger = route("http://100.101.102.103:3773/")
        let relay = route("https://relay.example/e/env-1/", kind: .managedDPoP)
        let selector = EnvironmentRouteSelector(
            environment: Environment(id: "env-1", label: "Desk", routes: [lan, stranger, relay]),
            probe: { url, timeout -> String? in
                let host = url.host ?? ""
                // Too slow for the quick check, but it is this machine.
                if host == "192.168.1.4" {
                    return timeout > EnvironmentRouteSelector.checkTimeout ? "env-1" : nil
                }
                if host == "100.101.102.103" { return "someone-else" }
                return nil
            },
            preflight: { _ in true }
        )
        let attempts = RouteAttempts()

        let used = try await selector.connect { routed -> String in
            let id = routed.routes[0].id
            await attempts.append(id)
            if id == relay.id { throw HTTPError.status(503, message: "Offline", traceID: nil) }
            return id
        }

        XCTAssertEqual(used, lan.id)
        let tried = await attempts.ids
        XCTAssertEqual(tried, [relay.id, lan.id])
    }

    func testOneRouteConnectsWithoutChecks() async throws {
        let probes = RouteAttempts()
        let lan = route("http://192.168.1.4:3773/")
        let selector = EnvironmentRouteSelector(
            environment: Environment(id: "env-1", label: "Desk", routes: [lan]),
            probe: { url, _ -> String? in
                await probes.append(url.absoluteString)
                return "env-1"
            },
            preflight: { _ in true }
        )

        let used = try await selector.connect { routed in routed.routes[0].id }

        XCTAssertEqual(used, lan.id)
        let probed = await probes.ids
        XCTAssertEqual(probed, [])
        let better = await selector.checkForBetterRoute()
        XCTAssertFalse(better)
    }

    func testABetterRouteIsPreferredOnceItWorksAndCoolsDownWhenItDoesNot() async throws {
        let lan = route("http://192.168.1.4:3773/")
        let relay = route("https://relay.example/e/env-1/", kind: .managedDPoP)
        let lanWorks = RouteSwitch()
        let selector = EnvironmentRouteSelector(
            environment: Environment(id: "env-1", label: "Desk", routes: [lan, relay]),
            probe: { _, _ in "env-1" },
            preflight: { _ in true }
        )
        let operation: (Environment) async throws -> String = { routed in
            let id = routed.routes[0].id
            if id == lan.id, await !lanWorks.isOn { throw URLError(.timedOut) }
            return id
        }

        let first = try await selector.connect(operation)
        XCTAssertEqual(first, relay.id)

        // The LAN answers its preflight but still fails to connect: the
        // connection lands back on T3 Connect and the LAN cools down.
        let preferLAN = await selector.checkForBetterRoute()
        XCTAssertTrue(preferLAN)
        let fallback = try await selector.connect(operation)
        XCTAssertEqual(fallback, relay.id)
        let cooled = await selector.checkForBetterRoute()
        XCTAssertFalse(cooled)

        // A user reorder ignores the cooldown and moves to the LAN at once.
        await lanWorks.turnOn()
        XCTAssertTrue(selector.adopt([lan, relay], preferFirst: true))
        let moved = try await selector.connect(operation)
        XCTAssertEqual(moved, lan.id)
    }

    func testRequestsRetryOverOtherRoutesOnlyWhenTheRouteFails() async throws {
        let lan = route("http://192.168.1.4:3773/")
        let relay = route("https://relay.example/e/env-1/", kind: .managedDPoP)
        let selector = EnvironmentRouteSelector(
            environment: Environment(id: "env-1", label: "Desk", routes: [lan, relay]),
            probe: { url, _ -> String? in url.host == "192.168.1.4" ? nil : "env-1" },
            preflight: { _ in true }
        )

        let used = try await selector.perform { routed -> String in
            let id = routed.routes[0].id
            if id == lan.id { throw URLError(.notConnectedToInternet) }
            return id
        }
        XCTAssertEqual(used, relay.id)

        do {
            _ = try await selector.perform { _ -> String in
                throw HTTPError.status(404, message: "Missing", traceID: nil)
            }
            XCTFail("A request error is not a route failure.")
        } catch let error as HTTPError {
            guard case .status(404, _, _) = error else { return XCTFail("Unexpected \(error)") }
        }
    }

    // MARK: - Learning through the runtime

    func testRuntimeSavesLearnedRoutesWithoutTouchingCredentials() async throws {
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        let relay = Environment(
            id: "env-1",
            label: "Desk",
            httpBaseURL: URL(string: "https://relay.example/e/env-1/")!,
            webSocketBaseURL: URL(string: "wss://relay.example/e/env-1/")!,
            kind: .managedDPoP
        )
        try await store.save([relay])
        let credentials = InMemoryCredentialStore()
        let runtime = EnvironmentRuntime(environmentStore: store, credentialStore: credentials)

        await runtime.learnRoutes(
            environmentID: "env-1",
            activeRoute: relay.routes[0],
            reported: [ServerDirectEndpoint(kind: .lan, httpBaseUrl: "http://192.168.1.4:3773/")]
        )

        let saved = try await store.load()
        XCTAssertEqual(saved[0].routes.map(\.label), ["LAN", "T3 Connect"])
        XCTAssertEqual(saved[0].routes[0].credentialID, "env-1")
        XCTAssertTrue(saved[0].routes[0].learned)
    }

    func testServerConfigDropsDirectEndpointsItCannotRead() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/serverConfigDirectEndpoints.json")
        let config = try JSONDecoder.t3.decode(
            ServerConfigSnapshot.self,
            from: Data(contentsOf: fixture)
        )
        XCTAssertEqual(config.directEndpoints?.map(\.kind), [.lan, .tailnet])
        XCTAssertEqual(
            config.directEndpoints?.map(\.httpBaseUrl),
            ["http://192.168.1.20:3773/", "https://studio.tailnet.ts.net/"]
        )

        let older = try JSONDecoder.t3.decode(
            ServerConfigSnapshot.self,
            from: Data(#"{"providers":[]}"#.utf8)
        )
        XCTAssertNil(older.directEndpoints)
    }

    private func route(
        _ url: String,
        kind: EnvironmentKind = .bearer,
        credentialID: String = "env-1"
    ) -> EnvironmentRoute {
        let httpBaseURL = URL(string: url)!
        return EnvironmentRoute.saved(
            httpBaseURL: httpBaseURL,
            webSocketBaseURL: EnvironmentRoutes.webSocketBaseURL(for: httpBaseURL)!,
            kind: kind,
            credentialID: credentialID
        )
    }
}

private actor RouteAttempts {
    private(set) var ids: [String] = []

    func append(_ id: String) {
        ids.append(id)
    }
}

private actor RouteSwitch {
    private(set) var isOn = false

    func turnOn() {
        isOn = true
    }
}

/// Answers the descriptor, token exchange, and session endpoints for one
/// environment, recording every request.
private actor RouteTestTransport: HTTPTransport {
    private let descriptorEnvironmentID: String
    private let issuedToken: String
    private(set) var requests: [URLRequest] = []

    init(descriptorEnvironmentID: String, issuedToken: String = "token") {
        self.descriptorEnvironmentID = descriptorEnvironmentID
        self.issuedToken = issuedToken
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let body: String
        switch request.url?.path {
        case "/.well-known/t3/environment":
            body = """
            {"environmentId":"\(descriptorEnvironmentID)","label":"Desk",
             "platform":{"os":"darwin","arch":"arm64"},"serverVersion":"1.0.0","capabilities":{}}
            """
        case "/oauth/token":
            body = """
            {"access_token":"\(issuedToken)","issued_token_type":"urn:ietf:params:oauth:token-type:access_token",
             "token_type":"Bearer","expires_in":3600,"scope":"orchestration:read"}
            """
        case "/api/auth/session":
            body = #"{"authenticated":true}"#
        default:
            body = "{}"
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (Data(body.utf8), response)
    }
}
