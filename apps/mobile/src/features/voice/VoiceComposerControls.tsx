import type { VoiceInputState } from "@t3tools/client-runtime/voice";
import { VOICE_INPUT_MAX_DURATION_SECONDS } from "@t3tools/contracts/voice";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeInUp,
  FadeOut,
  FadeOutDown,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  ZoomIn,
  ZoomOut,
  type SharedValue,
} from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";

const COUNTDOWN_THRESHOLD_SECONDS = 15;
const HAPTIC_COUNTDOWN_SECONDS = 3;
const LEVEL_BAR_COUNT = 14;
const LEVEL_BAR_WIDTH = 3;
const LEVEL_BAR_MAX_HEIGHT = 16;
const LEVEL_BAR_MIN_HEIGHT = 3;

// Bars form a dome mirrored around the center like the system dictation meter. Alternating
// response exponents keep neighbors from moving in lockstep so the meter reads as a live
// waveform rather than a uniform block.
const LEVEL_BAR_PROFILES = Array.from({ length: LEVEL_BAR_COUNT }, (_, index) => {
  const centered = Math.sin((Math.PI * (index + 0.5)) / LEVEL_BAR_COUNT);
  return {
    weight: 0.3 + 0.7 * centered,
    exponent: index % 2 === 0 ? 0.8 : 1.3,
    opacity: 0.5 + 0.5 * centered,
  };
});

/**
 * Visuals for the combined send/record button: mic when idle and empty, send arrow when the
 * draft has content, stop while recording. Hold always records regardless of mode (the touch
 * handling comes from useVoiceComposer's comboGesture).
 */
export function voiceComboButtonProps(
  state: VoiceInputState,
  canSend: boolean,
): {
  readonly icon: "mic" | "stop.fill" | "arrow.up";
  readonly variant?: "danger" | "primary";
  readonly disabled: boolean;
  readonly accessibilityLabel: string;
  readonly animateIconChanges: true;
} {
  const recording = state.type === "recording";
  const busy =
    state.type === "requesting_permission" ||
    state.type === "stopping" ||
    state.type === "transcribing";
  if (recording) {
    return {
      icon: "stop.fill",
      variant: "danger",
      disabled: false,
      accessibilityLabel: "Stop recording and transcribe",
      animateIconChanges: true,
    };
  }
  if (canSend && !busy) {
    return {
      icon: "arrow.up",
      variant: "primary",
      disabled: false,
      accessibilityLabel: "Send. Hold to dictate",
      animateIconChanges: true,
    };
  }
  return {
    icon: "mic",
    disabled: busy,
    accessibilityLabel:
      state.type === "transcribing"
        ? "Transcribing voice input"
        : "Dictate message. Hold to record",
    animateIconChanges: true,
  };
}

/**
 * Corner mic badge for the combo button's send mode — the visual hint that holding the send
 * button still dictates. Wraps the button; the badge ignores touches.
 */
export function VoiceComboBadge(props: {
  readonly visible: boolean;
  readonly children: ReactNode;
}) {
  const iconSubtle = useThemeColor("--color-icon-subtle");
  return (
    <View>
      {props.children}
      {props.visible ? (
        <View
          pointerEvents="none"
          className="absolute -bottom-0.5 -right-0.5 size-4 items-center justify-center rounded-full border border-border bg-screen"
        >
          <SymbolView name="mic" size={9} tintColor={iconSubtle} type="monochrome" />
        </View>
      ) : null}
    </View>
  );
}

function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1_000));
}

function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function LevelBar(props: {
  readonly level: SharedValue<number>;
  readonly profile: (typeof LEVEL_BAR_PROFILES)[number];
}) {
  const { level, profile } = props;
  const style = useAnimatedStyle(() => {
    const value = Math.min(1, Math.pow(level.value, profile.exponent) * profile.weight);
    const height = LEVEL_BAR_MIN_HEIGHT + value * (LEVEL_BAR_MAX_HEIGHT - LEVEL_BAR_MIN_HEIGHT);
    return { transform: [{ scaleY: height / LEVEL_BAR_MAX_HEIGHT }] };
  });
  return (
    <Animated.View
      className="rounded-full bg-danger"
      style={[
        style,
        { width: LEVEL_BAR_WIDTH, height: LEVEL_BAR_MAX_HEIGHT, opacity: profile.opacity },
      ]}
    />
  );
}

