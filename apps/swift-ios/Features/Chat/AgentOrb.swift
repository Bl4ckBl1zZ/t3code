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
/// soft radial-gradient "smoke" layers. Active orbs are saturated, done orbs
/// desaturated, failed orbs red.
///
/// Static on purpose, like the React Native orb. An agent can run for many
/// minutes, and a looping drift would repaint every frame for all of them on a
/// high-refresh display; the row carrying the orb already says it is running.
struct AgentOrb: View {
    let seed: String
    var size: CGFloat = 24
    var state: AgentOrbState = .active

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
    private var layerSize: CGFloat { size * 1.5 }

    var body: some View {
        ZStack(alignment: .topLeading) {
            smokeLayer(color: tintColor, opacity: peakOpacity)
                .offset(x: -size * 0.4, y: -size * 0.35)
            smokeLayer(color: .white, opacity: peakOpacity * 0.75)
                .offset(x: -size * 0.1, y: -size * 0.15)
        }
        .frame(width: size, height: size, alignment: .topLeading)
        .background(baseColor)
        .clipShape(Circle())
        .accessibilityHidden(true)
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
}
