import SwiftUI

struct SettingsResetCreditsRow: View {
    let credits: ServerProviderUsageLimits.ResetCredits
    let target: FeatureLimitAccount.ResetTarget
    let reader: any FeatureUsageLimitsReading
    let didRedeem: () async -> Void
    @State private var confirming = false
    @State private var busy = false
    @State private var status: String?

    var body: some View {
        if credits.availableCount > 0 || status != nil {
            VStack(alignment: .leading, spacing: 8) {
                Text("\(credits.availableCount) reset \(credits.availableCount == 1 ? "credit" : "credits") banked")
                    .font(T3Typography.supporting)
                if let expires = FeatureUsageLimitsMerge.date(credits.nextExpiresAt) {
                    Text("Next expires \(expires.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption).foregroundStyle(T3Colors.textSecondary)
                }
                Button { confirming = true } label: {
                    HStack { if busy { ProgressView() }; Text(busy ? "Using…" : "Use reset credit") }
                }.disabled(busy || credits.availableCount == 0)
                if let status { Text(status).font(.caption).foregroundStyle(T3Colors.textSecondary).accessibilityAddTraits(.updatesFrequently) }
            }
            .confirmationDialog("Use a reset credit?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Use credit") { Task { await redeem() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.")
            }
        }
    }

    @MainActor private func redeem() async {
        guard !busy, credits.availableCount > 0 else { return }
        busy = true
        defer { busy = false }
        do {
            let result: ProviderConsumeResetCreditResult
            if let instanceID = target.instanceID {
                result = try await reader.consumeResetCredit(environmentID: target.environmentID, instanceID: instanceID)
            } else if let sourceID = target.sourceID, let accountID = target.accountID, let creditID = target.creditID {
                result = try await reader.consumeResetCredit(environmentID: target.environmentID, sourceID: sourceID, accountID: accountID, creditID: creditID)
            } else { throw RPCError.protocolViolation("The reset credit target is unavailable. Refresh limits.") }
            status = result.message
            await didRedeem()
        } catch { status = error.localizedDescription }
    }
}