function VoiceLevelMeter(props: {
  readonly subscribeLevel: (listener: (level: number) => void) => () => void;
}) {
  // One shared value drives every bar on the UI thread; recording produces zero React
  // re-renders. Fast attack / slow release gives the meter a natural speech envelope.
  const level = useSharedValue(0);
  useEffect(
    () =>
      props.subscribeLevel((next) => {
        const clamped = Math.min(1, Math.max(0, next));
        level.value =
          clamped >= level.value
            ? withTiming(clamped, { duration: 60, easing: Easing.out(Easing.quad) })
            : withTiming(clamped, { duration: 350, easing: Easing.out(Easing.cubic) });
      }),
    [props.subscribeLevel, level],
  );
  useEffect(() => () => cancelAnimation(level), [level]);
  return (
    <View
      className="flex-row items-center gap-0.5"
      style={{ height: LEVEL_BAR_MAX_HEIGHT }}
      aria-hidden
    >
      {LEVEL_BAR_PROFILES.map((profile, index) => (
        // Bars are fixed positional slots in a symmetric dome.
        // oxlint-disable-next-line react/no-array-index-key
        <LevelBar key={index} level={level} profile={profile} />
      ))}
    </View>
  );
}

function RecordingDot(props: { readonly paused?: boolean }) {
  const reducedMotion = useReducedMotion();
  // Slide-to-cancel armed reuses the reduced-motion static path: the pulse stops while the
  // release would discard the recording.
  const still = reducedMotion || props.paused === true;
  const progress = useSharedValue(1);
  useEffect(() => {
    if (still) return;
    progress.value = withRepeat(
      withSequence(
        withTiming(0.35, { duration: 850, easing: Easing.inOut(Easing.quad) }),
        withTiming(1, { duration: 850, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
    );
    return () => {
      cancelAnimation(progress);
      progress.value = 1;
    };
  }, [still, progress]);
  const style = useAnimatedStyle(() => ({ opacity: progress.value }));
  return <Animated.View className="size-1.5 rounded-full bg-danger" style={style} aria-hidden />;
}

function RecordingClock(props: { readonly startedAt: number }) {
  const elapsedSeconds = useElapsedSeconds(props.startedAt);
  const remainingSeconds = Math.max(0, VOICE_INPUT_MAX_DURATION_SECONDS - elapsedSeconds);
  const showCountdown = remainingSeconds <= COUNTDOWN_THRESHOLD_SECONDS;
  const reducedMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const lastPulsedSecond = useRef<number | null>(null);

  useEffect(() => {
    if (!showCountdown || lastPulsedSecond.current === remainingSeconds) return;
    lastPulsedSecond.current = remainingSeconds;
    if (!reducedMotion) {
      scale.value = withSequence(
        withSpring(1.12, { damping: 14, stiffness: 420 }),
        withSpring(1, { damping: 18, stiffness: 320 }),
      );
    }
    if (remainingSeconds <= HAPTIC_COUNTDOWN_SECONDS && remainingSeconds > 0) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, [showCountdown, remainingSeconds, reducedMotion, scale]);

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Animated.View style={style}>
      <Text
        className="text-xs font-t3-medium tabular-nums text-danger"
        accessibilityLabel={
          showCountdown
            ? `Recording, ${remainingSeconds} seconds remaining`
            : `Recording, ${formatClock(elapsedSeconds)}`
        }
      >
        {showCountdown ? `-${formatClock(remainingSeconds)}` : formatClock(elapsedSeconds)}
      </Text>
    </Animated.View>
  );
}

function TranscribingDot(props: { readonly delayMs: number }) {
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(0.3);
  useEffect(() => {
    if (reducedMotion) {
      progress.value = 0.6;
      return;
    }
    progress.value = withDelay(
      props.delayMs,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 320, easing: Easing.out(Easing.quad) }),
          withTiming(0.3, { duration: 420, easing: Easing.in(Easing.quad) }),
        ),
        -1,
      ),
    );
    return () => cancelAnimation(progress);
  }, [reducedMotion, props.delayMs, progress]);
  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.8 + progress.value * 0.2 }],
  }));
  return <Animated.View className="size-1.5 rounded-full bg-foreground-muted" style={style} />;
}

