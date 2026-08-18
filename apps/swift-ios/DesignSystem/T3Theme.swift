import SwiftUI
import UIKit

enum T3Colors {
    // Palette-driven roles read through T3ThemeStore, so selecting a theme in
    // Settings repaints every surface. Reads inside a SwiftUI `body` register
    // an Observation dependency on the store even though the spelling here is a
    // static — see T3ThemeStore for why that is what makes this work.
    //
    // The UIKit variants exist because recycled collection and terminal
    // surfaces resolve colors outside any `body`; they follow the system's
    // light/dark change for free and follow a palette change via
    // `.t3ThemeDidChange`.
    private static var palette: T3ResolvedColors { T3ThemeStore.shared.resolved }

    static var uiBackground: UIColor { palette.background }
    static var uiTextPrimary: UIColor { palette.textPrimary }

    static var background: Color { Color(uiColor: palette.background) }
    static var sheet: Color { Color(uiColor: palette.sheet) }
    static var surface: Color { Color(uiColor: palette.surface) }
    static var surfaceRaised: Color { Color(uiColor: palette.surfaceRaised) }
    static var input: Color { Color(uiColor: palette.input) }
    static var border: Color { Color(uiColor: palette.border) }
    static var inputBorder: Color { Color(uiColor: palette.inputBorder) }
    static var separator: Color { Color(uiColor: palette.separator) }
    static var subtle: Color { Color(uiColor: palette.subtle) }
    static var subtleStrong: Color { Color(uiColor: palette.subtleStrong) }
    static var ledgerSurface: Color { surface }
    static var ledgerSelected: Color { surfaceRaised }

    static var textPrimary: Color { Color(uiColor: palette.textPrimary) }
    static var textSecondary: Color { Color(uiColor: palette.textSecondary) }
    static var textTertiary: Color { Color(uiColor: palette.textTertiary) }
    static var placeholder: Color { Color(uiColor: palette.placeholder) }

    static var primaryAction: Color { Color(uiColor: palette.primaryAction) }
    static var primaryActionForeground: Color { Color(uiColor: palette.primaryActionForeground) }
    static var accent: Color { Color(uiColor: palette.accent) }
    static var danger: Color { Color(uiColor: palette.danger) }

    // Fixed roles. These have no palette counterpart on the Expo client either
    // — it renders them from constant Tailwind classes — so a palette that
    // recolored them here would put the two clients out of step.
    static let shadow = color(light: rgb(0x000000, alpha: 0.18), dark: rgb(0x000000, alpha: 0.32))
    static let statusRunning = color(light: rgb(0x0284C7), dark: rgb(0x22D3EE))
    static let statusInput = color(light: rgb(0x4F46E5), dark: rgb(0xA5B4FC))
    static let success = color(light: rgb(0x16A34A), dark: rgb(0x30D158))
    static let warning = color(light: rgb(0xD97706), dark: rgb(0xFF9F0A))

    static let syntaxKeyword = color(light: rgb(0x7C3AED), dark: rgb(0xC78EFF))
    static let syntaxLiteral = color(light: rgb(0x2563EB), dark: rgb(0x8CC7FF))
    static let syntaxNumber = color(light: rgb(0xB45309), dark: rgb(0xEBAA6B))
    static let syntaxProperty = color(light: rgb(0x0F766E), dark: rgb(0x6BD1C2))

    private static func color(light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: adaptive(light: light, dark: dark))
    }

    private static func adaptive(light: UIColor, dark: UIColor) -> UIColor {
        UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        }
    }

    private static func rgb(_ hex: UInt32, alpha: CGFloat = 1) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

/// The native client uses semantic fonts so every surface follows Dynamic Type.
/// Keep roles here instead of introducing one-off point sizes in feature views.
enum T3Typography {
    static let homeTitle = Font.system(.body, design: .default, weight: .semibold)
    static let homeMetadata = Font.system(.footnote, design: .default)

