import UIKit

/// Keeps a UIKit surface's palette colors current.
///
/// SwiftUI repaints on a theme change because reading `T3Colors` inside a
/// `body` registers an Observation dependency. UIKit has no equivalent: a view
/// keeps whatever `UIColor` it was handed, and a palette change produces a new
/// one rather than mutating the old. Dynamic colors re-resolve on a *trait*
/// change, and switching palettes is not one, so the assignment has to be
/// repeated by hand.
///
/// Held by the owner — a `UIViewRepresentable`'s coordinator — so the observer
/// dies with the surface it repaints.
final class T3ThemeRefresh {
    private var token: NSObjectProtocol?

    /// `apply` runs immediately so callers have exactly one place that assigns
    /// palette colors, instead of one at setup and a second one here that can
    /// drift out of step with it.
    init(apply: @escaping () -> Void) {
        apply()
        token = NotificationCenter.default.addObserver(
            forName: .t3ThemeDidChange,
            object: nil,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated { apply() }
        }
    }

    deinit {
        if let token {
            NotificationCenter.default.removeObserver(token)
        }
    }
}