function TranscribingDots() {
  return (
    <View
      className="flex-row items-center gap-1"
      style={{ height: LEVEL_BAR_MAX_HEIGHT }}
      aria-hidden
    >
      <TranscribingDot delayMs={0} />
      <TranscribingDot delayMs={140} />
      <TranscribingDot delayMs={280} />
    </View>
  );
}

const cancelTargetEnter = ZoomIn.springify()
  .damping(16)
  .stiffness(240)
  .reduceMotion(ReduceMotion.System);
const cancelTargetExit = ZoomOut.duration(120).reduceMotion(ReduceMotion.System);

/**
 * Floating slide-to-cancel target above the combo button, visible only while a push-to-talk
 * hold is in progress. It is a release target, not a tripwire: reaching it arms the discard, and
 * sliding back off disarms. useVoiceComposer quantizes cancel progress to 5% steps to bound
 * JS-side re-renders; a spring chases each step so the target reads as continuous growth. Arming
 * keeps the instant danger color swap but pops the scale (overshoot, then settle) so the flip
 * lands with weight. Render it as a sibling of the button inside a relatively positioned wrapper
 * that isn't clipped by an overflow-hidden ancestor.
 */
export function VoiceCancelTarget(props: {
  readonly holdActive: boolean;
  readonly cancelArmed: boolean;
  readonly cancelProgress: number;
}) {
  const iconColor = useThemeColor("--color-icon");
  const dangerFg = useThemeColor("--color-danger-foreground");
  const progressScale = useSharedValue(0.75 + 0.45 * props.cancelProgress);
  const armedPop = useSharedValue(1);
  useEffect(() => {
    progressScale.value = withSpring(0.75 + 0.45 * props.cancelProgress, {
      damping: 18,
      stiffness: 240,
      reduceMotion: ReduceMotion.System,
    });
  }, [props.cancelProgress, progressScale]);
  useEffect(() => {
    armedPop.value = props.cancelArmed
      ? withSequence(
          withSpring(1.15, { damping: 14, stiffness: 420, reduceMotion: ReduceMotion.System }),
          withSpring(1, { damping: 18, stiffness: 320, reduceMotion: ReduceMotion.System }),
        )
      : withSpring(1, { damping: 18, stiffness: 320, reduceMotion: ReduceMotion.System });
  }, [props.cancelArmed, armedPop]);
  const scaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: progressScale.value * armedPop.value }],
  }));
  if (!props.holdActive) return null;
  return (
    <Animated.View
      pointerEvents="none"
      className="absolute inset-x-0 bottom-full items-center pb-3"
      entering={cancelTargetEnter}
      exiting={cancelTargetExit}
      aria-hidden
    >
      <Animated.View
        className={cn(
          "size-8 items-center justify-center rounded-full border",
          props.cancelArmed ? "border-danger bg-danger" : "border-border bg-subtle-strong",
        )}
        style={scaleStyle}
      >
        <SymbolView
          name="xmark"
          size={13}
          tintColor={props.cancelArmed ? dangerFg : iconColor}
          type="monochrome"
        />
      </Animated.View>
    </Animated.View>
  );
}

const barLayout = LinearTransition.springify()
  .damping(18)
  .stiffness(220)
  .reduceMotion(ReduceMotion.System);
const barEnter = FadeInUp.springify().damping(18).stiffness(220).reduceMotion(ReduceMotion.System);
const barExit = FadeOutDown.duration(140).reduceMotion(ReduceMotion.System);

/**
 * Eases the recording bar's dim treatment while slide-to-cancel is armed: an opacity timing
 * instead of an instant style flip, so the bar settles into (and out of) its muted state.
 */
