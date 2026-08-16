import SwiftUI

// Row primitives for the thread details sheet. Ported from
// apps/mobile/src/features/threads/details/detailsRows.tsx.
//
// The desktop panel stacks flat rows under small section headings; on a phone
// the same grouping reads as a card per section, so the heading sits outside the
// card and the rows are separated by inset hairlines. Kept as their own
// primitives rather than a `List`, because a grouped list cannot express the
// leading orb, the trailing copy button, or the inset divider this design needs.

struct ThreadDetailsSection<Content: View>: View {
    let title: String
    var footer: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(T3Typography.eyebrow)
                .kerning(0.9)
                .foregroundStyle(T3Colors.textTertiary)
                .padding(.horizontal, 4)
                .frame(minHeight: 24, alignment: .leading)
                .accessibilityAddTraits(.isHeader)

            VStack(spacing: 0) {
                content
            }
            .background(T3Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(T3Colors.border, lineWidth: 1)
            )

            if let footer {
                Text(footer)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .padding(.horizontal, 4)
                    .padding(.top, 2)
            }
        }
    }
}

/// Inset hairline between rows, matching the git sheet's list treatment. The
/// inset is the icon puck's width plus its gap, so the rule starts under the
/// text rather than cutting the whole card in half.
struct ThreadDetailsDivider: View {
    var body: some View {
        Rectangle()
            .fill(T3Colors.border)
            .frame(height: 1)
            .padding(.leading, 48)
            .accessibilityHidden(true)
    }
}

/// Small coloured dot used where a row's state matters more than its icon.
struct ThreadDetailsStatusDot: View {
    var color: Color = T3Colors.statusRunning
    var dimmed = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .opacity(dimmed ? 0.5 : 1)
            .accessibilityHidden(true)
    }
}

struct ThreadDetailsRowIcon: View {
    let systemName: String
    var tint: Color = T3Colors.textSecondary

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 16, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: 36, height: 36)
            .background(T3Colors.subtle, in: Circle())
            .accessibilityHidden(true)
    }
}

struct ThreadDetailsRow<Leading: View, Detail: View, Trailing: View>: View {
    var systemImage: String?
    var iconTint: Color = T3Colors.textSecondary
    let title: String
    /// A shell command is the one title that has to keep its own spacing.
    var titleIsMonospaced = false
    var subtitle: String?
    var isDisabled = false
    var showsChevron = true
    var action: (() -> Void)?
    /// Replaces the icon puck entirely — used for status dots and agent orbs.
    @ViewBuilder var leading: Leading
    @ViewBuilder var detail: Detail
    @ViewBuilder var trailing: Trailing

    private var isInteractive: Bool { action != nil && !isDisabled }

    // A tap gesture rather than a `Button`, because the ports row carries its
    // own copy button in the trailing slot and a button nested inside a button
    // never receives the tap.
    var body: some View {
        content
            .opacity(isDisabled ? 0.45 : 1)
            .contentShape(Rectangle())
            .onTapGesture { if isInteractive { action?() } }
            // A row with its own trailing control — the ports row's copy button —
            // must stay a container, or collapsing it into one element would
            // make that button unreachable.
            .accessibilityElement(children: hasTrailingControl ? .contain : .combine)
            .accessibilityAddTraits(isInteractive && !hasTrailingControl ? .isButton : [])
    }

    private var hasTrailingControl: Bool { Trailing.self != EmptyView.self }

