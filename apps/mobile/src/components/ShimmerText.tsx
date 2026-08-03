import { useEffect } from "react";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { cn } from "../lib/cn";
import type { AppTextProps } from "./AppText";

/**
 * The standard "AI is working" text treatment: a Text whose opacity sweeps
 * smoothly while work is in flight. Drop-in for AppText — className and all
 * Text props pass through. Static at full opacity under reduced motion.
 */
export function ShimmerText({ className, style, ...props }: AppTextProps) {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (reducedMotion) {
      opacity.value = 1;
      return;
    }
    opacity.value = 0.55;
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 800, easing: Easing.inOut(Easing.quad) }),
        withTiming(0.55, { duration: 800, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
    );
    return () => {
      cancelAnimation(opacity);
      opacity.value = 1;
    };
  }, [opacity, reducedMotion]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.Text
      className={cn("font-sans text-foreground", className)}
      style={[style, animatedStyle]}
      {...props}
    />
  );
}