function ArmedDim(props: { readonly dimmed: boolean; readonly children: ReactNode }) {
  const opacity = useSharedValue(props.dimmed ? 0.35 : 1);
  useEffect(() => {
    opacity.value = withTiming(props.dimmed ? 0.35 : 1, {
      duration: 180,
      easing: Easing.out(Easing.quad),
      reduceMotion: ReduceMotion.System,
    });
  }, [props.dimmed, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View className="flex-row items-center gap-2" style={style}>
      {props.children}
    </Animated.View>
  );
}

/**
 * Live recording/transcribing status row for the composers. One persistent container morphs
 * between the recording and transcribing states so the eye tracks a single element; it renders
 * nothing when Voice Input is idle so it can sit unconditionally above the composer toolbars.
 */
export function VoiceRecordingBar(props: {
  readonly state: VoiceInputState;
  readonly subscribeLevel: (listener: (level: number) => void) => () => void;
  readonly onCancel: () => void;
  readonly onCleanupChange: (cleanup: boolean) => void;
  /** A push-to-talk finger is down: swap the cancel pill for the release hint. */
  readonly holdActive?: boolean;
  /** Slide-up cancel is armed: dim the bar so release clearly discards. */
  readonly cancelArmed?: boolean;
}) {
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const recording = props.state.type === "recording" ? props.state : null;
  const busy = props.state.type === "stopping" || props.state.type === "transcribing";
  const requesting = props.state.type === "requesting_permission";
  const holdActive = props.holdActive === true;
  const cancelArmed = holdActive && props.cancelArmed === true;
  if (!recording && !busy && !requesting) return null;

  return (
    <Animated.View entering={barEnter} exiting={barExit} layout={barLayout} className="px-2 pb-2">
      {recording ? (
        <Animated.View
          key="recording"
          entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
          className="flex-row items-center gap-2"
          accessibilityRole="toolbar"
          accessibilityLabel="Voice recording controls"
        >
          <RecordingDot paused={cancelArmed} />
          <ArmedDim dimmed={cancelArmed}>
            <VoiceLevelMeter subscribeLevel={props.subscribeLevel} />
            <RecordingClock startedAt={recording.startedAt} />
          </ArmedDim>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: recording.cleanup }}
            onPress={() => props.onCleanupChange(!recording.cleanup)}
            className={cn(
              "rounded-full px-2 py-1",
              recording.cleanup ? "bg-danger/10" : "bg-subtle",
            )}
          >
            <Text
              className={cn("text-xs", recording.cleanup ? "text-danger" : "text-foreground-muted")}
            >
              Cleanup {recording.cleanup ? "on" : "off"}
            </Text>
          </Pressable>
          <View className="flex-1" />
          {/* While a push-to-talk finger is down the cancel pill is unreachable, so the slot
              shows the gesture hint instead; otherwise the bar only carries cancel — the
              composer mic morphs into the stop control while recording, so a second stop pill
              here reads as a duplicate. */}
          {holdActive ? (
            // Both labels name what releasing right now does, because release is the only thing
            // that decides: wandering into the cancel zone arms the target, it doesn't discard.
            <Text className="text-xs text-foreground-muted" accessibilityLiveRegion="polite">
              {cancelArmed ? "Release to cancel" : "Release to send"}
            </Text>
          ) : (
            <ControlPill
              icon="xmark"
              accessibilityLabel="Cancel recording"
              onPress={props.onCancel}
            />
          )}
        </Animated.View>
      ) : requesting ? (
        // No cancel affordance here: the OS permission sheet owns the screen, and the bar exists
        // only so first-time users see the flow started while the sheet is up.
        <Animated.View
          key="requesting"
          entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
          className="flex-row items-center gap-2"
          accessibilityLiveRegion="polite"
          accessibilityLabel="Waiting for microphone access"
        >
          <View style={{ height: LEVEL_BAR_MAX_HEIGHT }} className="justify-center" aria-hidden>
            <ActivityIndicator size="small" color={iconSubtle} />
          </View>
          <Text className="text-xs text-foreground-muted">Waiting for microphone access…</Text>
        </Animated.View>
      ) : (
        <Animated.View
          key="transcribing"
          entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
          className="flex-row items-center gap-2"
          accessibilityRole="toolbar"
          accessibilityLabel="Voice transcription in progress"
        >
          <TranscribingDots />
          <Text className="text-xs text-foreground-muted">Transcribing…</Text>
          <View className="flex-1" />
          <ControlPill
            icon="xmark"
            accessibilityLabel="Cancel transcription"
            onPress={props.onCancel}
          />
        </Animated.View>
      )}
    </Animated.View>
  );
}
