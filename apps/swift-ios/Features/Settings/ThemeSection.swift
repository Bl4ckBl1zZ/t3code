import SwiftUI

/// Ported from apps/mobile/src/features/settings/appearance/sections/
/// ThemeAppearanceSection.tsx.
///
/// Appearance and palette sit in one section because they are one decision: the
/// mode picks which of a palette's two halves is on screen, and the orbs pick
/// which palette that is. Splitting them across sections made the orbs look
/// like they applied to both modes at once.
struct ThemeSection: View {
    @Binding var appearance: FeatureAppearance
    @Binding var lightThemeID: String
    @Binding var darkThemeID: String

    /// The mode actually rendering, which `.system` resolves into. Read from
    /// the environment rather than from `appearance` so System shows the user
    /// the palette they are really looking at.
    @SwiftUI.Environment(\.colorScheme) private var colorScheme

    private var resolvedAppearance: T3ThemeAppearance {
        switch appearance {
        case .light: .light
        case .dark: .dark
        case .system: colorScheme == .dark ? .dark : .light
        }
    }

    private var selectedID: String {
        resolvedAppearance == .dark ? darkThemeID : lightThemeID
    }

    private var footer: String {
        resolvedAppearance == .dark
            ? "Applies to dark mode. Light mode keeps its own theme."
            : "Applies to light mode. Dark mode keeps its own theme."
    }

    var body: some View {
        SettingsSection(title: "Theme", footer: footer) {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    SettingsRowIcon(systemName: "circle.lefthalf.filled")
                    Text("Appearance")
                        .font(T3Typography.threadBody)
                    Spacer(minLength: 12)
                    Picker("Appearance", selection: $appearance) {
                        Text("System").tag(FeatureAppearance.system)
                        Text("Light").tag(FeatureAppearance.light)
                        Text("Dark").tag(FeatureAppearance.dark)
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .tint(T3Colors.textSecondary)
                }
                .padding(.horizontal, SettingsMetrics.rowPadding)
                .frame(minHeight: SettingsMetrics.rowMinHeight)

                SettingsRowDivider(isInsetForIcon: false)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 14) {
                        ForEach(T3Palette.builtIn) { palette in
                            ThemeOrbButton(
                                palette: palette,
                                appearance: resolvedAppearance,
                                isSelected: palette.id == selectedID,
                                onSelect: { select(palette.id) }
                            )
                        }
                    }
                    .padding(.horizontal, SettingsMetrics.rowPadding)
                    .padding(.vertical, 14)
                }
            }
        }
    }

    private func select(_ id: String) {
        if resolvedAppearance == .dark {
            darkThemeID = id
        } else {
            lightThemeID = id
        }
    }
}

/// One palette, previewed as an orb of its own canvas and accent.
private struct ThemeOrbButton: View {
    let palette: T3Palette
    let appearance: T3ThemeAppearance
    let isSelected: Bool
    let onSelect: () -> Void

    private var colors: T3PaletteColors {
        appearance == .dark ? palette.dark : palette.light
    }

    var body: some View {
        Button(action: onSelect) {
            VStack(spacing: 6) {
                ZStack {
                    Circle()
                        .fill(
                            RadialGradient(
                                colors: [
                                    Color(uiColor: colors.previewAccent.uiColor),
                                    Color(uiColor: colors.previewCanvas.uiColor),
                                ],
                                center: UnitPoint(x: 0.32, y: 0.28),
                                startRadius: 0,
                                endRadius: 34
                            )
                        )
                    Circle()
                        .fill(Color(uiColor: colors.previewAction.uiColor))
                        .frame(width: 12, height: 12)
                        .offset(x: 9, y: 10)
                        .opacity(0.9)
                }
                .frame(width: 44, height: 44)
                .overlay(
                    Circle().strokeBorder(
                        isSelected ? T3Colors.accent : T3Colors.border,
                        lineWidth: isSelected ? 2 : 1
                    )
                )

                Text(palette.label)
                    .font(T3Typography.supporting)
                    .foregroundStyle(isSelected ? T3Colors.textPrimary : T3Colors.textTertiary)
                    .lineLimit(1)
            }
            .frame(width: 62)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(palette.label)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}
