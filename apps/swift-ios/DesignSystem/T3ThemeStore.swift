import Observation
import SwiftUI
import UIKit

/// One palette color, stored as components so the generated table stays a plain
/// literal — `UIColor` cannot be built in a file-scope `let` without dragging
/// UIKit initialization into launch.
struct T3PaletteColor: Equatable, Sendable {
    let red: Double
    let green: Double
    let blue: Double
    let alpha: Double

    init(_ red: Double, _ green: Double, _ blue: Double, _ alpha: Double) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    var uiColor: UIColor {
        UIColor(red: red, green: green, blue: blue, alpha: alpha)
    }
}

/// The palette roles the native client paints from.
///
/// Deliberately smaller than the Expo client's variable set: only roles Swift
/// uses are carried. Roles with no palette meaning on either client — status,
/// syntax, success/warning — stay fixed in `T3Colors` rather than being
/// invented here.
struct T3PaletteColors: Equatable, Sendable {
    let background: T3PaletteColor
    let sheet: T3PaletteColor
    let surface: T3PaletteColor
    let surfaceRaised: T3PaletteColor
    let input: T3PaletteColor
    let border: T3PaletteColor
    let inputBorder: T3PaletteColor
    let separator: T3PaletteColor
    let subtle: T3PaletteColor
    let subtleStrong: T3PaletteColor
    let textPrimary: T3PaletteColor
    let textSecondary: T3PaletteColor
    let textTertiary: T3PaletteColor
    let placeholder: T3PaletteColor
    let primaryAction: T3PaletteColor
    let primaryActionForeground: T3PaletteColor
    let accent: T3PaletteColor
    let danger: T3PaletteColor
    let previewCanvas: T3PaletteColor
    let previewAccent: T3PaletteColor
    let previewAction: T3PaletteColor
}

/// A built-in theme. Light and dark are picked independently, so a user can run
/// one palette by day and another by night — the Expo client does the same.
struct T3Palette: Equatable, Sendable, Identifiable {
    let id: String
    let label: String
    let light: T3PaletteColors
    let dark: T3PaletteColors

    static let defaultID = T3ThemeDefaults.paletteID

    /// Falls back to the default rather than trapping: the id arrives from
    /// persisted settings, which a downgrade or a hand-edited file can make
    /// name a palette this build has never heard of.
    static func named(_ id: String?) -> T3Palette {
        guard let id, let match = builtIn.first(where: { $0.id == id }) else {
            return builtIn.first(where: { $0.id == defaultID }) ?? builtIn[0]
        }
        return match
    }
}

/// Every `T3Colors` role, resolved once per palette selection.
///
/// Each color stays *dynamic* over `userInterfaceStyle`, so switching the
/// system between light and dark still repaints for free — including in the
/// UIKit surfaces that never see a SwiftUI update. The palette selection is the
/// only thing this type freezes.
struct T3ResolvedColors {
    let background: UIColor
    let sheet: UIColor
    let surface: UIColor
    let surfaceRaised: UIColor
    let input: UIColor
    let border: UIColor
    let inputBorder: UIColor
    let separator: UIColor
    let subtle: UIColor
    let subtleStrong: UIColor
    let textPrimary: UIColor
    let textSecondary: UIColor
    let textTertiary: UIColor
    let placeholder: UIColor
    let primaryAction: UIColor
    let primaryActionForeground: UIColor
    let accent: UIColor
    let danger: UIColor

    init(light: T3PaletteColors, dark: T3PaletteColors) {
        func pair(_ role: KeyPath<T3PaletteColors, T3PaletteColor>) -> UIColor {
            let lightColor = light[keyPath: role].uiColor
            let darkColor = dark[keyPath: role].uiColor
            return UIColor { $0.userInterfaceStyle == .dark ? darkColor : lightColor }
        }

        background = pair(\.background)
        sheet = pair(\.sheet)
        surface = pair(\.surface)
        surfaceRaised = pair(\.surfaceRaised)
        input = pair(\.input)
        border = pair(\.border)
        inputBorder = pair(\.inputBorder)
        separator = pair(\.separator)
        subtle = pair(\.subtle)
        subtleStrong = pair(\.subtleStrong)
        textPrimary = pair(\.textPrimary)
        textSecondary = pair(\.textSecondary)
        textTertiary = pair(\.textTertiary)
        placeholder = pair(\.placeholder)
        primaryAction = pair(\.primaryAction)
        primaryActionForeground = pair(\.primaryActionForeground)
        accent = pair(\.accent)
        danger = pair(\.danger)
    }
}

/// Holds the palette every `T3Colors` read resolves against.
///
/// Observable on purpose, and read through `T3Colors`' computed properties:
/// Observation tracks the *access*, not the accessor, so a SwiftUI `body`
/// saying `T3Colors.textSecondary` registers a dependency on `resolved` exactly
/// as if it had read the store itself. That is what repaints the app on a theme
/// change without threading an environment value through ~800 call sites, and
/// without an `.id()` rebuild that would discard navigation state.
///
/// `resolved` is recomputed only when the selection changes, so the per-read
/// cost stays a stored-property load rather than building a `UIColor` closure
/// on every access.
///
/// Not `@MainActor`: isolating it would force every `T3Colors` reader — some of
/// them non-isolated UIKit helpers — onto the main actor. Mutation happens from
/// settings application on the main thread.
@Observable
final class T3ThemeStore {
    static let shared = T3ThemeStore()

    private(set) var lightPaletteID: String = T3Palette.defaultID
    private(set) var darkPaletteID: String = T3Palette.defaultID
    private(set) var resolved: T3ResolvedColors

    init() {
        let palette = T3Palette.named(T3Palette.defaultID)
        resolved = T3ResolvedColors(light: palette.light, dark: palette.dark)
    }

    func apply(lightPaletteID: String?, darkPaletteID: String?) {
        let light = T3Palette.named(lightPaletteID)
        let dark = T3Palette.named(darkPaletteID)
        // Settings republish on every change, most of which are not the theme.
        // Bailing keeps those from invalidating every view in the app.
        guard light.id != self.lightPaletteID || dark.id != self.darkPaletteID else { return }

        self.lightPaletteID = light.id
        self.darkPaletteID = dark.id
        resolved = T3ResolvedColors(light: light.light, dark: dark.dark)
        NotificationCenter.default.post(name: .t3ThemeDidChange, object: nil)
    }

    /// The palette shown as selected in the picker for a given appearance.
    func selectedPaletteID(for appearance: T3ThemeAppearance) -> String {
        appearance == .dark ? darkPaletteID : lightPaletteID
    }
}

/// The palette a fresh install starts on.
///
/// Public, and separate from `T3Palette`, only because `FeatureSettings` is
/// public and a public default argument cannot name an internal type. Keeping
/// the constant here rather than widening the whole palette API keeps the
/// design system's surface as small as it was.
public enum T3ThemeDefaults {
    public static let paletteID = "t3-code"
}

/// Resolved light or dark — distinct from `FeatureAppearance`, which also has
/// `.system`. This is what `.system` resolved *to*.
enum T3ThemeAppearance: String, Sendable, CaseIterable {
    case light
    case dark
}

extension Notification.Name {
    /// UIKit surfaces — the transcript collection view, the terminal — hold
    /// resolved colors outside any SwiftUI `body`, where Observation cannot
    /// reach them. They refresh on this instead.
    static let t3ThemeDidChange = Notification.Name("T3ThemeDidChange")
}
