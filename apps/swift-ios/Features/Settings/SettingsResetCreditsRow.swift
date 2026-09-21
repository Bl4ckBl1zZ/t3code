import SwiftUI

/// An account's banked reset credits and the confirmed way to spend one. Rows
/// for the account's section in Limits; renders nothing while no credit is
/// banked and nothing has been reported.
struct SettingsResetCreditsRow: View {
    let credits: ServerProviderUsageLimits.ResetCredits
    let target: FeatureLimitAccount.ResetTarget
    let reader: any FeatureUsageLimitsReading
    let didRedeem: () async -> Void
    @State private var confirming = false
    @State private var busy = false
    @State private var result: String?
    @State private var failure: String?

    var body: some View {
        if credits.availableCount > 0 || result != nil || failure != nil {
            LabeledContent("Reset Credits", value: summary)
            Button {
                confirming = true
            } label: {
                HStack(spacing: 10) {
                    Text("Use a Reset Credit…")
                    if busy {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(busy || credits.availableCount == 0)
            .confirmationDialog("Use a reset credit?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Use Credit") { Task { await redeem() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.")
            }
            if let failure {
                Text(failure)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.danger)
            } else if let result {
                Text(result)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
        }
    }

    private var summary: String {
        let count = credits.availableCount.formatted()
        guard let expires = FeatureUsageLimitsMerge.date(credits.nextExpiresAt) else { return count }
        return "\(count) · next expires \(expires.formatted(date: .abbreviated, time: .omitted))"
    }

    @MainActor private func redeem() async {
        guard !busy, credits.availableCount > 0 else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let redeemed: ProviderConsumeResetCreditResult
            if let instanceID = target.instanceID {
                redeemed = try await reader.consumeResetCredit(environmentID: target.environmentID, instanceID: instanceID)
            } else if let sourceID = target.sourceID, let accountID = target.accountID, let creditID = target.creditID {
                redeemed = try await reader.consumeResetCredit(environmentID: target.environmentID, sourceID: sourceID, accountID: accountID, creditID: creditID)
            } else {
                throw RPCError.protocolViolation("The reset credit target is unavailable. Refresh limits.")
            }
            result = redeemed.message
            PlatformHapticEngine.shared.play(.success)
            await didRedeem()
        } catch {
            PlatformHapticEngine.shared.play(.error)
            failure = error.localizedDescription
        }
    }
}
