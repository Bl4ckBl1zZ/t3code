import Foundation
import Testing
@testable import T3Code

@Suite("Synced model favorites")
struct ModelFavoritesContractTests {
    private struct Fixture: Decodable {
        let patch: JSONValue
        let seeded: ServerSettingsSnapshot
        let unseeded: ServerSettingsSnapshot
    }

    private func fixture() throws -> Fixture {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/modelFavorites.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    @Test func decodesSeededUnseededAndOlderServers() throws {
        let fixture = try fixture()
        #expect(fixture.seeded.syncsModelFavorites)
        #expect(fixture.seeded.favorites == [ModelFavorite(provider: "codex", model: "gpt-5.4")])
        #expect(fixture.unseeded.syncsModelFavorites)
        #expect(fixture.unseeded.favorites == nil)
        let older = try JSONDecoder().decode(
            ServerSettingsSnapshot.self,
            from: Data(#"{"defaultThreadEnvMode":"local","newWorktreesStartFromOrigin":true}"#.utf8)
        )
        #expect(!older.syncsModelFavorites)
        for settings in [fixture.seeded, fixture.unseeded, older] {
            let roundTrip = try JSONDecoder().decode(ServerSettingsSnapshot.self, from: JSONEncoder().encode(settings))
            #expect(roundTrip == settings)
        }
    }

    @Test func firstEditSeedsTheDeviceList() throws {
        let patch = ModelFavoritesSync.patch(
            id: "codex::gpt-5.4",
            isFavorite: false,
            server: nil,
            localStorage: "claudeAgent::claude-opus-4-6"
        )
        let expected = try fixture().patch
        #expect(patch?.json == expected)
        let seeded = ModelFavoritesSync.patch(id: "codex::gpt-5.4", isFavorite: true, server: [], localStorage: "a::b")
        #expect(seeded?.migrateModelFavorites == nil)
    }

    @Test func seedsOnlyAnUnseededSyncingServerWithALocalList() {
        let local = "codex::gpt-5.4\nclaudeAgent::opus"
        #expect(ModelFavoritesSync.seedPatch(syncs: true, server: nil, localStorage: local)?.migrateModelFavorites?.count == 2)
        #expect(ModelFavoritesSync.seedPatch(syncs: true, server: nil, localStorage: "") == nil)
        #expect(ModelFavoritesSync.seedPatch(syncs: true, server: [], localStorage: local) == nil)
        #expect(ModelFavoritesSync.seedPatch(syncs: false, server: nil, localStorage: local) == nil)
    }

    @Test func readsTheServerListOnceSeededWithPendingTogglesLaidOver() {
        let server = [ModelFavorite(provider: "codex", model: "gpt-5.4"), ModelFavorite(provider: "opencode", model: "a::b")]
        #expect(ModelFavoritesSync.ids(server: nil, localStorage: "x::y") == ["x::y"])
        #expect(ModelFavoritesSync.ids(server: server, localStorage: "x::y") == ["codex::gpt-5.4", "opencode::a::b"])
        #expect(ModelFavoritesSync.ids(
            server: server,
            localStorage: "",
            pending: ["codex::gpt-5.4": false, "claudeAgent::opus": true]
        ) == ["opencode::a::b", "claudeAgent::opus"])
        #expect(ModelFavoritesSync.favorite(id: "opencode::a::b") == ModelFavorite(provider: "opencode", model: "a::b"))
    }
}
