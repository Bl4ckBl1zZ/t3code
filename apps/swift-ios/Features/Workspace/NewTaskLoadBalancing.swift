import Foundation

/// Client-local preferences: each device can choose its own automatic-routing policy.
enum NativeLoadBalancingPreferences {
    static let enabledKey = "t3.loadBalancing.enabled"
    static let weightsKey = "t3.loadBalancing.weights"

    static func weights(from value: String) -> [String: Double] {
        guard let data = value.data(using: .utf8),
              let values = try? JSONDecoder().decode([String: Double].self, from: data) else { return [:] }
        return values.filter { !$0.key.isEmpty && $0.value.isFinite && (0...100).contains($0.value) }
    }

    static func encoding(_ values: [String: Double]) -> String {
        guard let data = try? JSONEncoder().encode(values) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

enum NewTaskLoadBalancing {
    /// Matching names and paths on different machines do not prove repository identity.
    static func candidates(
        anchor: FeatureProject,
        projects: [FeatureProject],
        environments: [FeatureEnvironment],
        activeConnection: FeatureConnection.State,
        configs: [MobileWorkspaceEnvironmentConfig],
        selection: FeatureSelection,
        driver: String,
        weights: [String: Double]
    ) -> [FeatureProject] {
        var seen = Set<String>()
        return ([anchor] + projects.filter { $0.id != anchor.id }).filter { project in
            guard project.id == anchor.id || (
                anchor.repositoryCanonicalKey?.isEmpty == false
                && project.repositoryCanonicalKey == anchor.repositoryCanonicalKey
            ), let environment = environments.first(where: { $0.id == project.environmentID }),
            (environment.isActive ? activeConnection : environment.connectionState) == .connected,
            (weights[environment.id] ?? 50) > 0,
            let config = configs.first(where: { $0.environmentID == environment.id }),
            config.providers.contains(where: { provider in
                provider.instanceId == selection.providerID && provider.driver == driver
                    && provider.enabled && provider.installed && provider.status != "error"
                    && provider.auth.status != "unauthenticated" && provider.availability != "unavailable"
                    && provider.models.contains { $0.slug == selection.modelID || $0.aliases?.contains(selection.modelID) == true }
            }) else { return false }
            return seen.insert(environment.id).inserted
        }
    }
}
