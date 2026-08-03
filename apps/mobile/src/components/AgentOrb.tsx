import { agentHue } from "@t3tools/shared/agentIdentity";
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";

export type AgentOrbState = "active" | "done" | "failed";

/**
 * Deterministic per-agent identity orb: a colored circle (hue hashed from the
 * agent's stable id, matching the web app) filled with two soft radial-
 * gradient "smoke" layers that drift slowly while the agent is active.
 * Done/failed orbs are static and desaturated; failed orbs go red.
 */
export function AgentOrb(props: {
  readonly seed: string;
  readonly size?: number;
  readonly state?: AgentOrbState;
}) {
  const size = props.size ?? 24;
  const state = props.state ?? "active";
  const hue = state === "failed" ? 0 : agentHue(props.seed);
  const reducedMotion = useReducedMotion();
  const animate = state === "active" && !reducedMotion;

  const drift = useSharedValue(0.5);
  const driftAlt = useSharedValue(0.5);

  useEffect(() => {
    if (!animate) {
      cancelAnimation(drift);
      cancelAnimation(driftAlt);
      drift.value = 0.5;
      driftAlt.value = 0.5;
      return;
    }
    drift.value = 0;
    driftAlt.value = 1;
    drift.value = withRepeat(
      withTiming(1, { duration: 4200, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    driftAlt.value = withRepeat(
      withTiming(0, { duration: 5400, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(drift);
      cancelAnimation(driftAlt);
    };
  }, [animate, drift, driftAlt]);

  // A few px of travel, scaled down for small orbs.
  const amplitude = Math.max(2, size * 0.14);
  const tintStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: (drift.value - 0.5) * 2 * amplitude },
      { translateY: (0.5 - drift.value) * amplitude },
    ],
  }));
  const whiteStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: (0.5 - driftAlt.value) * 2 * amplitude },
      { translateY: (driftAlt.value - 0.5) * amplitude },
    ],
  }));

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
      <Animated.View
        style={[{ position: "absolute", left: -size * 0.4, top: -size * 0.35 }, tintStyle]}
      >
        <Svg width={layerSize} height={layerSize}>
          <Defs>
            <RadialGradient id="orbTint" cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor={tintColor} stopOpacity={peakOpacity} />
              <Stop offset="100%" stopColor={tintColor} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={layerSize / 2} cy={layerSize / 2} r={layerSize / 2} fill="url(#orbTint)" />
        </Svg>
      </Animated.View>
      <Animated.View
        style={[{ position: "absolute", right: -size * 0.4, bottom: -size * 0.35 }, whiteStyle]}
      >
        <Svg width={layerSize} height={layerSize}>
          <Defs>
            <RadialGradient id="orbWhite" cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor="#ffffff" stopOpacity={peakOpacity * 0.75} />
              <Stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={layerSize / 2} cy={layerSize / 2} r={layerSize / 2} fill="url(#orbWhite)" />
        </Svg>
      </Animated.View>
    </View>
  );
}