    static let navigationTitle = Font.system(.headline, design: .default, weight: .semibold)
    static let navigationMetadata = Font.system(.footnote, design: .default)
    static let status = Font.system(.footnote, design: .default, weight: .semibold)

    static let threadBody = Font.system(.body, design: .default)
    static let threadHeading1 = Font.system(.title2, design: .default, weight: .bold)
    static let threadHeading2 = Font.system(.title3, design: .default, weight: .bold)
    static let threadHeading3 = Font.system(.headline, design: .default, weight: .bold)
    static let threadHeading4 = Font.system(.body, design: .default, weight: .semibold)
    static let code = Font.system(.callout, design: .monospaced)
    static let tool = Font.system(.footnote, design: .monospaced)

    static let composer = Font.system(.body, design: .default)
    static let control = Font.system(.callout, design: .default, weight: .medium)
    static let supporting = Font.system(.footnote, design: .default)
    static let supportingStrong = Font.system(.footnote, design: .default, weight: .semibold)
    static let eyebrow = Font.system(.footnote, design: .default, weight: .bold)
}

enum T3Metrics {
    static let minimumTapTarget: CGFloat = 44
    static let sidebarWidth: CGFloat = 320
    static let minimumSidebarWidth: CGFloat = 280
    static let maximumSidebarWidth: CGFloat = 380
    static let readingWidth: CGFloat = 760
}

/// Liquid Glass, with a genuine pre-iOS-26 fallback.
///
/// `glassEffect(_:in:)`, `GlassEffectContainer` and the `.glass` button style
/// all arrived in iOS 26; this target still deploys to iOS 17 while building
/// against the iOS 27 SDK, so calling them unguarded would compile and then
/// crash on every shipping device that predates them. Every glass surface goes
/// through here instead: iOS 26 gets the system material, and older systems get
/// the closest thing that shipped before it — a blur material filling the same
/// shape.
enum T3Glass {
    /// How much of the backdrop shows through.
    enum Prominence {
        /// Chrome that content passes behind.
        case regular
        /// A control floating directly over content, where the backdrop should
        /// stay legible through it.
        case clear
    }
}

extension View {
    /// Fills `shape` behind the view with Liquid Glass, or with the closest
    /// pre-iOS-26 blur material.
    ///
    /// The rim is deliberately not drawn here: real glass carries its own
    /// specular edge and a material does not, so call sites that need a visible
    /// boundary add one stroke that both paths share.
    ///
    /// `tint` colors the glass itself rather than painting over it, so a
    /// tinted control still refracts what is behind it. The pre-26 fallback has
    /// no such trick and settles for a translucent wash over the material.
    @ViewBuilder
    func t3GlassEffect(
        _ prominence: T3Glass.Prominence = .regular,
        tint: Color? = nil,
        in shape: some Shape
    ) -> some View {
        if #available(iOS 26, *) {
            glassEffect(
                (prominence == .clear ? Glass.clear : Glass.regular).tint(tint),
                in: shape
            )
        } else {
            background {
                shape.fill(
                    prominence == .clear
                        ? AnyShapeStyle(.ultraThinMaterial)
                        : AnyShapeStyle(.regularMaterial)
                )
                if let tint {
                    shape.fill(tint.opacity(0.7))
                }
            }
        }
    }
}

/// Groups sibling glass surfaces so the system can blend them as one material
/// when they sit near each other, instead of rendering two panes that happen to
/// be adjacent.
///
/// Pre-iOS-26 this is deliberately a passthrough rather than a stack or a group:
/// a blur material has no such interaction to opt into, and wrapping the content
/// in anything at all would change the layout on exactly the systems that gain
/// nothing from it.
struct T3GlassContainer<Content: View>: View {
    var spacing: CGFloat?
    @ViewBuilder var content: Content

    var body: some View {
        if #available(iOS 26, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

extension View {
    func t3NavigationChrome() -> some View {
        toolbarBackground(T3Colors.sheet, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }
}
