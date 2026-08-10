import Foundation

// Ported from packages/contracts/src/usage.ts (contract version 3): the
// `server.getUsageSummary` shapes the web and Expo usage dashboards read.
// Providers travel as plain strings rather than a closed enum so a server that
// learns a new provider kind degrades to an unstyled series instead of a
// decode failure.

/// The usage contract this client understands. A summary reporting a different
/// version is excluded from merging (its semantics may have changed) and the
/// UI reports partial coverage instead of silently mixing incompatibles.
public let usageContractVersion = 3

/// Token totals for one bucket. `reasoningTokens` is a subset of
/// `outputTokens` (Codex reports it separately, Claude folds thinking into
/// output), so total-token math must never add it on top.
public struct UsageTokenTotals: Codable, Equatable, Sendable {
    public let uncachedInputTokens: Int
    public let cachedInputTokens: Int
    public let cacheCreationTokens: Int
    public let outputTokens: Int
    public let reasoningTokens: Int

    public init(
        uncachedInputTokens: Int,
        cachedInputTokens: Int,
        cacheCreationTokens: Int,
        outputTokens: Int,
        reasoningTokens: Int
    ) {
        self.uncachedInputTokens = uncachedInputTokens
        self.cachedInputTokens = cachedInputTokens
        self.cacheCreationTokens = cacheCreationTokens
        self.outputTokens = outputTokens
        self.reasoningTokens = reasoningTokens
    }

    /// All tokens the bucket processed. Excludes `reasoningTokens` because
    /// they are already inside `outputTokens`.
    public var totalTokens: Int {
        uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens
    }
}

/// One `(day, provider, model)` cell. `costUsd` is API-equivalent cost, not
/// money spent — subscription plans bill separately.
public struct UsageBucket: Codable, Equatable, Sendable {
    public let day: String
    public let provider: String
    public let model: String
    public let totals: UsageTokenTotals
    public let costUsd: Double
    public let cacheSavingsUsd: Double
    public let costSource: String
    public let records: Int
    public let unpricedRecords: Int
    public let sessions: Int

    public init(
        day: String,
        provider: String,
        model: String,
        totals: UsageTokenTotals,
        costUsd: Double,
        cacheSavingsUsd: Double,
        costSource: String,
        records: Int,
        unpricedRecords: Int,
        sessions: Int
    ) {
        self.day = day
        self.provider = provider
        self.model = model
        self.totals = totals
        self.costUsd = costUsd
        self.cacheSavingsUsd = cacheSavingsUsd
        self.costSource = costSource
        self.records = records
        self.unpricedRecords = unpricedRecords
        self.sessions = sessions
    }
}

/// Identity of one physical transcript directory. Multi-environment clients
/// dedupe on this before merging: two servers reading the same `~/.claude`
/// must not double count every token.
public struct UsageSourceFingerprint: Codable, Equatable, Sendable {
    public let hostId: String
    public let provider: String
    public let resolvedHomePath: String
    /// `device:inode` of the directory; empty when unreadable. This is what
    /// keeps two Macs that share a hostname and home path distinct.
    public let volumeId: String

    public init(hostId: String, provider: String, resolvedHomePath: String, volumeId: String) {
        self.hostId = hostId
        self.provider = provider
        self.resolvedHomePath = resolvedHomePath
        self.volumeId = volumeId
    }

    /// The dedupe key `packages/shared/usageMerge` uses, reproduced exactly.
    public var mergeKey: String {
        [hostId, provider, resolvedHomePath, volumeId].joined(separator: " ")
    }
}

public struct UsageSource: Codable, Equatable, Sendable {
    public let fingerprint: UsageSourceFingerprint
    /// `ok`, `missing`, `partial`, or `failed`.
    public let status: String
    public let scannedFiles: Int
    public let skippedFiles: Int
    public let malformedRecords: Int
    /// Distinct sessions in this directory. Summing per-bucket session counts
    /// instead would count a session once per day and model it spans.
    public let distinctSessions: Int
    public let message: String?

    public init(
        fingerprint: UsageSourceFingerprint,
        status: String,
        scannedFiles: Int,
        skippedFiles: Int,
        malformedRecords: Int,
        distinctSessions: Int,
        message: String?
    ) {
        self.fingerprint = fingerprint
        self.status = status
        self.scannedFiles = scannedFiles
        self.skippedFiles = skippedFiles
        self.malformedRecords = malformedRecords
        self.distinctSessions = distinctSessions
        self.message = message
    }
}

public struct UsagePricing: Codable, Equatable, Sendable {
    /// `fresh`, `cached`, or `unavailable`.
    public let status: String
    public let source: String
    public let fetchedAt: String?
    public let knownModels: Int

    public init(status: String, source: String, fetchedAt: String?, knownModels: Int) {
        self.status = status
        self.source = source
        self.fetchedAt = fetchedAt
        self.knownModels = knownModels
    }
}

public struct UsageSummary: Codable, Equatable, Sendable {
    public let contractVersion: Int
    public let readAt: String
    public let timeZone: String
    public let sinceDay: String
    public let untilDay: String
    public let buckets: [UsageBucket]
    public let sources: [UsageSource]
    public let pricing: UsagePricing
    public let scanDurationMs: Int

    public init(
        contractVersion: Int,
        readAt: String,
        timeZone: String,
        sinceDay: String,
        untilDay: String,
        buckets: [UsageBucket],
        sources: [UsageSource],
        pricing: UsagePricing,
        scanDurationMs: Int
    ) {
        self.contractVersion = contractVersion
        self.readAt = readAt
        self.timeZone = timeZone
        self.sinceDay = sinceDay
        self.untilDay = untilDay
        self.buckets = buckets
        self.sources = sources
        self.pricing = pricing
        self.scanDurationMs = scanDurationMs
    }
}
