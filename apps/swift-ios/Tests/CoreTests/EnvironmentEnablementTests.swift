import XCTest
@testable import T3Code

final class EnvironmentEnablementTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("environment-enablement-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    func testCatalogSavedBeforeTheSwitchDecodesAsOn() async throws {
        let catalogURL = directory.appendingPathComponent("environments.json")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(
            #"""
            {"version":1,"activeEnvironmentID":"env-1","environments":[
              {"id":"env-1","label":"Desk","httpBaseURL":"http://192.168.1.4:3773/",
               "webSocketBaseURL":"ws://192.168.1.4:3773/","kind":"bearer"}
            ]}
            """#.utf8
        ).write(to: catalogURL)

        let environments = try await EnvironmentStore(fileURL: catalogURL).load()

        XCTAssertEqual(environments.map(\.id), ["env-1"])
        XCTAssertTrue(environments[0].isEnabled)
    }

    func testSwitchingTheActiveEnvironmentOffMovesSelectionAndRoundTrips() async throws {
        let catalogURL = directory.appendingPathComponent("environments.json")
        let store = EnvironmentStore(fileURL: catalogURL)
        try await store.save([environment("a"), environment("b")])
        try await store.setActiveEnvironment(id: "a")

        try await store.setEnabled(id: "a", enabled: false)

        let reloaded = EnvironmentStore(fileURL: catalogURL)
        let saved = try await reloaded.load()
        XCTAssertEqual(saved.map(\.isEnabled), [false, true])
        let activeID = try await reloaded.activeEnvironmentID()
        XCTAssertEqual(activeID, "b")

        try await reloaded.setEnabled(id: "a", enabled: true)
        let reenabled = try await reloaded.load()
        XCTAssertEqual(reenabled.map(\.isEnabled), [true, true])
    }

    func testRuntimeNeverActivatesASwitchedOffEnvironmentAndKeepsItsCredential() async throws {
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        let credentials = InMemoryCredentialStore()
        try await store.save([environment("a"), environment("b")])
        try await store.setActiveEnvironment(id: "a")
        try await credentials.setCredential(EnvironmentCredential(accessToken: "token-a"), for: "a")
        let runtime = EnvironmentRuntime(environmentStore: store, credentialStore: credentials)

        try await runtime.setEnabled(id: "a", enabled: false)

        let active = try await runtime.activeEnvironment()
        XCTAssertEqual(active?.id, "b")
        do {
            _ = try await runtime.activate(id: "a")
            XCTFail("A switched-off environment must not activate.")
        } catch {}
        let credential = try await credentials.credential(for: "a")
        XCTAssertEqual(credential?.accessToken, "token-a")

        try await store.setEnabled(id: "b", enabled: false)
        let none = try await runtime.activeEnvironment()
        XCTAssertNil(none)
    }

    private func environment(_ id: String) -> Environment {
        Environment(
            id: id,
            label: id.uppercased(),
            httpBaseURL: URL(string: "http://\(id).local:3773/")!,
            webSocketBaseURL: URL(string: "ws://\(id).local:3773/")!
        )
    }
}
