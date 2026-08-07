import SwiftUI

// Ported from apps/mobile/src/components/ShimmerText.tsx.

/// The standard "AI is working" treatment: opacity sweeps smoothly while work
/// is in flight, and holds at full opacity once it is not (or under reduced
/// motion). Terminal rows never shimmer — a pulsing line reads as live.
private struct ShimmerOpacityModifier: ViewModifier {
    let isActive: Bool

    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dimmed = false

    private var animates: Bool { isActive && !reduceMotion }

    func body(content: Content) -> some View {
        content
            .opacity(dimmed ? 0.55 : 1)
            .onAppear { synchronize() }
            .onChange(of: animates) { synchronize() }
    }

    private func synchronize() {
        guard animates else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { dimmed = false }
            return
        }
        withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
            dimmed = true
        }
    }
}

extension View {
    /// Sweeps opacity while `isActive`, matching the RN `ShimmerText`.
    func shimmering(_ isActive: Bool = true) -> some View {
        modifier(ShimmerOpacityModifier(isActive: isActive))
    }
}

/// Drop-in for `Text` on rows whose underlying item is still in flight.
struct ShimmerText: View {
    private let text: String
    private let isActive: Bool

    init(_ text: String, isActive: Bool = true) {
        self.text = text
        self.isActive = isActive
    }

    var body: some View {
        Text(verbatim: text).shimmering(isActive)
    }
}
