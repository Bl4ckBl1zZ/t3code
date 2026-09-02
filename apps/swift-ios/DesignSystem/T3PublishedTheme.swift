import Foundation

/// A server-published palette after its optional roles have been layered over
/// the native default. An absent half remains absent: a dark-only desktop theme
/// should not pretend to own the user's light appearance.
struct T3PublishedPalette: Equatable, Sendable, Identifiable {
    let id: String
    let label: String
    let light: T3PaletteColors?
    let dark: T3PaletteColors?

    func colors(for appearance: T3ThemeAppearance) -> T3PaletteColors? {
        appearance == .dark ? dark : light
    }

    func pickerPalette() -> T3Palette {
        let fallback = T3Palette.named(T3Palette.defaultID)
        return T3Palette(
            id: id,
            label: label,
            light: light ?? fallback.light,
            dark: dark ?? fallback.dark
        )
    }

    static func resolve(_ themes: [EnvironmentTheme]) -> [T3PublishedPalette] {
        var seen = Set<String>()
        return themes.compactMap { theme in
            guard !T3Palette.reservedIDs.contains(theme.id), seen.insert(theme.id).inserted else {
                return nil
            }
            let light = T3PublishedThemeResolver.colors(for: .light, theme: theme)
            let dark = T3PublishedThemeResolver.colors(for: .dark, theme: theme)
            guard light != nil || dark != nil else { return nil }
            return T3PublishedPalette(
                id: theme.id,
                label: theme.name.trimmingCharacters(in: .whitespacesAndNewlines),
                light: light,
                dark: dark
            )
        }
    }
}

private enum T3PublishedThemeResolver {
    static func colors(
        for appearance: T3ThemeAppearance,
        theme: EnvironmentTheme
    ) -> T3PaletteColors? {
        let wireAppearance: EnvironmentThemeAppearance = appearance == .dark ? .dark : .light
        let overrides = wireAppearance == theme.appearance
            ? theme.colors
            : (appearance == .dark ? theme.variants?.dark : theme.variants?.light)
        let parsedOverrides = (overrides ?? [:]).reduce(
            into: [String: T3PaletteColor]()
        ) { parsed, entry in
            guard supportedRoles.contains(entry.key),
                  let color = T3ThemeColor.parse(entry.value) else { return }
            parsed[entry.key] = color
        }
        let hasSeeds = wireAppearance == theme.appearance
            && theme.canvas.flatMap(T3ThemeColor.parse) != nil
            && theme.accent.flatMap(T3ThemeColor.parse) != nil
        guard hasSeeds || !parsedOverrides.isEmpty else { return nil }

        let fallback = T3Palette.named(T3Palette.defaultID)
        let base = if hasSeeds,
                      let canvas = theme.canvas.flatMap(T3ThemeColor.parse),
                      let accent = theme.accent.flatMap(T3ThemeColor.parse) {
            T3VividPalette.make(canvas: canvas, accent: accent)
        } else {
            appearance == .dark ? fallback.dark : fallback.light
        }
        return applying(parsedOverrides, to: base)
    }

    /// The published role vocabulary this native client can paint. Keeping the
    /// filter here prevents a future-only role from surfacing a stock palette
    /// under the published theme's name.
    private static let supportedRoles: Set<String> = [
        "canvas", "chrome", "surface", "surfaceRaised", "border", "input", "muted",
        "secondary", "text", "textMuted", "mutedForeground", "placeholder", "accent",
        "accentForeground", "messageSurface", "errorForeground",
    ]

    private static func applying(
        _ colors: [String: T3PaletteColor],
        to base: T3PaletteColors
    ) -> T3PaletteColors {
        func value(_ role: String, _ fallback: T3PaletteColor) -> T3PaletteColor {
            colors[role] ?? fallback
        }
        func alpha(_ color: T3PaletteColor, _ alpha: Double) -> T3PaletteColor {
            T3PaletteColor(color.red, color.green, color.blue, alpha)
        }

        let canvas = value("canvas", base.background)
        let chrome = value("chrome", canvas)
        let surface = value("surface", base.surfaceRaised)
        let surfaceRaised = value("surfaceRaised", base.surface)
        let border = value("border", base.border)
        let accent = value("accent", base.primaryAction)
        let messageSurface = value("messageSurface", base.accent)
        return T3PaletteColors(
            background: canvas,
            sheet: alpha(chrome, 0.98),
            surface: surfaceRaised,
            surfaceRaised: surface,
            input: surfaceRaised,
            border: border,
            inputBorder: value("input", base.inputBorder),
            separator: alpha(border, 0.55),
            subtle: value("muted", base.subtle),
            subtleStrong: value("secondary", base.subtleStrong),
            textPrimary: value("text", base.textPrimary),
            textSecondary: value("textMuted", base.textSecondary),
            textTertiary: value("mutedForeground", base.textTertiary),
            placeholder: value("placeholder", base.placeholder),
            primaryAction: accent,
            primaryActionForeground: value("accentForeground", base.primaryActionForeground),
            accent: messageSurface,
            danger: value("errorForeground", base.danger),
            previewCanvas: canvas,
            previewAccent: messageSurface,
            previewAction: accent
        )
    }
}

