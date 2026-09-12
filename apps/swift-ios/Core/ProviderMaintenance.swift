import Foundation

public struct ServerProviderVersionAdvisory: Codable, Equatable, Sendable {
    public let status: String
    public let currentVersion: String?
    public let latestVersion: String?
    public let updateCommand: String?
    public let canUpdate: Bool
    public let checkedAt: String?
    public let message: String?

    private enum CodingKeys: String, CodingKey { case status, currentVersion, latestVersion, updateCommand, canUpdate, checkedAt, message }
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        status = try values.decode(String.self, forKey: .status)
        currentVersion = try values.decodeIfPresent(String.self, forKey: .currentVersion)
        latestVersion = try values.decodeIfPresent(String.self, forKey: .latestVersion)
        updateCommand = try values.decodeIfPresent(String.self, forKey: .updateCommand)
        canUpdate = try values.decodeIfPresent(Bool.self, forKey: .canUpdate) ?? false
        checkedAt = try values.decodeIfPresent(String.self, forKey: .checkedAt)
        message = try values.decodeIfPresent(String.self, forKey: .message)
    }
    public var offersUpdate: Bool { status == "behind_latest" && canUpdate && updateCommand != nil }
}

public struct ServerProviderUpdateState: Codable, Equatable, Sendable {
    public let status: String
    public let startedAt: String?
    public let finishedAt: String?
    public let message: String?
    public let output: String?
    public var isActive: Bool { status == "queued" || status == "running" }
}
