import Foundation

// The Swift port of `packages/shared/usageMerge`: merges per-environment
// usage summaries into the one view the dashboard renders. Pure, so the
// de-duplication and derivation rules are testable without a connected
// environment.

/// One environment's answer to `server.getUsageSummary`.
public struct FeatureEnvironmentUsage: Sendable, Equatable {
    public let environmentID: String
    public let label: String
    public let summary: UsageSummary

    public init(environmentID: String, label: String, summary: UsageSummary) {
        self.environmentID = environmentID
        self.label = label
        self.summary = summary
    }
}

public struct FeatureUsageProviderTotals: Sendable, Equatable, Identifiable {
    public let provider: String
    public let costUsd: Double
    public let totalTokens: Int
    public let records: Int

    public var id: String { provider }
}

public struct FeatureUsageModelTotals: Sendable, Equatable, Identifiable {
    public let provider: String
    public let model: String
    public let costUsd: Double
    public let totalTokens: Int

    public var id: String { "\(provider) \(model)" }
}

public struct FeatureUsageDailyTotals: Sendable, Equatable, Identifiable {
    public let day: String
    public let costUsd: Double
    public let totalTokens: Int
    /// Provider → (cost, tokens) for the stacked chart.
    public let byProvider: [String: FeatureUsageDailySlice]

    public var id: String { day }
}

public struct FeatureUsageDailySlice: Sendable, Equatable {
    public var costUsd: Double
    public var totalTokens: Int
}

/// One rolling hourly bucket, present only when the summaries were requested
/// at hourly resolution. `hourStart` is the bucket's UTC start instant.
public struct FeatureUsageHourlyTotals: Sendable, Equatable, Identifiable {
    public let day: String
    public let hourStart: String
    public let costUsd: Double
    public let totalTokens: Int
    /// Provider → (cost, tokens) for the stacked chart.
    public let byProvider: [String: FeatureUsageDailySlice]

    public var id: String { hourStart }
}

public struct FeatureMergedUsage: Sendable, Equatable {
    public var costUsd: Double = 0
    public var cacheSavingsUsd: Double = 0
    public var uncachedInputTokens: Int = 0
    public var cachedInputTokens: Int = 0
    public var cacheCreationTokens: Int = 0
    public var outputTokens: Int = 0
    public var reasoningTokens: Int = 0
    public var totalTokens: Int = 0
    public var records: Int = 0
    public var sessions: Int = 0
    public var providers: [FeatureUsageProviderTotals] = []
    public var models: [FeatureUsageModelTotals] = []
    public var daily: [FeatureUsageDailyTotals] = []
    /// Empty for daily requests; hourly requests fill one entry per bucket
    /// hour that saw traffic.
    public var hourly: [FeatureUsageHourlyTotals] = []
    /// Environments whose transcript directories were dropped as duplicates
    /// of another environment's (label: path).
    public var duplicateSources: [String] = []
    /// Environments excluded for running a different usage contract version.
    public var staleEnvironments: [String] = []

    public init() {}

    /// Share of observed input that was served from cache.
    public var cachedInputShare: Double {
        let observedInput = uncachedInputTokens + cachedInputTokens
        return observedInput == 0 ? 0 : Double(cachedInputTokens) / Double(observedInput)
    }

    /// Mean cost/tokens over days that saw any traffic, not over the window:
    /// a quiet week must not drag the average toward zero.
    public var activeDays: Int { daily.filter { $0.totalTokens > 0 }.count }

    /// Hourly counterpart of `activeDays` for the past-24-hours window.
    public var activeHours: Int { hourly.filter { $0.totalTokens > 0 }.count }
}

