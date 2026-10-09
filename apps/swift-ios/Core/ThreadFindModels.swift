import Foundation

// Mirrors `OrchestrationV2SearchThreadInput` / `OrchestrationV2SearchThreadResult`
// in packages/contracts/src/orchestrationV2.ts (`orchestration.searchThread`
// and `orchestration.searchThreadStream`): find in one thread.
//
// An entry id is the message id for user and assistant messages and the turn
// item id for proposed plans; an occurrence counts matches within that entry.

/// An entry identity and the occurrence within it, which relative navigation
/// starts from so updates before it do not shift the selection.
public struct ThreadFindStart: Codable, Equatable, Hashable, Sendable {
    public let entryId: String
    public let occurrence: Int

    public init(entryId: String, occurrence: Int) {
        self.entryId = entryId
        self.occurrence = occurrence
    }
}

/// A skill label the transcript displays, so `$skill` tokens match as rendered.
public struct ThreadFindSkillLabel: Codable, Equatable, Hashable, Sendable {
    public let name: String
    public let displayName: String?

    public init(name: String, displayName: String?) {
        self.name = name
        self.displayName = displayName
    }
}

/// Everything in the request except the thread, which the route supplies as
/// its wire id. `index` wins over `start` + `offset`.
public struct ThreadFindQuery: Equatable, Hashable, Sendable {
    public static let maxQueryLength = 200
    static let maxSkillLabelLength = 200
    static let maxSkillCount = 1_000

    public let query: String
    public var skills: [ThreadFindSkillLabel] = []
    public var index: Int? = nil
    public var start: ThreadFindStart? = nil
    public var offset: Int = 0

    /// Nil for a query the server would reject: empty once trimmed. Longer
    /// queries keep their first 200 characters, as the web field's limit does.
    public init?(
        query: String,
        skills: [ThreadFindSkillLabel] = [],
        index: Int? = nil,
        start: ThreadFindStart? = nil,
        offset: Int = 0
    ) {
        let trimmed = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxQueryLength))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        self.query = trimmed
        // Labels past the contract's limits would fail the whole request.
        self.skills = Array(skills.filter {
            $0.name.count <= Self.maxSkillLabelLength && ($0.displayName?.count ?? 0) <= Self.maxSkillLabelLength
        }.prefix(Self.maxSkillCount))
        self.index = index.map { max(0, $0) }
        self.start = start
        self.offset = offset
    }

    /// The wire payload. Optional keys are omitted rather than sent as null,
    /// matching the contract's `optionalKey` fields.
    public func payload(threadID: String) -> JSONValue {
        var fields: [String: JSONValue] = [
            "threadId": .string(threadID),
            "query": .string(query),
            "skills": .array(skills.map { skill in
                var label: [String: JSONValue] = ["name": .string(skill.name)]
                if let displayName = skill.displayName { label["displayName"] = .string(displayName) }
                return .object(label)
            }),
        ]
        if let index { fields["index"] = .integer(Int64(index)) }
        if let start {
            fields["start"] = .object([
                "entryId": .string(start.entryId),
                "occurrence": .integer(Int64(start.occurrence)),
            ])
        }
        if offset != 0 { fields["offset"] = .integer(Int64(offset)) }
        return .object(fields)
    }
}

/// One occurrence of the query inside a searchable timeline entry.
public struct ThreadFindMatch: Codable, Equatable, Hashable, Sendable {
    public let entryId: String
    /// The turn to expand when the matching entry is folded.
    public let runId: String?
    /// Zero-based occurrence within this entry.
    public let occurrence: Int

    public init(entryId: String, runId: String?, occurrence: Int) {
        self.entryId = entryId
        self.runId = runId
        self.occurrence = occurrence
    }
}

/// Counts and identities around the selection, so a client steps without
/// another round trip.
public struct ThreadFindNavigationEntry: Codable, Equatable, Hashable, Sendable {
    public let entryId: String
    public let runId: String?
    public let startIndex: Int
    public let count: Int

    public init(entryId: String, runId: String?, startIndex: Int, count: Int) {
        self.entryId = entryId
        self.runId = runId
        self.startIndex = startIndex
        self.count = count
    }
}

public struct ThreadFindResult: Codable, Equatable, Sendable {
    /// Omitted by older servers. `false` marks the progressive stream's early
    /// frame: a match with no final ordinal or total yet.
    public let complete: Bool?
    public let snapshotSequence: Int
    public let totalMatches: Int
    public let activeIndex: Int
    public let match: ThreadFindMatch?
    public let navigation: [ThreadFindNavigationEntry]?

    public init(
        complete: Bool? = nil,
        snapshotSequence: Int,
        totalMatches: Int,
        activeIndex: Int,
        match: ThreadFindMatch?,
        navigation: [ThreadFindNavigationEntry]? = nil
    ) {
        self.complete = complete
        self.snapshotSequence = snapshotSequence
        self.totalMatches = totalMatches
        self.activeIndex = activeIndex
        self.match = match
        self.navigation = navigation
    }

    /// Still counting: the early frame of a progressive search.
    public var isCounting: Bool { complete == false }
}
