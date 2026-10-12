import Foundation

// Guided reviews, as `packages/contracts/src/pullRequestReviewGuide.ts` reports
// them over `pullRequests.reviewGuide` and `pullRequests.generateReviewGuide`.
// A guide is a tour of stops through a change, each with the code that
// carries its idea. `modelSelection` is not read by this client and is skipped.

/// The one call a maintainer should make at a stop. `kind` stays a string so a
/// kind this build predates still shows its note.
public struct PullRequestReviewGuideAttention: Codable, Equatable, Sendable {
    public let kind: String
    public let note: String
}

/// Lines worth reading, always inside the change. Line numbers are on `side`
/// (`new` or `old`).
public struct PullRequestReviewGuideExcerpt: Codable, Equatable, Hashable, Sendable {
    public let path: String
    public let side: String
    public let start: Int
    public let end: Int
    public let caption: String
}

/// An explanation anchored on one line inside one of its stop's excerpts.
public struct PullRequestReviewGuideNote: Codable, Equatable, Sendable {
    public let path: String
    public let line: Int
    public let title: String
    public let body: String
}

public struct PullRequestReviewGuideStop: Codable, Equatable, Sendable {
    public struct File: Codable, Equatable, Sendable {
        public let path: String
        public let note: String?
    }

    public let title: String
    public let summary: String
    public let attention: PullRequestReviewGuideAttention?
    public let excerpts: [PullRequestReviewGuideExcerpt]
    /// Changed files the tour never excerpts, each listed by one stop.
    public let files: [File]
    public let notes: [PullRequestReviewGuideNote]
    public let questions: [String]

    public init(
        title: String,
        summary: String = "",
        attention: PullRequestReviewGuideAttention? = nil,
        excerpts: [PullRequestReviewGuideExcerpt] = [],
        files: [File] = [],
        notes: [PullRequestReviewGuideNote] = [],
        questions: [String] = []
    ) {
        self.title = title
        self.summary = summary
        self.attention = attention
        self.excerpts = excerpts
        self.files = files
        self.notes = notes
        self.questions = questions
    }
}

public struct PullRequestReviewGuide: Codable, Equatable, Sendable {
    /// The head the guide was written against. A different head means the guide is stale.
    public let headSha: String
    public let generatedAt: String
    public let stops: [PullRequestReviewGuideStop]
}

/// A guide run in progress, or the last one that failed. A finished run
/// leaves only the guide.
public enum PullRequestReviewGuideRun: Codable, Equatable, Sendable {
    case running(headSha: String, startedAt: String)
    case failed(headSha: String, failedAt: String, detail: String)

    private enum CodingKeys: String, CodingKey {
        case tag = "_tag", headSha, startedAt, failedAt, detail
    }

    public var headSha: String {
        switch self {
        case let .running(headSha, _), let .failed(headSha, _, _): headSha
        }
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let headSha = try container.decode(String.self, forKey: .headSha)
        switch try container.decode(String.self, forKey: .tag) {
        case "Running":
            self = .running(headSha: headSha, startedAt: try container.decode(String.self, forKey: .startedAt))
        case "Failed":
            self = .failed(
                headSha: headSha,
                failedAt: try container.decode(String.self, forKey: .failedAt),
                detail: try container.decode(String.self, forKey: .detail)
            )
        case let tag:
            throw DecodingError.dataCorruptedError(forKey: .tag, in: container, debugDescription: "Unknown guide run \(tag)")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(headSha, forKey: .headSha)
        switch self {
        case let .running(_, startedAt):
            try container.encode("Running", forKey: .tag)
            try container.encode(startedAt, forKey: .startedAt)
        case let .failed(_, failedAt, detail):
            try container.encode("Failed", forKey: .tag)
            try container.encode(failedAt, forKey: .failedAt)
            try container.encode(detail, forKey: .detail)
        }
    }
}

/// The stored guide for a pull request and the head it is now at.
public struct PullRequestReviewGuideResult: Codable, Equatable, Sendable {
    public let guide: PullRequestReviewGuide?
    public let run: PullRequestReviewGuideRun?
    /// Nil where the host did not report a head with the detail.
    public let currentHeadSha: String?
}
