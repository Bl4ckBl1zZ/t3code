import SwiftUI

/// The app's own symbols, drawn as custom SF Symbols in the asset catalog so
/// they scale, weigh and tint like the system glyphs beside them, menus
/// included.
enum T3Symbol {
    /// Lucide's git-pull-request, the glyph web and desktop use. SF Symbols
    /// has no pull request glyph; `arrow.triangle.pull` reads as a sync arrow.
    static let pullRequest = "git.pull.request"

    /// Whether `name` is one of these rather than a system symbol.
    static func isCustom(_ name: String) -> Bool {
        name == pullRequest
    }
}

extension Image {
    /// A system symbol, or one of the app's own by name, for surfaces that
    /// pass symbol names around as strings.
    init(symbol name: String) {
        if T3Symbol.isCustom(name) {
            self.init(name)
        } else {
            self.init(systemName: name)
        }
    }
}

extension Label where Title == Text, Icon == Image {
    /// `Label(_:systemImage:)` that also takes the app's own symbols.
    init(_ title: String, symbol name: String) {
        self.init { Text(title) } icon: { Image(symbol: name) }
    }
}
