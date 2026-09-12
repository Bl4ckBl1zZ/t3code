import Foundation
import Testing
@testable import T3Code

struct NewTaskLoadBalancingTests {
    private func provider(driver: String = "codex", model: String = "gpt-5", authenticated: Bool = true) throws -> ServerProviderSnapshot {
        let json: [String: Any] = ["instanceId": "personal", "driver": driver,
            "enabled": true, "installed": true, "status": "ready", "checkedAt": "2026-09-12T00:00:00Z",
            "auth": ["status": authenticated ? "authenticated" : "unauthenticated"],
            "models": [["slug": model, "name": model, "isCustom": false]]]
        return try JSONDecoder().decode(ServerProviderSnapshot.self, from: JSONSerialization.data(withJSONObject: json))
    }

    @Test func matchesRepositoryAndReadyAccountInsteadOfNamesOrPaths() throws {
        let anchor = FeatureProject(id: "one", environmentID: "a", name: "Repo", path: "/repo", repositoryCanonicalKey: "github:owner/repo")
        let other = FeatureProject(id: "two", environmentID: "b", name: "Repo", path: "/repo", repositoryCanonicalKey: "github:other/repo")
        let matching = FeatureProject(id: "three", environmentID: "c", name: "Different label", path: "/elsewhere", repositoryCanonicalKey: anchor.repositoryCanonicalKey)
        let environments = ["a", "b", "c"].map { FeatureEnvironment(id: $0, name: $0, endpoint: "", connectionState: .connected) }
        let ready = try provider()
        let configs = environments.map { MobileWorkspaceEnvironmentConfig(environmentID: $0.id, t3WorkDirectory: nil, providers: [ready]) }
        let selection = FeatureSelection(providerID: "personal", modelID: "gpt-5")
        let candidates = NewTaskLoadBalancing.candidates(anchor: anchor, projects: [anchor, other, matching], environments: environments,
            activeConnection: .connected, configs: configs, selection: selection, driver: "codex", weights: [:])
        #expect(candidates.map(\.id) == ["one", "three"])
        var unknown = anchor
        unknown.repositoryCanonicalKey = nil
        #expect(NewTaskLoadBalancing.candidates(anchor: unknown, projects: [unknown, other, matching], environments: environments,
            activeConnection: .connected, configs: configs, selection: selection, driver: "codex", weights: [:]).map(\.id) == ["one"])
    }

    @Test func excludesOfflineManualOnlyWrongDriverModelAndAuth() throws {
        let anchor = FeatureProject(id: "one", environmentID: "a", name: "Repo", path: "/repo")
        let selection = FeatureSelection(providerID: "personal", modelID: "gpt-5")
        let ready = try provider()
        let connected = FeatureEnvironment(id: "a", name: "A", endpoint: "", connectionState: .connected)
        for candidate in [try provider(driver: "claudeAgent"), try provider(model: "other"), try provider(authenticated: false)] {
            #expect(NewTaskLoadBalancing.candidates(anchor: anchor, projects: [anchor], environments: [connected], activeConnection: .connected,
                configs: [.init(environmentID: "a", t3WorkDirectory: nil, providers: [candidate])], selection: selection, driver: "codex", weights: [:]).isEmpty)
        }
        #expect(NewTaskLoadBalancing.candidates(anchor: anchor, projects: [anchor], environments: [connected], activeConnection: .connected,
            configs: [.init(environmentID: "a", t3WorkDirectory: nil, providers: [ready])], selection: selection, driver: "codex", weights: ["a": 0]).isEmpty)
        var offline = connected
        offline.connectionState = .disconnected
        #expect(NewTaskLoadBalancing.candidates(anchor: anchor, projects: [anchor], environments: [offline], activeConnection: .connected,
            configs: [.init(environmentID: "a", t3WorkDirectory: nil, providers: [ready])], selection: selection, driver: "codex", weights: [:]).isEmpty)
    }

    @Test func preferenceDecodingRetainsManualOnlyAndRejectsInvalidValues() {
        let weights = NativeLoadBalancingPreferences.weights(from: #"{"manual":0,"normal":50,"invalid":-1,"tooLarge":101}"#)
        #expect(weights == ["manual": 0, "normal": 50])
        #expect(NativeLoadBalancingPreferences.weights(from: NativeLoadBalancingPreferences.encoding(weights)) == weights)
        #expect(NativeLoadBalancingPreferences.weights(from: "broken").isEmpty)
    }
}
