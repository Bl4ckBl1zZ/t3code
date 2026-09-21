import SwiftUI

// Chrome shared by the tool screens (Files, Review, Source Control, Terminal).
// They are pushed inside Thread Details and also presented as sheet roots, so
// everything here reads correctly in both.

extension View {
    /// Inline title plus a secondary status line ("main · 2 to push").
    ///
    /// iOS 26 has a real navigation subtitle. Earlier systems get the same two
    /// lines in the principal slot, while the plain title still names the
    /// screen for the back button and VoiceOver. A principal item replaces the
    /// title there, so screens with a `toolbarTitleMenu` should not use this
    /// before iOS 26.
    @ViewBuilder
    func t3ToolTitle(_ title: String, subtitle: String?, subtitleColor: Color? = nil) -> some View {
        let titled = navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        if let subtitle, !subtitle.isEmpty {
            if #available(iOS 26, *) {
                titled.navigationSubtitle(
                    Text(subtitle).foregroundStyle(subtitleColor ?? T3Colors.textSecondary)
                )
            } else {
                titled.toolbar {
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 1) {
                            Text(title)
                                .font(T3Typography.navigationTitle)
                                .foregroundStyle(T3Colors.textPrimary)
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(subtitleColor ?? T3Colors.textSecondary)
                        }
                        .lineLimit(1)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        } else {
            titled
        }
    }
}

/// An inline warning or error at the top of a tool's list: what happened, and
/// the next step when there is one. Put it in its own `Section` with
/// `.listRowBackground(Color.clear)` and zero row insets, so it sits on the
/// list background instead of inside a grouped cell.
struct T3ToolBanner: View {
    enum Tone {
        case warning
        case error

        var color: Color {
            switch self {
            case .warning: T3Colors.warning
            case .error: T3Colors.danger
            }
        }

        var defaultSymbol: String {
            switch self {
            case .warning: "exclamationmark.triangle.fill"
            case .error: "exclamationmark.octagon.fill"
            }
        }
    }

    let tone: Tone
    let title: String
    var message: String?
    var systemImage: String?
    var actionTitle: String?
    var action: (() -> Void)?
    var onDismiss: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: systemImage ?? tone.defaultSymbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(tone.color)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(T3Colors.textPrimary)
                if let message, !message.isEmpty {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(T3Colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .font(.subheadline.weight(.semibold))
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                        .tint(tone.color)
                        .padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            tone.color.opacity(tone == .warning ? 0.14 : 0.12),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .accessibilityElement(children: .contain)
    }
}