private enum T3ThemeColor {
    private static let number = #"[-+]?(?:\d*\.)?\d+"#

    static func parse(_ raw: String) -> T3PaletteColor? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.hasPrefix("#") { return hex(value) }
        if value.hasPrefix("rgb") { return rgb(value) }
        if value.hasPrefix("oklch") { return oklch(value) }
        return nil
    }

    private static func hex(_ value: String) -> T3PaletteColor? {
        let body = String(value.dropFirst())
        let expanded: String
        switch body.count {
        case 3, 4:
            expanded = body.map { "\($0)\($0)" }.joined()
        case 6, 8:
            expanded = body
        default:
            return nil
        }
        guard let rgb = UInt64(expanded.prefix(6), radix: 16) else { return nil }
        let alpha = expanded.count == 8
            ? Double(UInt64(expanded.suffix(2), radix: 16) ?? 255) / 255
            : 1
        return T3PaletteColor(
            Double((rgb >> 16) & 0xff) / 255,
            Double((rgb >> 8) & 0xff) / 255,
            Double(rgb & 0xff) / 255,
            alpha
        )
    }

    private static func rgb(_ value: String) -> T3PaletteColor? {
        let matches = value.matches(of: try! Regex(number)).compactMap { Double($0.0) }
        guard matches.count == 3 || matches.count == 4 else { return nil }
        return T3PaletteColor(
            clamped(matches[0] / 255),
            clamped(matches[1] / 255),
            clamped(matches[2] / 255),
            clamped(matches.count == 4 ? matches[3] : 1)
        )
    }

    private static func oklch(_ value: String) -> T3PaletteColor? {
        let matches = value.matches(of: try! Regex(number)).compactMap { Double($0.0) }
        guard matches.count == 3 || matches.count == 4 else { return nil }
        let alpha = matches.count == 4 ? matches[3] : 1
        return fromOKLCH(.init(lightness: matches[0], chroma: matches[1], hue: matches[2]), alpha)
    }

    static func fromOKLCH(_ color: T3OKLCH, _ alpha: Double = 1) -> T3PaletteColor {
        let radians = color.hue * .pi / 180
        let a = color.chroma * cos(radians)
        let b = color.chroma * sin(radians)
        let l = pow(color.lightness + 0.3963377774 * a + 0.2158037573 * b, 3)
        let m = pow(color.lightness - 0.1055613458 * a - 0.0638541728 * b, 3)
        let s = pow(color.lightness - 0.0894841775 * a - 1.291485548 * b, 3)
        return T3PaletteColor(
            linearToSRGB(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            linearToSRGB(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            linearToSRGB(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
            clamped(alpha)
        )
    }

    static func toOKLCH(_ color: T3PaletteColor) -> T3OKLCH {
        let red = sRGBToLinear(color.red)
        let green = sRGBToLinear(color.green)
        let blue = sRGBToLinear(color.blue)
        let l = cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue)
        let m = cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue)
        let s = cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue)
        let lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
        let a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
        let b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
        return T3OKLCH(
            lightness: lightness,
            chroma: hypot(a, b),
            hue: atan2(b, a) * 180 / .pi
        )
    }

    private static func sRGBToLinear(_ value: Double) -> Double {
        value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
    }

    private static func linearToSRGB(_ value: Double) -> Double {
        clamped(value <= 0.0031308 ? value * 12.92 : 1.055 * pow(value, 1 / 2.4) - 0.055)
    }

    private static func clamped(_ value: Double) -> Double {
        min(1, max(0, value))
    }
}

private struct T3OKLCH {
    var lightness: Double
    var chroma: Double
    var hue: Double
}

