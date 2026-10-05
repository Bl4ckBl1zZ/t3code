import SwiftUI

/// Why the thread's last message did not send, above the composer until it is
/// dismissed, retried, or superseded. Static: no animation runs while it shows.
struct ThreadSendFailureCallout: View {
    let message: String
    /// Nil when there is nothing to resend (the draft was cleared).
    let onRetry: (() -> Void)?
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(T3Colors.danger)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                Text(verbatim: message)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let onRetry {
                    Button("Retry", systemImage: "arrow.clockwise", action: onRetry)
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                        .tint(T3Colors.textPrimary)
                }
            }
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(T3Typography.supporting.weight(.semibold))
                    .foregroundStyle(T3Colors.textTertiary)
                    .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss error")
            .padding(.vertical, -12)
            .padding(.trailing, -8)
        }
        .padding(14)
        .t3GlassEffect(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .t3GlassRim(in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Message not sent: \(message)")
        .accessibilityIdentifier("thread-send-failure")
        // VoiceOver hears the reason when it appears, not only when it is found.
        .task(id: message) {
            AccessibilityNotification.Announcement("Message not sent. \(message)").post()
        }
    }
}