    private var content: some View {
        HStack(spacing: 12) {
            if Leading.self == EmptyView.self {
                if let systemImage {
                    ThreadDetailsRowIcon(systemName: systemImage, tint: iconTint)
                } else {
                    Color.clear.frame(width: 36, height: 36)
                }
            } else {
                leading.frame(width: 36, height: 36)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(titleIsMonospaced ? T3Typography.tool : T3Typography.control)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            detail
            trailing

            if showsChevron, isInteractive, Trailing.self == EmptyView.self {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(T3Colors.textTertiary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }
}

extension ThreadDetailsRow where Leading == EmptyView, Detail == EmptyView, Trailing == EmptyView {
    init(
        systemImage: String? = nil,
        iconTint: Color = T3Colors.textSecondary,
        title: String,
        titleIsMonospaced: Bool = false,
        subtitle: String? = nil,
        isDisabled: Bool = false,
        showsChevron: Bool = true,
        action: (() -> Void)? = nil
    ) {
        self.init(
            systemImage: systemImage,
            iconTint: iconTint,
            title: title,
            titleIsMonospaced: titleIsMonospaced,
            subtitle: subtitle,
            isDisabled: isDisabled,
            showsChevron: showsChevron,
            action: action,
            leading: { EmptyView() },
            detail: { EmptyView() },
            trailing: { EmptyView() }
        )
    }
}

extension ThreadDetailsRow where Leading == EmptyView, Trailing == EmptyView {
    init(
        systemImage: String? = nil,
        iconTint: Color = T3Colors.textSecondary,
        title: String,
        titleIsMonospaced: Bool = false,
        subtitle: String? = nil,
        isDisabled: Bool = false,
        showsChevron: Bool = true,
        action: (() -> Void)? = nil,
        @ViewBuilder detail: () -> Detail
    ) {
        self.init(
            systemImage: systemImage,
            iconTint: iconTint,
            title: title,
            titleIsMonospaced: titleIsMonospaced,
            subtitle: subtitle,
            isDisabled: isDisabled,
            showsChevron: showsChevron,
            action: action,
            leading: { EmptyView() },
            detail: detail,
            trailing: { EmptyView() }
        )
    }
}

extension ThreadDetailsRow where Leading == EmptyView, Detail == EmptyView {
    init(
        systemImage: String? = nil,
        iconTint: Color = T3Colors.textSecondary,
        title: String,
        titleIsMonospaced: Bool = false,
        subtitle: String? = nil,
        isDisabled: Bool = false,
        showsChevron: Bool = true,
        action: (() -> Void)? = nil,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.init(
            systemImage: systemImage,
            iconTint: iconTint,
            title: title,
            titleIsMonospaced: titleIsMonospaced,
            subtitle: subtitle,
            isDisabled: isDisabled,
            showsChevron: showsChevron,
            action: action,
            leading: { EmptyView() },
            detail: { EmptyView() },
            trailing: trailing
        )
    }
}

extension ThreadDetailsRow where Detail == EmptyView, Trailing == EmptyView {
    init(
        title: String,
        titleIsMonospaced: Bool = false,
        subtitle: String? = nil,
        isDisabled: Bool = false,
        showsChevron: Bool = true,
        action: (() -> Void)? = nil,
        @ViewBuilder leading: () -> Leading
    ) {
        self.init(
            systemImage: nil,
            title: title,
            titleIsMonospaced: titleIsMonospaced,
            subtitle: subtitle,
            isDisabled: isDisabled,
            showsChevron: showsChevron,
            action: action,
            leading: leading,
            detail: { EmptyView() },
            trailing: { EmptyView() }
        )
    }
}

extension ThreadDetailsRow where Trailing == EmptyView {
    init(
        title: String,
        titleIsMonospaced: Bool = false,
        subtitle: String? = nil,
        isDisabled: Bool = false,
        showsChevron: Bool = true,
        action: (() -> Void)? = nil,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder detail: () -> Detail
    ) {
        self.init(
            systemImage: nil,
            title: title,
            titleIsMonospaced: titleIsMonospaced,
            subtitle: subtitle,
            isDisabled: isDisabled,
            showsChevron: showsChevron,
            action: action,
            leading: leading,
            detail: detail,
            trailing: { EmptyView() }
        )
    }
}

/// The trailing badge a details row uses for one-word state — an availability
/// label, a workspace kind, a running duration.
struct ThreadDetailsRowBadge: View {
    let text: String
    var monospacedDigits = false

    var body: some View {
        // Monospaced figures only where the value counts, so a live duration
        // stops the row twitching while prose keeps proportional digits.
        (monospacedDigits ? Text(text).monospacedDigit() : Text(text))
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textTertiary)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
    }
}

/// The warning card the desktop panel puts at the top of Workspace. Both
/// conditions it reports — an unreachable environment, a client/server version
/// skew — have to be acted on before anything else in the sheet will work.
struct ThreadDetailsNotice<Actions: View>: View {
    let title: String
    let message: String
    @ViewBuilder var actions: Actions

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(T3Colors.danger)
                .padding(.top, 2)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textPrimary)
                Text(message)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if Actions.self != EmptyView.self {
                    HStack(spacing: 8) { actions }
                        .padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(T3Colors.danger.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(T3Colors.danger.opacity(0.28), lineWidth: 1)
        )
    }
}

struct ThreadDetailsNoticeButton: View {
    enum Tone { case primary, plain }

    let label: String
    var tone: Tone = .plain
    var isDisabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(
                    tone == .primary ? T3Colors.primaryActionForeground : T3Colors.textPrimary
                )
                .padding(.horizontal, 14)
                .frame(minHeight: 32)
                .background(
                    tone == .primary ? T3Colors.primaryAction : T3Colors.subtle,
                    in: Capsule()
                )
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.45 : 1)
    }
}
