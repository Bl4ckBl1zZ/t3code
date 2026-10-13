import Foundation

/// Resolves a prompt link against what this client knows: which thread a pull
/// request link reopens, which project a repository names, which machine a
/// prompt without a project starts on, and which model a link may pick.
/// Ports packages/client-runtime/src/promptLinks.ts; the UI that acts on it
/// lives in `PlatformRootView`.
enum PromptLinkResolution {
    /// The most recently updated thread linked to the pull request, across
    /// every environment.
    static func pullRequestThread(in threads: [FeatureThread], pullRequest: PromptLinks.PullRequest) -> FeatureThread? {
        let identity = "github.com/\(pullRequest.repository.displayName.lowercased())#\(pullRequest.number)"
        return threads
            .filter { thread in
                !thread.isArchived && thread.allLinkedPullRequests.contains {
                    $0.source != "stack-dismissed" && $0.identity == identity
                }
            }
            .max { $0.updatedAt < $1.updatedAt }
    }

    /// The project a link's repository names, most recently active first so
    /// the user lands where they last worked. A fork only matches its own
    /// owner, not its upstream.
    static func project(
        for repository: PromptLinks.Repository,
        in projects: [FeatureProject],
        threads: [FeatureThread]
    ) -> FeatureProject? {
        let activity = lastActivity(byProjectIn: threads)
        return projects
            .filter { ($0.repositoryGroupingKey ?? $0.repositoryCanonicalKey)?.lowercased() == repository.canonicalKey }
            .max { (activity[$0.id] ?? .distantPast) < (activity[$1.id] ?? .distantPast) }
    }

    /// Environments by their latest thread, scratch threads included.
    static func environmentsByRecentActivity(_ threads: [FeatureThread]) -> [String] {
        var latest: [String: Date] = [:]
        for thread in threads {
            guard let environmentID = thread.environmentID else { continue }
            latest[environmentID] = max(latest[environmentID] ?? .distantPast, activityDate(thread))
        }
        return latest.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.map(\.key)
    }

    /// The instances a link may pick in `project`, minus those the project
    /// turned off.
    static func providerCandidates(
        _ providers: [ServerProviderSnapshot],
        project: FeatureProject
    ) -> [PromptLinks.ProviderCandidate] {
        providers
            .filter { !(project.providerInstancesOff?.contains($0.instanceId) ?? false) }
            .map { provider in
                PromptLinks.ProviderCandidate(
                    instanceID: provider.instanceId,
                    driver: provider.driver,
                    enabled: provider.enabled,
                    availability: provider.availability,
                    status: provider.status,
                    models: provider.models.map {
                        .init(slug: $0.slug, name: $0.name, aliases: $0.aliases ?? [], isDefault: $0.isDefault ?? false)
                    }
                )
            }
    }

    /// The draft text a link fills. iOS opens a pull request link as a draft
    /// in the repository's project rather than checking the pull request out,
    /// so the pull request's URL rides along in the prompt.
    static func draftText(prompt: PromptLinks.LinkedPrompt?, pullRequest: PromptLinks.PullRequest?) -> String {
        [prompt?.text, pullRequest?.url].compactMap { $0 }.joined(separator: "\n\n")
    }

    private static func activityDate(_ thread: FeatureThread) -> Date {
        max(thread.lastActivityAt ?? thread.updatedAt, thread.updatedAt)
    }

    private static func lastActivity(byProjectIn threads: [FeatureThread]) -> [String: Date] {
        threads.reduce(into: [:]) { latest, thread in
            latest[thread.projectID] = max(latest[thread.projectID] ?? .distantPast, activityDate(thread))
        }
    }
}
