import Foundation

public struct ServerProviderVersionAdvisory: Codable, Equatable, Sendable {
    public let status: String
    public let currentVersion: String?
    public let latestVersion: String?
    public let updateCommand: String?
    public let canUpdate: Bool
    /// The server can pin this installer to a specific version. Only servers
    /// that also accept `targetVersion` send it, so it gates "Install vX".
    public let canInstallVersion: Bool
    public let checkedAt: String?
    public let message: String?

    private enum CodingKeys: String, CodingKey { case status, currentVersion, latestVersion, updateCommand, canUpdate, canInstallVersion, checkedAt, message }
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        status = try values.decode(String.self, forKey: .status)
        currentVersion = try values.decodeIfPresent(String.self, forKey: .currentVersion)
        latestVersion = try values.decodeIfPresent(String.self, forKey: .latestVersion)
        updateCommand = try values.decodeIfPresent(String.self, forKey: .updateCommand)
        canUpdate = try values.decodeIfPresent(Bool.self, forKey: .canUpdate) ?? false
        canInstallVersion = try values.decodeIfPresent(Bool.self, forKey: .canInstallVersion) ?? false
        checkedAt = try values.decodeIfPresent(String.self, forKey: .checkedAt)
        message = try values.decodeIfPresent(String.self, forKey: .message)
    }
    public var offersUpdate: Bool { status == "behind_latest" && canUpdate && updateCommand != nil }
}

/// Whether the installed provider version is known to work with the server's
/// T3 Code release, from the model manifest's compatibility policies.
public struct ServerProviderCompatibilityAdvisory: Codable, Equatable, Sendable {
    /// `unknown`, `supported`, `graceful`, `unsupported` or `broken`; newer
    /// servers may add statuses, which read as unknown.
    public let status: String
    public let latestVersionStatus: String?
    public let message: String?
    public let recommendedVersion: String?
    public let recommendedRange: String?

    private enum CodingKeys: String, CodingKey { case status, latestVersionStatus, message, recommendedVersion, recommendedRange }
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        status = try values.decodeIfPresent(String.self, forKey: .status) ?? "unknown"
        latestVersionStatus = try values.decodeIfPresent(String.self, forKey: .latestVersionStatus)
        message = try values.decodeIfPresent(String.self, forKey: .message)
        recommendedVersion = try values.decodeIfPresent(String.self, forKey: .recommendedVersion)
        recommendedRange = try values.decodeIfPresent(String.self, forKey: .recommendedRange)
    }

    /// Unsupported and broken versions fail mid-turn, so they warn even when
    /// the provider reports ready.
    public var isIncompatible: Bool { status == "unsupported" || status == "broken" }
    public var latestIsIncompatible: Bool { latestVersionStatus == "unsupported" || latestVersionStatus == "broken" }

    /// Settings title, or nil when there is nothing to warn about.
    public var title: String? {
        switch status {
        case "graceful": "Limited support"
        case "unsupported": "Unsupported version"
        case "broken": "Known broken version"
        default: nil
        }
    }

    public var detail: String {
        if let message { return message }
        if let recommendation = recommendedVersion ?? recommendedRange { return "Use \(recommendation) for full support." }
        return "Update for full support."
    }
}

extension ServerProviderSnapshot {
    /// Updating to the latest version, unless policy marks that version incompatible.
    public var offersLatestUpdate: Bool {
        enabled && versionAdvisory?.offersUpdate == true && compatibilityAdvisory?.latestIsIncompatible != true
    }

    /// The version policy recommends, when this server's installer can pin it.
    public var installableRecommendedVersion: String? {
        guard enabled, let advisory = compatibilityAdvisory, advisory.title != nil,
              versionAdvisory?.canInstallVersion == true else { return nil }
        return advisory.recommendedVersion
    }

    /// The composer's warning for a selected provider on an incompatible version.
    public var incompatibleVersionWarning: String? {
        guard enabled, let advisory = compatibilityAdvisory, advisory.isIncompatible else { return nil }
        return advisory.detail
    }
}

public struct ServerProviderUpdateState: Codable, Equatable, Sendable {
    public let status: String
    public let startedAt: String?
    public let finishedAt: String?
    public let message: String?
    public let output: String?
    public var isActive: Bool { status == "queued" || status == "running" }
}
