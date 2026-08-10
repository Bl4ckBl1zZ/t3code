import XCTest

@testable import T3Code

/// The merge rules ported from `packages/shared/usageMerge`: fingerprint
/// de-duplication, stale-contract exclusion, and total derivation.
final class UsageMergeTests: XCTestCase {
    func testWireMethodName() {
        XCTAssertEqual(RPCMethod.serverGetUsageSummary.rawValue, "server.getUsageSummary")
    }

    func testMergesTotalsAcrossEnvironments() {
        let merged = FeatureUsageMerge.merge([
            environment(id: "env-a", host: "host-a", cost: 2, tokens: 100, sessions: 3),
            environment(id: "env-b", host: "host-b", cost: 3, tokens: 50, sessions: 2),
        ])
        XCTAssertEqual(merged.costUsd, 5)
        XCTAssertEqual(merged.totalTokens, 150)
        XCTAssertEqual(merged.sessions, 5)
        XCTAssertEqual(merged.providers.count, 1)
        XCTAssertEqual(merged.daily.count, 1)
        XCTAssertEqual(merged.daily.first?.byProvider["claude"]?.totalTokens, 150)
        XCTAssertTrue(merged.duplicateSources.isEmpty)
    }

    func testDropsDuplicateTranscriptDirectories() {
        // Two environments reading the same physical directory: identical
        // fingerprints. The lower environment id claims it; the other's
        // buckets must not double count.
        let merged = FeatureUsageMerge.merge([
            environment(id: "env-b", host: "shared-host", cost: 2, tokens: 100, sessions: 3),
            environment(id: "env-a", host: "shared-host", cost: 2, tokens: 100, sessions: 3),
        ])
        XCTAssertEqual(merged.costUsd, 2)
        XCTAssertEqual(merged.totalTokens, 100)
        XCTAssertEqual(merged.sessions, 3)
        XCTAssertEqual(merged.duplicateSources.count, 1)
    }

    func testExcludesStaleContractVersions() {
        let merged = FeatureUsageMerge.merge([
            environment(id: "env-a", host: "host-a", cost: 2, tokens: 100, sessions: 1),
            environment(
                id: "env-old",
                host: "host-old",
                cost: 9,
                tokens: 900,
                sessions: 9,
                contractVersion: usageContractVersion - 1
            ),
        ])
        XCTAssertEqual(merged.costUsd, 2)
        XCTAssertEqual(merged.staleEnvironments, ["env-old"])
    }

    func testReasoningTokensAreNotAddedOnTopOfOutput() {
        let totals = UsageTokenTotals(
            uncachedInputTokens: 10,
            cachedInputTokens: 20,
            cacheCreationTokens: 5,
            outputTokens: 40,
            reasoningTokens: 30
        )
        XCTAssertEqual(totals.totalTokens, 75)
    }

    // MARK: - Fixtures

    private func environment(
        id: String,
        host: String,
        cost: Double,
        tokens: Int,
        sessions: Int,
        contractVersion: Int = usageContractVersion
    ) -> FeatureEnvironmentUsage {
        let fingerprint = UsageSourceFingerprint(
            hostId: host,
            provider: "claude",
            resolvedHomePath: "/Users/dev/.claude",
            volumeId: "1:2"
        )
        return FeatureEnvironmentUsage(
            environmentID: id,
            label: id,
            summary: UsageSummary(
                contractVersion: contractVersion,
                readAt: "2026-08-10T00:00:00.000Z",
                timeZone: "UTC",
                sinceDay: "2026-08-01",
                untilDay: "2026-08-10",
                buckets: [
                    UsageBucket(
                        day: "2026-08-05",
                        provider: "claude",
                        model: "claude-fable-5",
                        totals: UsageTokenTotals(
                            uncachedInputTokens: tokens,
                            cachedInputTokens: 0,
                            cacheCreationTokens: 0,
                            outputTokens: 0,
                            reasoningTokens: 0
                        ),
                        costUsd: cost,
                        cacheSavingsUsd: 0,
                        costSource: "modelPriced",
                        records: 1,
                        unpricedRecords: 0,
                        sessions: sessions
                    )
                ],
                sources: [
                    UsageSource(
                        fingerprint: fingerprint,
                        status: "ok",
                        scannedFiles: 1,
                        skippedFiles: 0,
                        malformedRecords: 0,
                        distinctSessions: sessions,
                        message: nil
                    )
                ],
                pricing: UsagePricing(status: "fresh", source: "test", fetchedAt: nil, knownModels: 1),
                scanDurationMs: 1
            )
        )
    }
}
