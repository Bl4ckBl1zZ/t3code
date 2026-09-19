import { agentHue } from "@t3tools/shared/agentIdentity";
import { View } from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";

export type AgentOrbState = "active" | "done" | "failed";

/**
 * Deterministic per-agent identity orb: a colored circle (hue hashed from the
 * agent's stable id, matching the web app) with two soft radial-gradient
 * "smoke" layers. Active orbs are saturated, done orbs desaturated, failed
 * orbs red.
 *
 * Static on purpose. An agent can run for many minutes, and a looping drift
 * would repaint every frame for all of them on a high-refresh display; the row
 * carrying the orb says the agent is running.
 */
export function AgentOrb(props: {
  readonly seed: string;
  readonly size?: number;
  readonly state?: AgentOrbState;
}) {
  const size = props.size ?? 24;
  const state = props.state ?? "active";
  const hue = state === "failed" ? 0 : agentHue(props.seed);
  const active = state === "active";
  const baseColor = active ? `hsl(${hue} 85% 60%)` : `hsl(${hue} 30% 45%)`;
  const tintColor = `hsl(${(hue + 45) % 360} 95% 78%)`;
  const peakOpacity = active ? 0.9 : 0.45;
  const layerSize = size * 1.5;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: "hidden",
        backgroundColor: baseColor,
      }}
    >
      <View style={{ position: "absolute", left: -size * 0.4, top: -size * 0.35 }}>
        <Svg width={layerSize} height={layerSize}>
          <Defs>
            <RadialGradient id="orbTint" cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor={tintColor} stopOpacity={peakOpacity} />
              <Stop offset="100%" stopColor={tintColor} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={layerSize / 2} cy={layerSize / 2} r={layerSize / 2} fill="url(#orbTint)" />
        </Svg>
      </View>
      <View style={{ position: "absolute", right: -size * 0.4, bottom: -size * 0.35 }}>
        <Svg width={layerSize} height={layerSize}>
          <Defs>
            <RadialGradient id="orbWhite" cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor="#ffffff" stopOpacity={peakOpacity * 0.75} />
              <Stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={layerSize / 2} cy={layerSize / 2} r={layerSize / 2} fill="url(#orbWhite)" />
        </Svg>
      </View>
    </View>
  );
}
