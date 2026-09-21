import SwiftUI

/// Appearance mode and the palette for each mode, laid out like Display &
/// Brightness. Ported from apps/mobile/src/features/settings/appearance/
/// sections/ThemeAppearanceSection.tsx.
///
/// The mode and the palette grid share a page because they are one decision:
/// the mode picks which of a palette's two halves is on screen, and the grid
/// picks which palette that is. Changes apply as they are tapped, so the page
/// itself repaints and what you see is what you picked.
struct SettingsAppearanceView: View {
    @Binding var settings: FeatureSettings
    let environmentName: String?
    let environmentThemes: [EnvironmentTheme]
    var saveError: String?

    /// The mode actually rendering, which `.system` resolves into. Read from
    /// the environment rather than from `appearance` so System shows the
    /// palette the reader is really looking at.
    @SwiftUI.Environment(\.colorScheme) private var colorScheme
    @ScaledMetric(relativeTo: .body) private var cellWidth: CGFloat = 76

    private var resolvedAppearance: T3ThemeAppearance {
        switch settings.appearance {
        case .light: .light
        case .dark: .dark
        case .system: colorScheme == .dark ? .dark : .light
        }
    }

    private var selectedID: String {
        resolvedAppearance == .dark ? settings.darkThemeID : settings.lightThemeID
    }

    private var publishedPalettes: [T3Palette] {
        T3PublishedPalette.resolve(environmentThemes)
            .filter { $0.colors(for: resolvedAppearance) != nil }
            .map { $0.pickerPalette() }
    }

    var body: some View {
        SettingsForm {
            Section {
                AppearanceModePicker(selection: $settings.appearance)
            } footer: {
                SettingsFooter(error: saveError)
            }

            Section {
                paletteGrid(T3Palette.builtIn)
            } header: {
                Text(resolvedAppearance == .dark ? "Dark Theme" : "Light Theme")
            } footer: {
                Text(resolvedAppearance == .dark
                    ? "Light mode keeps its own theme."
                    : "Dark mode keeps its own theme.")
            }

            if !publishedPalettes.isEmpty {
                Section(environmentName.map { "Published by \($0)" } ?? "Published Themes") {
                    paletteGrid(publishedPalettes)
                }
            }
        }
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
        .t3SensoryFeedback(.selection, trigger: settings.appearance)
        .t3SensoryFeedback(.selection, trigger: selectedID)
    }

    private func paletteGrid(_ palettes: [T3Palette]) -> some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: cellWidth), spacing: 8, alignment: .top)],
            spacing: 14
        ) {
            ForEach(palettes) { palette in
                ThemeOrbButton(
                    palette: palette,
                    appearance: resolvedAppearance,
                    isSelected: palette.id == selectedID,
                    onSelect: { select(palette.id) }
                )
            }
        }
        .padding(.vertical, 8)
    }

    private func select(_ id: String) {
        if resolvedAppearance == .dark {
            settings.darkThemeID = id
        } else {
            settings.lightThemeID = id
        }
    }
}

/// System, Light and Dark as three small window previews with a check under
/// the chosen one, like Display & Brightness.
private struct AppearanceModePicker: View {
    @Binding var selection: FeatureAppearance

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            option(.system, label: "System")
            option(.light, label: "Light")
            option(.dark, label: "Dark")
        }
        .padding(.vertical, 8)
    }

    private func option(_ appearance: FeatureAppearance, label: String) -> some View {
        let isSelected = selection == appearance
        return Button {
            selection = appearance
        } label: {
            VStack(spacing: 8) {
                AppearanceThumbnail(appearance: appearance)
                Text(label)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textPrimary)
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? T3Colors.accent : T3Colors.textTertiary)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

/// A tiny window in the mode's colors. System is split down the middle.
private struct AppearanceThumbnail: View {
    let appearance: FeatureAppearance
    @ScaledMetric(relativeTo: .body) private var height: CGFloat = 84

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        ZStack {
            switch appearance {
            case .light: pane(dark: false)
            case .dark: pane(dark: true)
            case .system:
                HStack(spacing: 0) {
                    pane(dark: false)
                    pane(dark: true)
                }
            }
        }
        .frame(width: height * 0.62, height: height)
        .clipShape(shape)
        .overlay(shape.strokeBorder(T3Colors.border, lineWidth: 1))
        .accessibilityHidden(true)
    }

    private func pane(dark: Bool) -> some View {
        let ink = dark ? Color.white.opacity(0.28) : Color.black.opacity(0.14)
        return VStack(alignment: .leading, spacing: 5) {
            ForEach([0.8, 0.55, 0.7], id: \.self) { width in
                Capsule()
                    .fill(ink)
                    .frame(height: 5)
                    .scaleEffect(x: width, anchor: .leading)
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(dark ? Color(white: 0.11) : Color(white: 0.97))
    }
}

/// One palette, previewed as an orb of its own canvas and accent.
private struct ThemeOrbButton: View {
    let palette: T3Palette
    let appearance: T3ThemeAppearance
    let isSelected: Bool
    let onSelect: () -> Void

    @ScaledMetric(relativeTo: .body) private var orbSize: CGFloat = 44

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
                                endRadius: orbSize * 0.77
                            )
                        )
                    Circle()
                        .fill(Color(uiColor: colors.previewAction.uiColor))
                        .frame(width: orbSize * 0.27, height: orbSize * 0.27)
                        .offset(x: orbSize * 0.2, y: orbSize * 0.23)
                        .opacity(0.9)
                }
                .frame(width: orbSize, height: orbSize)
                .overlay(
                    Circle().strokeBorder(
                        isSelected ? T3Colors.accent : T3Colors.border,
                        lineWidth: isSelected ? 2 : 1
                    )
                )

                Text(palette.label)
                    .font(T3Typography.supporting)
                    .foregroundStyle(isSelected ? T3Colors.textPrimary : T3Colors.textSecondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(palette.label)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}