/// Relevant native roles from the same two-seed vivid generator used by web.
/// The native client paints fewer roles, so it derives only those rather than
/// carrying a second copy of the web palette engine's full 58-role output.
private enum T3VividPalette {
    static func make(canvas: T3PaletteColor, accent: T3PaletteColor) -> T3PaletteColors {
        let canvasColor = T3ThemeColor.toOKLCH(canvas)
        let accentColor = T3ThemeColor.toOKLCH(accent)
        let dark = luminance(canvas) < 0.179
        let hue = accentColor.chroma < 0.02 ? canvasColor.hue : accentColor.hue
        let tint = min(0.045, max(0.008, accentColor.chroma * 0.22))
        let direction = dark ? 1.0 : -1.0

        func surface(_ delta: Double, _ chroma: Double? = nil) -> T3PaletteColor {
            T3ThemeColor.fromOKLCH(.init(
                lightness: min(0.98, max(0.05, canvasColor.lightness + direction * delta)),
                chroma: chroma ?? tint,
                hue: hue
            ))
        }
        let textBase = T3OKLCH(
            lightness: dark ? 0.95 : 0.2,
            chroma: min(0.035, accentColor.chroma * 0.25),
            hue: hue
        )
        let text = solve(textBase, against: canvas, contrast: 7, lighter: dark)
        let textColor = T3ThemeColor.fromOKLCH(text)
        let textMuted = readableMix(background: canvas, foreground: textColor, contrast: dark ? 5.082 : 4.705)
        let raised = surface(0.05)
        let border = surface(dark ? 0.16 : 0.12, min(0.07, accentColor.chroma * 0.35))
        let input = surface(dark ? 0.21 : 0.16, min(0.08, accentColor.chroma * 0.4))
        let secondary = surface(dark ? 0.1 : 0.06, min(0.09, accentColor.chroma * 0.5))
        let muted = surface(dark ? 0.06 : 0.04, min(0.06, accentColor.chroma * 0.35))
        let message = surface(dark ? 0.16 : 0.1, min(0.13, accentColor.chroma * 0.6))
        let accentForeground = readableForeground(on: accent)
        let placeholder = T3ThemeColor.fromOKLCH(
            solve(textBase, against: raised, contrast: 4.6, lighter: dark)
        )
        let defaultPalette = T3Palette.named(T3Palette.defaultID)

        return T3PaletteColors(
            background: canvas,
            sheet: .init(canvas.red, canvas.green, canvas.blue, 0.98),
            surface: raised,
            surfaceRaised: surface(0.015),
            input: raised,
            border: border,
            inputBorder: input,
            separator: .init(border.red, border.green, border.blue, 0.55),
            subtle: muted,
            subtleStrong: secondary,
            textPrimary: textColor,
            textSecondary: textMuted,
            textTertiary: textMuted,
            placeholder: placeholder,
            primaryAction: accent,
            primaryActionForeground: accentForeground,
            accent: message,
            danger: dark ? defaultPalette.dark.danger : defaultPalette.light.danger,
            previewCanvas: canvas,
            previewAccent: message,
            previewAction: accent
        )
    }

    private static func solve(
        _ base: T3OKLCH,
        against: T3PaletteColor,
        contrast: Double,
        lighter: Bool
    ) -> T3OKLCH {
        if ratio(T3ThemeColor.fromOKLCH(base), against) >= contrast { return base }
        var low = lighter ? base.lightness : 0
        var high = lighter ? 1 : base.lightness
        for _ in 0..<18 {
            let mid = (low + high) / 2
            let candidate = T3OKLCH(lightness: mid, chroma: base.chroma, hue: base.hue)
            if ratio(T3ThemeColor.fromOKLCH(candidate), against) >= contrast {
                if lighter { high = mid } else { low = mid }
            } else if lighter {
                low = mid
            } else {
                high = mid
            }
        }
        return T3OKLCH(
            lightness: lighter ? high : low,
            chroma: base.chroma,
            hue: base.hue
        )
    }

    private static func readableForeground(on background: T3PaletteColor) -> T3PaletteColor {
        let light = T3PaletteColor(1, 0.98, 1, 1)
        let dark = T3PaletteColor(36 / 255, 21 / 255, 35 / 255, 1)
        return ratio(light, background) >= ratio(dark, background) ? light : dark
    }

    private static func readableMix(
        background: T3PaletteColor,
        foreground: T3PaletteColor,
        contrast: Double
    ) -> T3PaletteColor {
        var low = 0.0
        var high = 1.0
        var answer = foreground
        for _ in 0..<12 {
            let amount = (low + high) / 2
            let candidate = mix(foreground, background, amount)
            if ratio(candidate, background) >= contrast {
                answer = candidate
                low = amount
            } else {
                high = amount
            }
        }
        return answer
    }

    private static func mix(
        _ first: T3PaletteColor,
        _ second: T3PaletteColor,
        _ amount: Double
    ) -> T3PaletteColor {
        .init(
            first.red + (second.red - first.red) * amount,
            first.green + (second.green - first.green) * amount,
            first.blue + (second.blue - first.blue) * amount,
            first.alpha + (second.alpha - first.alpha) * amount
        )
    }

    private static func ratio(_ first: T3PaletteColor, _ second: T3PaletteColor) -> Double {
        let lighter = max(luminance(first), luminance(second))
        let darker = min(luminance(first), luminance(second))
        return (lighter + 0.05) / (darker + 0.05)
    }

    private static func luminance(_ color: T3PaletteColor) -> Double {
        func linear(_ value: Double) -> Double {
            value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(color.red)
            + 0.7152 * linear(color.green)
            + 0.0722 * linear(color.blue)
    }
}

extension T3Palette {
    static let reservedIDs: Set<String> = [
        "system", "light", "dark", "t3-code", "t3-chat", "grove", "ocean", "ember", "iris",
        "t3-chat-dark", "t3-grove", "t3-ocean", "t3-ember", "t3-iris",
    ]
}
