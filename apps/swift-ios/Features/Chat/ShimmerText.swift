import SwiftUI

// Native live activity highlight shared by running work rows.

/// A masked highlight moves over live status text without a per-frame Swift timer.
/// Scene, visibility and reduced-motion changes stop the animation immediately.
private struct ShimmerHighlightModifier: ViewModifier {
    let isActive: Bool
    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @State private var visible = false
    @State private var traversed = false
    private var animates: Bool { isActive && !reduceMotion && visible && scenePhase == .active }

    func body(content: Content) -> some View {
        content
            .overlay {
                content.foregroundStyle(T3Colors.textPrimary)
                    .mask {
                        GeometryReader { geometry in
                            LinearGradient(colors: [.clear, .black.opacity(0.55), .black, .black.opacity(0.55), .clear], startPoint: .leading, endPoint: .trailing)
                                .frame(width: 72)
                                .offset(x: traversed ? geometry.size.width + 72 : -72)
                        }
                    }
                    .opacity(animates ? 1 : 0)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            .onAppear { visible = true; synchronize() }
            .onDisappear { visible = false; synchronize() }
            .onChange(of: animates) { synchronize() }
    }

    private func synchronize() {
        guard animates else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { traversed = false }
            return
        }
        withAnimation(.linear(duration: 2.2).repeatForever(autoreverses: false)) { traversed = true }
    }
}

extension View {
    /// Sweeps a highlight while `isActive`, matching the upstream live activity treatment.
    func shimmering(_ isActive: Bool = true) -> some View {
        modifier(ShimmerHighlightModifier(isActive: isActive))
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