public enum FeatureUsageMerge {
    /// Merges every environment's summary, excluding stale contract versions
    /// and de-duplicating physical transcript directories by fingerprint.
    ///
    /// Environments are ordered by id before claiming so the winner of a
    /// shared directory does not change between refreshes.
    public static func merge(
        _ environments: [FeatureEnvironmentUsage],
        expectedContractVersion: Int = usageContractVersion
    ) -> FeatureMergedUsage {
        var merged = FeatureMergedUsage()
        guard !environments.isEmpty else { return merged }

        var current: [FeatureEnvironmentUsage] = []
        for environment in environments {
            if environment.summary.contractVersion == expectedContractVersion {
                current.append(environment)
            } else {
                merged.staleEnvironments.append(environment.environmentID)
            }
        }

        // First environment in the stable order claims each fingerprint; the
        // rest have that provider's buckets dropped instead of double counted.
        var ownerByFingerprint: [String: String] = [:]
        for environment in current.sorted(by: { $0.environmentID < $1.environmentID }) {
            for source in environment.summary.sources where source.status != "missing" {
                let key = source.fingerprint.mergeKey
                if ownerByFingerprint[key] != nil {
                    merged.duplicateSources.append(
                        "\(environment.label): \(source.fingerprint.resolvedHomePath)"
                    )
                } else {
                    ownerByFingerprint[key] = environment.environmentID
                }
            }
        }

        var providerTotals: [String: (costUsd: Double, tokens: Int, records: Int)] = [:]
        var modelTotals: [String: (provider: String, model: String, costUsd: Double, tokens: Int)] =
            [:]
        var dailyTotals: [String: [String: FeatureUsageDailySlice]] = [:]
        var hourlyTotals: [String: (day: String, byProvider: [String: FeatureUsageDailySlice])] =
            [:]

        for environment in current {
            var ownedProviders: Set<String> = []
            for source in environment.summary.sources where source.status != "missing" {
                if ownerByFingerprint[source.fingerprint.mergeKey] == environment.environmentID {
                    ownedProviders.insert(source.fingerprint.provider)
                    // Distinct within a directory; summing per-bucket session
                    // counts would count a session once per day it spans.
                    merged.sessions += source.distinctSessions
                }
            }

            for bucket in environment.summary.buckets
            where ownedProviders.contains(bucket.provider) {
                let tokens = bucket.totals.totalTokens
                merged.costUsd += bucket.costUsd
                merged.cacheSavingsUsd += bucket.cacheSavingsUsd
                merged.uncachedInputTokens += bucket.totals.uncachedInputTokens
                merged.cachedInputTokens += bucket.totals.cachedInputTokens
                merged.cacheCreationTokens += bucket.totals.cacheCreationTokens
                merged.outputTokens += bucket.totals.outputTokens
                merged.reasoningTokens += bucket.totals.reasoningTokens
                merged.totalTokens += tokens
                merged.records += bucket.records

                var provider = providerTotals[bucket.provider] ?? (0, 0, 0)
                provider.costUsd += bucket.costUsd
                provider.tokens += tokens
                provider.records += bucket.records
                providerTotals[bucket.provider] = provider

                let modelKey = "\(bucket.provider) \(bucket.model)"
                var model = modelTotals[modelKey] ?? (bucket.provider, bucket.model, 0, 0)
                model.costUsd += bucket.costUsd
                model.tokens += tokens
                modelTotals[modelKey] = model

                var day = dailyTotals[bucket.day] ?? [:]
                var slice = day[bucket.provider] ?? FeatureUsageDailySlice(
                    costUsd: 0,
                    totalTokens: 0
                )
                slice.costUsd += bucket.costUsd
                slice.totalTokens += tokens
                day[bucket.provider] = slice
                dailyTotals[bucket.day] = day

                if let hourStart = bucket.hourStart {
                    var hour = hourlyTotals[hourStart] ?? (day: bucket.day, byProvider: [:])
                    var hourSlice = hour.byProvider[bucket.provider] ?? FeatureUsageDailySlice(
                        costUsd: 0,
                        totalTokens: 0
                    )
                    hourSlice.costUsd += bucket.costUsd
                    hourSlice.totalTokens += tokens
                    hour.byProvider[bucket.provider] = hourSlice
                    hourlyTotals[hourStart] = hour
                }
            }
        }

        merged.providers = providerTotals
            .map { FeatureUsageProviderTotals(
                provider: $0.key,
                costUsd: $0.value.costUsd,
                totalTokens: $0.value.tokens,
                records: $0.value.records
            ) }
            .sorted { $0.costUsd > $1.costUsd }
        merged.models = modelTotals.values
            .map { FeatureUsageModelTotals(
                provider: $0.provider,
                model: $0.model,
                costUsd: $0.costUsd,
                totalTokens: $0.tokens
            ) }
            .sorted { $0.costUsd > $1.costUsd }
        merged.daily = dailyTotals
            .map { day, byProvider in
                FeatureUsageDailyTotals(
                    day: day,
                    costUsd: byProvider.values.reduce(0) { $0 + $1.costUsd },
                    totalTokens: byProvider.values.reduce(0) { $0 + $1.totalTokens },
                    byProvider: byProvider
                )
            }
            .sorted { $0.day < $1.day }
        merged.hourly = hourlyTotals
            .map { hourStart, hour in
                FeatureUsageHourlyTotals(
                    day: hour.day,
                    hourStart: hourStart,
                    costUsd: hour.byProvider.values.reduce(0) { $0 + $1.costUsd },
                    totalTokens: hour.byProvider.values.reduce(0) { $0 + $1.totalTokens },
                    byProvider: hour.byProvider
                )
            }
            .sorted { $0.hourStart < $1.hourStart }
        return merged
    }
}
