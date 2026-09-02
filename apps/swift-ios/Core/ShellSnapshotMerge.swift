import Foundation

/// Folds an incoming shell snapshot frame into the shell the client already holds.
///
/// Two very different frames share one wire shape, and only the presence of
/// `resolvedRepositoryIdentityRoots` tells them apart. An authoritative frame —
/// the HTTP snapshot, and the opening frame of a fresh subscription — carries
/// the whole shell and replaces it. An enrichment frame reports that repository
/// identity finished resolving for some workspace roots; it carries those
/// projects and deliberately empty thread lists, so replacing the shell with it
/// empties the sidebar.
///
/// This mirrors `mergeShellSnapshotProjects` in `@t3tools/client-runtime`, which
/// is what web and React Native run.
enum ShellSnapshotMerge {
    /// - Parameter resolvedRepositoryIdentityRoots: nil for an authoritative
    ///   frame; the resolved roots (possibly empty) for an enrichment refresh.
    static func merge(
        previous: OrchestrationV2ShellSnapshot?,
        next: OrchestrationV2ShellSnapshot,
        resolvedRepositoryIdentityRoots: [String]?
    ) -> OrchestrationV2ShellSnapshot {
        guard let previous else { return next }

        if let resolvedRepositoryIdentityRoots {
            let resolvedRoots = Set(resolvedRepositoryIdentityRoots)
            let candidates = index(next.projects)
            var merged = previous
            merged.projects = previous.projects.map { project in
                guard let candidate = candidates[project.id] else {
                    return project
                }
                // A project whose root moved is a different workspace now; its
                // identity has to come from an authoritative frame. Clear the
                // old root's identity while preserving the shell-owned row.
                guard candidate.workspaceRoot == project.workspaceRoot else {
                    return project.settingRepositoryIdentity(nil)
                }
                // A resolved root is authoritative about its own identity,
                // including having resolved to none.
                if resolvedRoots.contains(project.workspaceRoot) {
                    return project.settingRepositoryIdentity(candidate.repositoryIdentity)
                }
                guard project.repositoryIdentity == nil,
                      candidate.repositoryIdentity != nil else {
                    return project
                }
                return project.settingRepositoryIdentity(candidate.repositoryIdentity)
            }
            return merged
        }

        // Enrichment runs behind the snapshot, so an authoritative frame can
        // arrive with identity still cold. Keep what the same root already
        // resolved rather than dropping project grouping until it resolves again.
        let priorProjects = index(previous.projects)
        var merged = next
        merged.projects = next.projects.map { project in
            guard project.repositoryIdentity == nil,
                  let prior = priorProjects[project.id],
                  prior.repositoryIdentity != nil,
                  prior.workspaceRoot == project.workspaceRoot else {
                return project
            }
            return project.settingRepositoryIdentity(prior.repositoryIdentity)
        }
        return merged
    }

    private static func index(
        _ projects: [OrchestrationProject]
    ) -> [String: OrchestrationProject] {
        Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
    }
}

extension OrchestrationProject {
    func settingRepositoryIdentity(_ identity: RepositoryIdentity?) -> OrchestrationProject {
        OrchestrationProject(
            id: id,
            title: title,
            workspaceRoot: workspaceRoot,
            repositoryIdentity: identity,
            defaultModelSelection: defaultModelSelection,
            faviconPath: faviconPath,
            scripts: scripts,
            createdAt: createdAt,
            updatedAt: updatedAt,
            deletedAt: deletedAt
        )
    }
}
