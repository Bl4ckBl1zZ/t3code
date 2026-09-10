import Foundation

public struct AgentSessionProjectGit: Codable, Sendable, Equatable {
    public let remoteKey: String?
    public let repository: String?
}

public struct AgentSessionProjectCandidate: Decodable, Sendable, Equatable, Identifiable {
    public let path: String
    public let title: String
    public let projectId: String?
    public let sources: [String]
    public let threadCount: Int
    public let lastActiveAt: String?
    public let alreadyImported: Bool
    public let git: AgentSessionProjectGit?
    public let reportsGitIdentity: Bool
    public var id: String { path }

    enum CodingKeys: String, CodingKey { case path, title, projectId, sources, threadCount, lastActiveAt, alreadyImported, git }
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        path = try values.decode(String.self, forKey: .path)
        title = try values.decode(String.self, forKey: .title)
        projectId = try values.decodeIfPresent(String.self, forKey: .projectId)
        sources = try values.decode([String].self, forKey: .sources)
        threadCount = try values.decode(Int.self, forKey: .threadCount)
        lastActiveAt = try values.decodeIfPresent(String.self, forKey: .lastActiveAt)
        alreadyImported = try values.decode(Bool.self, forKey: .alreadyImported)
        reportsGitIdentity = values.contains(.git)
        git = try values.decodeIfPresent(AgentSessionProjectGit.self, forKey: .git)
    }

    public func selectedByDefault(now: Date = .now) -> Bool {
        guard (!reportsGitIdentity || git != nil), threadCount >= 3,
              let lastActiveAt, let date = Self.activityDate(lastActiveAt) else { return false }
        return date <= now && date >= now.addingTimeInterval(-30 * 86_400)
    }

    public static func activityDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}

public struct AgentSessionScanResult: Decodable, Sendable, Equatable {
    public let candidates: [AgentSessionProjectCandidate]
    public let scannedAt: String
    public let truncated: Bool?
}

public struct AgentSessionImportResult: Codable, Sendable, Equatable {
    public let importedCount: Int
    public let skippedCount: Int
}
