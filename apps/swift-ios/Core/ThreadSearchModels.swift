import Foundation

// Mirrors packages/contracts/src/threadSearch.ts (`orchestration.searchThreads`).

public enum ThreadSearchSource: String, Codable, Sendable {
    case user
    case assistant
}

/// One message the server matched. `snippet` is whitespace-collapsed and at
/// most 240 characters, windowed around the match with ellipses.
public struct ThreadSearchMatch: Codable, Equatable, Sendable {
    public let threadId: String
    public let projectId: String
    public let source: ThreadSearchSource
    public let snippet: String
    public let messageCreatedAt: String?

    public init(
        threadId: String,
        projectId: String,
        source: ThreadSearchSource,
        snippet: String,
        messageCreatedAt: String?
    ) {
        self.threadId = threadId
        self.projectId = projectId
        self.source = source
        self.snippet = snippet
        self.messageCreatedAt = messageCreatedAt
    }
}

public struct ThreadSearchResult: Codable, Equatable, Sendable {
    public let matches: [ThreadSearchMatch]
}
