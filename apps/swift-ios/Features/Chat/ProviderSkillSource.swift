import Foundation

// Ported from packages/client-runtime/src/providerSkills.ts.
//
// Skills reach the composer from four different places — a plugin the app
// installed, the repo, the user's own directory, the machine — and the popover
// showed one crate icon for all of them. Where a skill came from is the thing
// that tells two similarly named entries apart, so it earns the icon slot.

/// Where a provider skill was discovered.
public enum ProviderSkillSourceKind: String, Sendable, Equatable, CaseIterable {
    case app
    case repo
    case project
    case personal
    case system
    case other
}

public enum ProviderSkillSource {
    /// Plugin caches the app manages on the user's behalf. These live under the
    /// user's home directory and would otherwise read as `personal`, so the path
    /// check runs before the scope switch.
    private static let pluginPathFragments = ["/.codex/plugins/", "/.agents/plugins/"]

    public static func kind(path: String, scope: String?) -> ProviderSkillSourceKind {
        let normalizedPath = path.replacingOccurrences(of: "\\", with: "/")
        if pluginPathFragments.contains(where: { normalizedPath.contains($0) }) {
            return .app
        }

        switch scope?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "repo", "repository": return .repo
        case "project", "workspace", "local": return .project
        case "user", "personal": return .personal
        case "system": return .system
        default: return .other
        }
    }

    /// SF Symbol for a source kind. `other` keeps the crate the popover used for
    /// every skill, so an unrecognised scope degrades to today's icon rather
    /// than to a blank slot.
    public static func symbolName(for kind: ProviderSkillSourceKind) -> String {
        switch kind {
        case .app: return "square.grid.2x2"
        case .repo, .project: return "folder"
        case .personal: return "person.crop.circle"
        case .system: return "gearshape"
        case .other: return "shippingbox"
        }
    }
}

extension FeatureProviderSkill {
    public var sourceKind: ProviderSkillSourceKind {
        ProviderSkillSource.kind(path: path, scope: scope)
    }

    public var sourceSymbolName: String {
        ProviderSkillSource.symbolName(for: sourceKind)
    }
}
