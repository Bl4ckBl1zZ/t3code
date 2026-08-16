import SwiftUI

// Ported from apps/mobile/src/components/AgentOrb.tsx and
// packages/shared/src/agentIdentity.ts.

public enum AgentOrbState: Equatable, Sendable {
    case active
    case done
    case failed
}

/// Deterministic per-agent colour identity.
public enum AgentIdentity {
    /// Hue in `0..<360`, hashed from the agent's stable id.
    ///
    /// Byte-for-byte the JS `agentHue`: `hash = (hash * 31 + charCodeAt(i)) | 0`
    /// over UTF-16 code units, truncated to 32 bits each step. Web, React
    /// Native, and this client must agree, or one agent changes colour when the
    /// user switches surface.
    public static func hue(for seed: String) -> Int {
        var hash: Int32 = 0
        for unit in seed.utf16 {
            hash = Int32(truncatingIfNeeded: Int64(hash) &* 31 &+ Int64(unit))
        }
        return Int(((hash % 360) + 360) % 360)
    }
}

/// `hsl()` as SwiftUI understands it. The RN orb is authored in HSL and SwiftUI
/// only takes HSB, so the two are converted here rather than re-eyeballing the
/// colours and drifting from the other clients.
func agentOrbColor(hue: Int, saturation: Double, lightness: Double) -> Color {
    let value = lightness + saturation * min(lightness, 1 - lightness)
    let brightnessSaturation = value <= 0 ? 0 : 2 * (1 - lightness / value)
    return Color(
        hue: Double(hue) / 360,
        saturation: brightnessSaturation,
        brightness: value
    )
}

/// A coloured circle (hue hashed from the agent's stable id) filled with two
/// soft radial-gradient "smoke" layers that drift while the agent is active.
/// Done and failed orbs are static and desaturated; failed orbs go red.
struct AgentOrb: View {
    let seed: String
    var size: CGFloat = 24
    var state: AgentOrbState = .active

    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift: Double = 0.5
    @State private var driftAlt: Double = 0.5

    private var animates: Bool { state == .active && !reduceMotion }
    private var isActive: Bool { state == .active }
    private var hue: Int { state == .failed ? 0 : AgentIdentity.hue(for: seed) }

    private var baseColor: Color {
        isActive
            ? agentOrbColor(hue: hue, saturation: 0.85, lightness: 0.60)
            : agentOrbColor(hue: hue, saturation: 0.30, lightness: 0.45)
    }

    private var tintColor: Color {
        agentOrbColor(hue: (hue + 45) % 360, saturation: 0.95, lightness: 0.78)
    }

    private var peakOpacity: Double { isActive ? 0.9 : 0.45 }
    /// A few points of travel, scaled down for small orbs.
    private var amplitude: CGFloat { max(2, size * 0.14) }
    private var layerSize: CGFloat { size * 1.5 }

    var body: some View {
        ZStack(alignment: .topLeading) {
            smokeLayer(color: tintColor, opacity: peakOpacity)
                .offset(
                    x: -size * 0.4 + CGFloat(drift - 0.5) * 2 * amplitude,
                    y: -size * 0.35 + CGFloat(0.5 - drift) * amplitude
                )
            smokeLayer(color: .white, opacity: peakOpacity * 0.75)
                .offset(
                    x: -size * 0.1 + CGFloat(0.5 - driftAlt) * 2 * amplitude,
                    y: -size * 0.15 + CGFloat(driftAlt - 0.5) * amplitude
                )
        }
        .frame(width: size, height: size, alignment: .topLeading)
        .background(baseColor)
        .clipShape(Circle())
        .accessibilityHidden(true)
        .onAppear { synchronizeAnimation() }
        .onChange(of: animates) { synchronizeAnimation() }
    }

    private func smokeLayer(color: Color, opacity: Double) -> some View {
        Circle()
            .fill(
                RadialGradient(
                    gradient: Gradient(colors: [color.opacity(opacity), color.opacity(0)]),
                    center: .center,
                    startRadius: 0,
                    endRadius: layerSize / 2
                )
            )
            .frame(width: layerSize, height: layerSize)
    }

    private func synchronizeAnimation() {
        guard animates else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                drift = 0.5
                driftAlt = 0.5
            }
            return
        }
        var reset = Transaction()
        reset.disablesAnimations = true
        withTransaction(reset) {
            drift = 0
            driftAlt = 1
        }
        withAnimation(.easeInOut(duration: 4.2).repeatForever(autoreverses: true)) {
            drift = 1
        }
        withAnimation(.easeInOut(duration: 5.4).repeatForever(autoreverses: true)) {
            driftAlt = 0
        }
    }
}
