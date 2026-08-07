import XCTest

@testable import T3Code

/// The import that keeps existing TestFlight testers paired when this app takes
/// over `com.t3code.dev` from the React Native client.
///
/// The catalog JSON here mirrors `ConnectionCatalogDocument` in
/// `packages/client-runtime/src/platform/storageDocument.ts`. If that schema
/// changes, this fixture — and the importer — has to follow, or an update will
/// silently drop everyone's saved servers.
final class LegacyReactNativeImportTests: XCTestCase {
    private func catalog(_ json: String) -> Data { Data(json.utf8) }

    private let twoBearerServers = """
    {
      "schemaVersion": 1,
      "targets": [
        {"_tag":"BearerConnectionTarget","environmentId":"env-studio","label":"Studio","connectionId":"conn-studio"},
        {"_tag":"BearerConnectionTarget","environmentId":"env-laptop","label":"Laptop","connectionId":"conn-laptop"}
      ],
      "profiles": [
        {"_tag":"BearerConnectionProfile","connectionId":"conn-studio","environmentId":"env-studio","label":"Studio","httpBaseUrl":"https://studio.example","wsBaseUrl":"wss://studio.example"},
        {"_tag":"BearerConnectionProfile","connectionId":"conn-laptop","environmentId":"env-laptop","label":"Laptop","httpBaseUrl":"https://laptop.example","wsBaseUrl":"wss://laptop.example"}
      ],
      "credentials": [
        {"connectionId":"conn-studio","credential":{"_tag":"BearerConnectionCredential","token":"studio-token"}},
        {"connectionId":"conn-laptop","credential":{"_tag":"BearerConnectionCredential","token":"laptop-token"}}
      ],
      "remoteDpopTokens": []
    }
    """

    private func makeStore() -> EnvironmentStore {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("environments.json", isDirectory: false)
        return EnvironmentStore(fileURL: url)
    }

    func testImportsBearerServersWithTheirTokens() async throws {
        let store = makeStore()
        let credentials = InMemoryCredentialStore()

        let outcome = await LegacyReactNativeImport.run(
            environmentStore: store,
            credentialStore: credentials,
            readCatalog: { self.catalog(self.twoBearerServers) }
        )

        XCTAssertEqual(outcome, .imported(count: 2))

        let environments = try await store.load()
        XCTAssertEqual(environments.map(\.id).sorted(), ["env-laptop", "env-studio"])

        let studio = try XCTUnwrap(environments.first { $0.id == "env-studio" })
        XCTAssertEqual(studio.label, "Studio")
        XCTAssertEqual(studio.httpBaseURL.absoluteString, "https://studio.example")
        XCTAssertEqual(studio.webSocketBaseURL.absoluteString, "wss://studio.example")
        XCTAssertEqual(studio.kind, .bearer)

        // Without the token the server would appear in the list but fail to
        // connect, which is worse than not importing it at all.
        let credential = try await credentials.credential(for: "env-studio")
        XCTAssertEqual(credential?.accessToken, "studio-token")
        let laptop = try await credentials.credential(for: "env-laptop")
        XCTAssertEqual(laptop?.accessToken, "laptop-token")
    }

    func testDoesNotOverwriteServersAddedInThisApp() async throws {
        let store = makeStore()
        try await store.save([
            Environment(
                id: "env-native",
                label: "Native",
                httpBaseURL: URL(string: "https://native.example")!,
                webSocketBaseURL: URL(string: "wss://native.example")!
            ),
        ])

        let outcome = await LegacyReactNativeImport.run(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(),
            readCatalog: { self.catalog(self.twoBearerServers) }
        )

        XCTAssertEqual(outcome, .skippedExistingCatalog)
        let environments = try await store.load()
        XCTAssertEqual(environments.map(\.id), ["env-native"])
    }

    func testFreshInstallWithNoLegacyDataIsANoOp() async throws {
        let store = makeStore()
        let outcome = await LegacyReactNativeImport.run(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(),
            readCatalog: { nil }
        )

        XCTAssertEqual(outcome, .noLegacyData)
        let environments = try await store.load()
        XCTAssertTrue(environments.isEmpty)
    }

    func testRelayServersAreSkippedRatherThanImportedWithoutCredentials() async throws {
        // Relay servers re-authorize through T3 Connect, so they carry no bearer
        // profile. Importing one as bearer would produce a row that can never
        // connect.
        let relayOnly = """
        {
          "schemaVersion": 1,
          "targets": [{"_tag":"RelayConnectionTarget","environmentId":"env-relay","label":"Relay"}],
          "profiles": [],
          "credentials": [],
          "remoteDpopTokens": []
        }
        """
        let store = makeStore()

        let outcome = await LegacyReactNativeImport.run(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(),
            readCatalog: { self.catalog(relayOnly) }
        )

        XCTAssertEqual(outcome, .noLegacyData)
    }

    func testMalformedCatalogDoesNotCrashTheLaunchPath() async throws {
        let store = makeStore()
        let outcome = await LegacyReactNativeImport.run(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(),
            readCatalog: { self.catalog("{ not json") }
        )

        XCTAssertEqual(outcome, .noLegacyData)
    }

    func testDuplicateProfilesForOneEnvironmentImportOnce() async throws {
        let duplicated = """
        {
          "schemaVersion": 1,
          "targets": [],
          "profiles": [
            {"_tag":"BearerConnectionProfile","connectionId":"conn-a","environmentId":"env-dup","label":"First","httpBaseUrl":"https://a.example","wsBaseUrl":"wss://a.example"},
            {"_tag":"BearerConnectionProfile","connectionId":"conn-b","environmentId":"env-dup","label":"Second","httpBaseUrl":"https://b.example","wsBaseUrl":"wss://b.example"}
          ],
          "credentials": [
            {"connectionId":"conn-a","credential":{"_tag":"BearerConnectionCredential","token":"token-a"}}
          ],
          "remoteDpopTokens": []
        }
        """
        let store = makeStore()

        let outcome = await LegacyReactNativeImport.run(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(),
            readCatalog: { self.catalog(duplicated) }
        )

        XCTAssertEqual(outcome, .imported(count: 1))
        let environments = try await store.load()
        XCTAssertEqual(environments.map(\.label), ["First"])
    }
}
