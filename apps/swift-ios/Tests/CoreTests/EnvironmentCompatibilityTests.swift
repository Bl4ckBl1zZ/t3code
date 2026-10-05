import XCTest
@testable import T3Code

final class EnvironmentCompatibilityTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("environment-compatibility-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    func testAServerThatNamesNoProtocolIsCompatible() throws {
        XCTAssertNil(OrchestrationProtocol.compatibilityIssue(with: try descriptor(version: nil)))
        XCTAssertNil(OrchestrationProtocol.compatibilityIssue(
            with: try descriptor(version: OrchestrationProtocol.version)
        ))
    }

    func testANewerServerAsksForAnAppUpdate() throws {
        let issue = OrchestrationProtocol.compatibilityIssue(
            with: try descriptor(version: OrchestrationProtocol.version + 1)
        )

        XCTAssertEqual(issue?.reason, "This app is not supported by Desk. Update the app to connect.")
        XCTAssertEqual(issue?.serverUpdateRequired, false)
    }

    func testAnOlderServerOffersAnUpdateOnlyWhenItsDesktopAppTakesRemoteUpdates() throws {
        let older = OrchestrationProtocol.version - 1
        let desktop = OrchestrationProtocol.compatibilityIssue(
            with: try descriptor(version: older, selfUpdate: "desktop-managed", desktopAppUpdate: true)
        )
        let desktopWithoutRemoteUpdates = OrchestrationProtocol.compatibilityIssue(
            with: try descriptor(version: older, selfUpdate: "desktop-managed", desktopAppUpdate: false)
        )
        let npm = OrchestrationProtocol.compatibilityIssue(
            with: try descriptor(version: older, selfUpdate: "npm-global", desktopAppUpdate: nil)
        )

        XCTAssertEqual(desktop?.reason, "This app requires a newer server. Update T3 Code on Desk to connect.")
        XCTAssertEqual(desktop?.serverUpdateRequired, true)
        XCTAssertEqual(desktopWithoutRemoteUpdates?.serverUpdateRequired, false)
        XCTAssertEqual(npm?.serverUpdateRequired, false)
    }

    func testTheReasonPersistsAndOnlyANewAddressClearsIt() throws {
        var environment = environment("env-1")
        environment.unsupportedReason = "Too old"
        environment.serverUpdateRequired = true
        environment.isEnabled = false

        let decoded = try JSONDecoder().decode(
            Environment.self,
            from: JSONEncoder().encode(environment)
        )
        XCTAssertEqual(decoded, environment)

        let legacy = try JSONDecoder().decode(
            Environment.self,
            from: Data(
                #"""
                {"id":"env-1","label":"Desk","httpBaseURL":"http://192.168.1.4:3773/",
                 "webSocketBaseURL":"ws://192.168.1.4:3773/","kind":"bearer"}
                """#.utf8
            )
        )
        XCTAssertNil(legacy.unsupportedReason)
        XCTAssertFalse(legacy.serverUpdateRequired)

        // Learning an address keeps the verdict: it is the same server.
        let learned = EnvironmentRoute(
            id: "learned:http://100.101.102.103:3773",
            httpBaseURL: URL(string: "http://100.101.102.103:3773/")!,
            webSocketBaseURL: URL(string: "ws://100.101.102.103:3773/")!,
            kind: .bearer,
            credentialID: "env-1",
            learned: true
        )
        environment.routes = environment.routes + [learned]
        XCTAssertEqual(environment.unsupportedReason, "Too old")
        environment.routes = environment.routes.reversed()
        XCTAssertEqual(environment.unsupportedReason, "Too old")

        // A new saved address is checked again.
        environment.routes = EnvironmentRoutes.inserting(
            .saved(
                httpBaseURL: URL(string: "http://desk.tail1234.ts.net:3773/")!,
                webSocketBaseURL: URL(string: "ws://desk.tail1234.ts.net:3773/")!,
                kind: .bearer,
                credentialID: "env-1#tailnet"
            ),
            into: environment.routes
        )
        XCTAssertNil(environment.unsupportedReason)
        XCTAssertFalse(environment.serverUpdateRequired)
        XCTAssertFalse(environment.isEnabled)
    }

    func testMarkingAnEnvironmentIncompatibleSwitchesItOffAndMovesSelection() async throws {
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        try await store.save([environment("a"), environment("b")])
        try await store.setActiveEnvironment(id: "a")

        try await store.setCompatibility(
            id: "a",
            issue: EnvironmentCompatibilityIssue(reason: "Too old", serverUpdateRequired: true)
        )

        let saved = try await store.load()
        XCTAssertEqual(saved.map(\.isEnabled), [false, true])
        XCTAssertEqual(saved[0].unsupportedReason, "Too old")
        XCTAssertTrue(saved[0].serverUpdateRequired)
        let activeID = try await store.activeEnvironmentID()
        XCTAssertEqual(activeID, "b")

        // Clearing the verdict does not switch it back on by itself.
        try await store.setCompatibility(id: "a", issue: nil)
        let cleared = try await store.load()
        XCTAssertNil(cleared[0].unsupportedReason)
        XCTAssertFalse(cleared[0].isEnabled)
    }

    func testPairingAnOutdatedServerSavesItSwitchedOffWithTheReason() async throws {
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        let credentials = InMemoryCredentialStore()
        let transport = CompatibilityTestTransport(
            version: OrchestrationProtocol.version - 1,
            selfUpdate: "desktop-managed",
            desktopAppUpdate: true
        )
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: credentials,
            httpTransport: transport
        )
        var changes = runtime.compatibilityChanges.makeAsyncIterator()

        do {
            _ = try await runtime.pair(url: "http://192.168.1.4:3773/#token=pair-once")
            XCTFail("An outdated server must not connect.")
        } catch let error as EnvironmentIncompatibleError {
            XCTAssertTrue(error.issue.serverUpdateRequired)
        }

        let saved = try await store.load()
        XCTAssertEqual(saved.map(\.id), ["env-1"])
        XCTAssertFalse(saved[0].isEnabled)
        XCTAssertEqual(
            saved[0].unsupportedReason,
            "This app requires a newer server. Update T3 Code on Desk to connect."
        )
        XCTAssertTrue(saved[0].serverUpdateRequired)
        let activeID = try await store.activeEnvironmentID()
        XCTAssertNil(activeID)
        // The credential is kept, so updating the server needs no new pairing.
        let credential = await credentials.credential(for: "env-1")
        XCTAssertEqual(credential?.accessToken, "token")
        let announced = await changes.next()
        XCTAssertEqual(announced, "env-1")
    }

    func testSwitchingAnIncompatibleEnvironmentOnChecksTheServerAgain() async throws {
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        var outdated = environment("env-1")
        outdated.isEnabled = false
        outdated.unsupportedReason = "Too old"
        try await store.save([outdated])
        let transport = CompatibilityTestTransport(version: OrchestrationProtocol.version - 1)
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(),
            httpTransport: transport
        )

        do {
            try await runtime.setEnabled(id: "env-1", enabled: true)
            XCTFail("A server still on the old protocol must stay off.")
        } catch is EnvironmentIncompatibleError {}
        let stillOff = try await store.load()
        XCTAssertFalse(stillOff[0].isEnabled)
        XCTAssertEqual(
            stillOff[0].unsupportedReason,
            "This app requires a newer server. Update T3 Code on Desk to connect."
        )

        await transport.setVersion(OrchestrationProtocol.version)
        try await runtime.setEnabled(id: "env-1", enabled: true)

        let on = try await store.load()
        XCTAssertTrue(on[0].isEnabled)
        XCTAssertNil(on[0].unsupportedReason)
        XCTAssertFalse(on[0].serverUpdateRequired)
    }

    private func environment(_ id: String) -> Environment {
        Environment(
            id: id,
            label: "Desk",
            httpBaseURL: URL(string: "http://192.168.1.4:3773/")!,
            webSocketBaseURL: URL(string: "ws://192.168.1.4:3773/")!
        )
    }

    private func descriptor(
        version: Int?,
        selfUpdate: String? = nil,
        desktopAppUpdate: Bool? = nil
    ) throws -> EnvironmentDescriptor {
        try JSONDecoder().decode(
            EnvironmentDescriptor.self,
            from: Data(
                CompatibilityTestTransport.descriptorJSON(
                    version: version,
                    selfUpdate: selfUpdate,
                    desktopAppUpdate: desktopAppUpdate
                ).utf8
            )
        )
    }
}

/// Serves one environment's descriptor at a settable protocol version, and
/// the pairing token exchange.
private actor CompatibilityTestTransport: HTTPTransport {
    private var version: Int?
    private let selfUpdate: String?
    private let desktopAppUpdate: Bool?

    init(version: Int?, selfUpdate: String? = nil, desktopAppUpdate: Bool? = nil) {
        self.version = version
        self.selfUpdate = selfUpdate
        self.desktopAppUpdate = desktopAppUpdate
    }

    func setVersion(_ version: Int?) {
        self.version = version
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let body: String
        if request.url?.path == "/.well-known/t3/environment" {
            body = Self.descriptorJSON(
                version: version,
                selfUpdate: selfUpdate,
                desktopAppUpdate: desktopAppUpdate
            )
        } else if request.url?.path == "/oauth/token" {
            body = """
            {"access_token":"token","issued_token_type":"urn:ietf:params:oauth:token-type:access_token",
             "token_type":"Bearer","expires_in":3600,"scope":"orchestration:read"}
            """
        } else {
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

    static func descriptorJSON(version: Int?, selfUpdate: String?, desktopAppUpdate: Bool?) -> String {
        var capabilities: [String] = []
        if let selfUpdate { capabilities.append(#""serverSelfUpdate":"\#(selfUpdate)""#) }
        if let desktopAppUpdate { capabilities.append(#""desktopAppUpdate":\#(desktopAppUpdate)"#) }
        let versionField = version.map { #","orchestrationProtocolVersion":\#($0)"# } ?? ""
        return """
        {"environmentId":"env-1","label":"Desk","platform":{"os":"darwin","arch":"arm64"},
         "serverVersion":"1.0.0","capabilities":{\(capabilities.joined(separator: ","))}\(versionField)}
        """
    }
}
