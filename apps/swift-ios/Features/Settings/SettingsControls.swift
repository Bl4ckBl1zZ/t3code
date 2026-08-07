import SwiftUI

// Shared chrome for the settings screens in this folder. `SettingsSection` and
// the row vocabulary live in SettingsView.swift; this file adds the pieces the
// React Native settings screens use that the root sheet had no need for —
// ported from apps/mobile/src/features/settings/components/SettingsActionButton.tsx
// and the field/footer treatments the route screens share.

/// The hairline SettingsView draws between rows of a section. Inset to the row
/// text so it reads as a list separator rather than a full-width rule.
struct SettingsRowDivider: View {
    /// Rows with no leading icon start their text at the section inset, so the
    /// separator has to start there too or it floats away from the content.
    var isInsetForIcon = true

    var body: some View {
        Divider()
            .overlay(T3Colors.separator)
            .padding(.leading, isInsetForIcon ? 54 : 20)
            .padding(.trailing, 20)
    }
}

/// `SettingsNavigationRow` with the current value echoed before the chevron —
/// React Native's `SettingsRow` with a `value` prop. Separate from the plain
/// navigation row so a row that has nothing to report stays uncluttered.
struct SettingsValueNavigationRow: View {
    let title: String
    let systemImage: String
    let value: String
    var isEnabled = true

    var body: some View {
        HStack(spacing: 12) {
            SettingsRowIcon(
                systemName: systemImage,
                color: isEnabled ? T3Colors.accent : T3Colors.textTertiary
            )
            Text(title)
                .font(T3Typography.threadBody)
                .foregroundStyle(isEnabled ? T3Colors.textPrimary : T3Colors.textTertiary)
            Spacer(minLength: 12)
            Text(value)
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Image(systemName: "chevron.right")
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textTertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 20)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Explanatory copy under a section. React Native renders this as `px-2` muted
/// text; here it lines up with the section inset instead.
struct SettingsFootnote: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textTertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A settled request failure. Kept inline rather than as an alert because every
/// settings screen here retries by editing the field the banner sits under.
struct SettingsErrorBanner: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
    }
}

enum SettingsActionTone {
    case primary
    case secondary
    case danger
}

/// Ported from SettingsActionButton.tsx. The busy spinner replaces the icon
/// rather than sitting beside it so the button never changes width mid-request.
struct SettingsActionButton: View {
    let title: String
    var systemImage: String?
    var tone: SettingsActionTone = .secondary
    var isBusy = false
    var isDisabled = false
    let action: () -> Void

    private var isInert: Bool { isDisabled || isBusy }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(foreground)
                } else if let systemImage {
                    Image(systemName: systemImage)
                        .font(T3Typography.supportingStrong)
                        .accessibilityHidden(true)
                }
                Text(title.uppercased())
                    .font(T3Typography.eyebrow)
                    .tracking(0.8)
            }
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(border)
            }
        }
        .buttonStyle(.plain)
        .disabled(isInert)
        .opacity(isInert ? 0.45 : 1)
        .accessibilityLabel(title)
    }

    private var foreground: Color {
        switch tone {
        case .primary: T3Colors.primaryActionForeground
        case .secondary: T3Colors.textPrimary
        case .danger: T3Colors.danger
        }
    }

    private var background: Color {
        switch tone {
        case .primary: T3Colors.primaryAction
        case .secondary, .danger: T3Colors.surface
        }
    }

    private var border: Color {
        switch tone {
        case .primary: .clear
        case .secondary: T3Colors.border
        case .danger: T3Colors.danger
        }
    }
}

/// Small caps label above a free-text field, matching `FieldLabel` in
/// AutomationEditSheet.tsx.
struct SettingsFieldLabel: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(T3Typography.supportingStrong)
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
    }
}

extension View {
    /// The text-entry treatment for settings fields: a filled input strip with a
    /// hairline under it, matching the connection onboarding fields.
    func settingsInputField(minHeight: CGFloat = 48) -> some View {
        font(T3Typography.threadBody)
            .foregroundStyle(T3Colors.textPrimary)
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .topLeading)
            .background(T3Colors.input)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(T3Colors.inputBorder)
                    .frame(height: 1)
            }
    }
}
