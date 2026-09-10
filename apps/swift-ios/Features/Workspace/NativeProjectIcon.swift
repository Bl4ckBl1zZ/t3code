import SwiftUI

/// Generated Lucide paths are decoded once and compiled on demand. The view
/// draws a static native path; scrolling never parses SVG or creates a web view.
@MainActor
final class NativeProjectIconCatalog {
    static let shared = NativeProjectIconCatalog()
    private let commands: [String: [[Double]]]
    private var paths: [String: Path] = [:]
    let names: [String]

    private init() {
        if let url = Bundle.main.url(forResource: "ProjectIconPaths", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder().decode([String: [[Double]]].self, from: data) {
            commands = decoded
        } else { commands = [:] }
        names = commands.keys.sorted()
    }

    func path(_ name: String) -> Path? {
        if let cached = paths[name] { return cached }
        guard let operations = commands[name] else { return nil }
        var path = Path()
        for values in operations {
            guard let operation = values.first else { continue }
            switch (Int(operation), values.count) {
            case (0, 3): path.move(to: CGPoint(x: values[1], y: values[2]))
            case (1, 3): path.addLine(to: CGPoint(x: values[1], y: values[2]))
            case (2, 7): path.addCurve(to: CGPoint(x: values[5], y: values[6]),
                control1: CGPoint(x: values[1], y: values[2]), control2: CGPoint(x: values[3], y: values[4]))
            case (3, 5): path.addQuadCurve(to: CGPoint(x: values[3], y: values[4]), control: CGPoint(x: values[1], y: values[2]))
            case (4, 1): path.closeSubpath()
            default: continue
            }
        }
        paths[name] = path
        return path
    }
}

struct NativeProjectIcon: View {
    let icon: ProjectIconOverride
    var size: CGFloat = 18
    @SwiftUI.Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if icon.kind == "emoji", let emoji = icon.emoji {
                Text(emoji).font(.system(size: size * 0.9))
            } else if let path = NativeProjectIconCatalog.shared.path(icon.name ?? "folder-code") {
                path.applying(CGAffineTransform(scaleX: size / 24, y: size / 24))
                    .stroke(NativeProjectIconPalette.color(icon.color, dark: colorScheme == .dark),
                            style: StrokeStyle(lineWidth: size / 12, lineCap: .round, lineJoin: .round))
            } else {
                Image(systemName: "folder").font(.system(size: size * 0.9))
                    .foregroundStyle(T3Colors.textSecondary)
            }
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}

/// Wire color names are translated here; application chrome continues to use
/// native T3 theme tokens. The palette uses darker ink in light appearances.
enum NativeProjectIconPalette {
    static let names = ["gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"]
    private static let hues: [String: Double] = ["red": 0, "orange": 25, "amber": 38, "yellow": 48, "lime": 84, "green": 142, "emerald": 160, "teal": 173, "cyan": 189, "sky": 199, "blue": 217, "indigo": 239, "violet": 258, "purple": 271, "fuchsia": 292, "pink": 330, "rose": 350]
    static func color(_ name: String?, dark: Bool) -> Color {
        guard let name, let hue = hues[name] else { return T3Colors.textSecondary }
        return Color(hue: hue / 360, saturation: dark ? 0.58 : 0.86, brightness: dark ? 0.96 : 0.69)
    }
}
