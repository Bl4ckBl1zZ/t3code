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
        // The per-provider split adds up to the headline count.
        XCTAssertEqual(merged.providers.first?.sessions, 5)
        XCTAssertEqual(merged.providers.reduce(0) { $0 + $1.sessions }, merged.sessions)
    }

    func testSessionsAreAttributedToTheProviderThatOwnsTheDirectory() {
        let merged = FeatureUsageMerge.merge([
            environment(id: "env-a", host: "host-a", cost: 2, tokens: 100, sessions: 3),
            environment(
                id: "env-b",
                host: "host-b",
                cost: 3,
                tokens: 50,
                sessions: 7,
                provider: "codex"
            ),
        ])

        XCTAssertEqual(
            Dictionary(uniqueKeysWithValues: merged.providers.map { ($0.provider, $0.sessions) }),
            ["claude": 3, "codex": 7]
        )
        XCTAssertEqual(merged.sessions, 10)
    }

    /// A duplicated directory is claimed once, so its sessions land on the
    /// provider once too — the same rule the cost and token totals follow.
    func testDuplicateDirectoriesDoNotDoubleCountProviderSessions() {
        let merged = FeatureUsageMerge.merge([
            environment(id: "env-b", host: "shared-host", cost: 2, tokens: 100, sessions: 3),
            environment(id: "env-a", host: "shared-host", cost: 2, tokens: 100, sessions: 3),
        ])

        XCTAssertEqual(merged.providers.first?.sessions, 3)
    }

    /// Sessions are seeded before the bucket loop, so a provider whose
    /// transcripts hold sessions but no priced buckets still gets a row.
    func testAProviderWithSessionsButNoPricedBucketsStillAppears() {
        let merged = FeatureUsageMerge.merge([
            environment(
                id: "env-a",
                host: "host-a",
                cost: 0,
                tokens: 0,
                sessions: 4,
                includeBucket: false
            )
        ])

        XCTAssertEqual(merged.providers.map(\.provider), ["claude"])
        XCTAssertEqual(merged.providers.first?.sessions, 4)
        XCTAssertEqual(merged.providers.first?.records, 0)
    }

    func testTheVolumeLinePluralisesAndDropsAnEmptySessionCount() {
        XCTAssertEqual(
            SettingsUsageView.providerVolume(
                FeatureUsageProviderTotals(
                    provider: "claude",
                    costUsd: 1,
                    totalTokens: 1_200_000,
                    records: 3,
                    sessions: 1
                )
            ),
            "1.20M tokens · 1 session"
        )
        XCTAssertEqual(
            SettingsUsageView.providerVolume(
                FeatureUsageProviderTotals(
                    provider: "claude",
                    costUsd: 1,
                    totalTokens: 1_200_000,
                    records: 3,
                    sessions: 12
                )
            ),
            "1.20M tokens · 12 sessions"
        )
        // Nothing owned means nothing to say, not "0 sessions".
        XCTAssertEqual(
            SettingsUsageView.providerVolume(
                FeatureUsageProviderTotals(
                    provider: "claude",
                    costUsd: 1,
                    totalTokens: 1_200_000,
                    records: 3,
                    sessions: 0
                )
            ),
            "1.20M tokens"
        )
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
        provider: String = "claude",
        includeBucket: Bool = true,
        contractVersion: Int = usageContractVersion
    ) -> FeatureEnvironmentUsage {
        let fingerprint = UsageSourceFingerprint(
            hostId: host,
            provider: provider,
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
                buckets: includeBucket ? [
                    UsageBucket(
                        day: "2026-08-05",
                        provider: provider,
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
                ] : [],
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
