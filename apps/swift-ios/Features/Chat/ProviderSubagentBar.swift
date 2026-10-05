import SwiftUI

// Ported from apps/mobile/src/features/threads/ProviderSubagentBar.tsx and the
// deriveProviderSubagentStatus / formatProviderSubagentStatus helpers in
// packages/client-runtime/src/state/threadExecution.ts.

/// Status of a provider-native subagent thread, read from its runless root
/// turn: the provider started that work, so no run of the thread owns it.
public struct ProviderSubagentStatus: Equatable, Sendable {
    public let status: String
    public let startedAt: Date?
    public let completedAt: Date?

    /// The newest runless root turn, or nil until the provider reports one.
    static func resolve(
        nodes: [OrchestrationV2ExecutionNode],
        parseDate: (String) -> Date?
    ) -> ProviderSubagentStatus? {
        guard let node = nodes.last(where: { $0.kind == "root_turn" && $0.runId == nil }) else {
            return nil
        }
        return ProviderSubagentStatus(
            status: node.status,
            startedAt: node.startedAt.flatMap(parseDate),
            completedAt: node.completedAt.flatMap(parseDate)
        )
    }

    /// `isOrchestrationV2WorkActive`.
    var isLive: Bool {
        status == "pending" || status == "running" || status == "waiting"
    }

    var label: String {
        switch status {
        case "idle": "Idle"
        case "pending", "running": "Working"
        case "waiting": "Waiting"
        case "completed": "Completed"
        case "interrupted": "Interrupted"
        case "failed": "Failed"
        default: "Cancelled"
        }
    }

    /// "Completed in 34s" once finished, else just the label. A live duration
    /// is drawn by the system clock in the bar rather than formatted here.
    var summary: String {
        guard status == "completed", let startedAt, let completedAt else { return label }
        // Whole seconds, at least one, as web and React Native show it.
        let seconds = max(1, (completedAt.timeIntervalSince(startedAt)).rounded(.down))
        return "\(label) in \(ThreadActivityInspector.formatDuration(seconds * 1_000))"
    }
}

/// Stands in for the composer on a provider-native subagent thread. The
/// provider runs that conversation, so there is nothing to send; the bar says
/// which model is working, for how long, and leads back to the parent.
struct ProviderSubagentBar: View {
    let provider: FeatureProvider?
    /// Several accounts on this provider: badge the glyph and name the account,
    /// as the subagent rows in the parent do.
    var showsAccount = false
    let modelLabel: String
    /// Reasoning effort as the model chip names it, when the subagent has one.
    let effortLabel: String?
    /// Nil until the subagent's root turn arrives.
    let status: ProviderSubagentStatus?
    let onOpenParent: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            // Only the text is one element, so "Open parent" stays reachable.
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if let provider {
                        ProviderIcon(
                            driver: provider.driver,
                            providerID: provider.id,
                            fallbackName: provider.name,
                            size: 14
                        )
                        .overlay(alignment: .bottomTrailing) {
                            if let accent = accountAccent {
                                Circle()
                                    .fill(accent)
                                    .frame(width: 6, height: 6)
                                    .offset(x: 2, y: 2)
                            }
                        }
                    }
                    Text(modelLabel)
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    if let account {
                        Text(verbatim: "· \(account)")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                            .lineLimit(1)
                    }
                    if let effortLabel {
                        Text(effortLabel)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                statusLine
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)

            if let onOpenParent {
                Button("Open parent", action: onOpenParent)
                    .t3SecondaryButtonStyle()
            }
        }
        .padding(.leading, 18)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .frame(minHeight: 56)
        .t3GlassEffect(in: Capsule())
        .t3GlassRim(in: Capsule())
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .accessibilityIdentifier("thread-provider-subagent-bar")
    }

    private var statusLine: some View {
        HStack(spacing: 4) {
            Text(status?.summary ?? "Starting")
            // The system drives the clock, so a running subagent never
            // re-renders the thread to tick its timer.
            if let status, status.isLive, let startedAt = status.startedAt {
                Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
                    .monospacedDigit()
                    .fixedSize()
            }
            Text("· Runs on its own")
        }
        .font(T3Typography.supporting)
        .foregroundStyle(T3Colors.textSecondary)
        .lineLimit(1)
    }

    private var account: String? {
        showsAccount ? provider?.name : nil
    }

    private var accountAccent: Color? {
        guard showsAccount else { return nil }
        return provider?.accentColor.flatMap(ProviderAccountBadge.color)
    }

    private var accessibilityText: String {
        let named = account.map { "\(modelLabel), \($0)" } ?? modelLabel
        let model = effortLabel.map { "\(named), \($0)" } ?? named
        return "\(model) subagent, \(status?.summary ?? "Starting"). It runs on its own and cannot take messages."
    }
}
