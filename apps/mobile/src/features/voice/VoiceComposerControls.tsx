import type { VoiceInputState } from "@t3tools/client-runtime/voice";
import { VOICE_INPUT_MAX_DURATION_SECONDS } from "@t3tools/contracts/voice";
import * as Haptics from "expo-haptics";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, useColorScheme, View, type ColorValue } from "react-native";
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
} from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";

const COUNTDOWN_THRESHOLD_SECONDS = 15;
const HAPTIC_COUNTDOWN_SECONDS = 3;

// Scrolling waveform metrics: capture emits a level every ~100ms, and each sample becomes one
// bar pushed in from the right. Silence renders as the minimum-height dot, so an untouched
// strip reads as a dotted baseline exactly like the reference design.
const WAVEFORM_BAR_WIDTH = 2.5;
const WAVEFORM_BAR_GAP = 2.5;
const WAVEFORM_MAX_HEIGHT = 24;
const WAVEFORM_MIN_HEIGHT = 2.5;
const WAVEFORM_HISTORY_CAP = 600;

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

/**
 * Scrolling level history: every metering sample becomes a bar and older bars slide left, so
 * the strip reads as a recording timeline rather than a live meter. The history persists across
 * re-renders in a ref (a state array copied 10×/second would churn), and layout width decides
 * how many trailing samples are visible.
 */
function VoiceWaveform(props: {
  readonly subscribeLevel: (listener: (level: number) => void) => () => void;
  readonly color: ColorValue;
}) {
  const [width, setWidth] = useState(0);
  const historyRef = useRef<number[]>([]);
  const [, bump] = useReducer((tick: number) => tick + 1, 0);
  useEffect(
    () =>
      props.subscribeLevel((next) => {
        const history = historyRef.current;
        history.push(Math.min(1, Math.max(0, next)));
        if (history.length > WAVEFORM_HISTORY_CAP) history.shift();
        bump();
      }),
    [props.subscribeLevel],
  );

  const count =
    width > 0
      ? Math.max(
          1,
          Math.floor((width + WAVEFORM_BAR_GAP) / (WAVEFORM_BAR_WIDTH + WAVEFORM_BAR_GAP)),
        )
      : 0;
  const history = historyRef.current;
  const bars: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const sample = history.length - count + index;
    bars.push(sample >= 0 ? (history[sample] ?? 0) : 0);
  }

  return (
    <View
      className="min-w-0 flex-1 flex-row items-center overflow-hidden"
      style={{ height: WAVEFORM_MAX_HEIGHT, columnGap: WAVEFORM_BAR_GAP }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      aria-hidden
    >
      {bars.map((level, index) => {
        const value = Math.pow(level, 0.7);
        return (
          <View
            // Bars are fixed positional slots in a scrolling window.
            // oxlint-disable-next-line react/no-array-index-key
            key={index}
            style={{
              width: WAVEFORM_BAR_WIDTH,
              borderRadius: WAVEFORM_BAR_WIDTH,
              height: WAVEFORM_MIN_HEIGHT + value * (WAVEFORM_MAX_HEIGHT - WAVEFORM_MIN_HEIGHT),
              backgroundColor: props.color,
              opacity: level > 0.04 ? 0.95 : 0.45,
            }}
          />
        );
      })}
    </View>
  );
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
        className={cn(
          "text-xs font-t3-medium tabular-nums",
          showCountdown ? "text-danger" : "text-foreground-muted",
        )}
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
      style={{ height: WAVEFORM_MAX_HEIGHT }}
      aria-hidden
    >
      <TranscribingDot delayMs={0} />
      <TranscribingDot delayMs={140} />
      <TranscribingDot delayMs={280} />
    </View>
  );
}

const barLayout = LinearTransition.springify()
  .damping(18)
  .stiffness(220)
  .reduceMotion(ReduceMotion.System);
const barEnter = FadeInUp.springify().damping(18).stiffness(220).reduceMotion(ReduceMotion.System);
const barExit = FadeOutDown.duration(140).reduceMotion(ReduceMotion.System);
const stateEnter = FadeIn.duration(160).reduceMotion(ReduceMotion.System);
const stateExit = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

/**
 * Eases the waveform's dim treatment while slide-to-cancel is armed: an opacity timing instead
 * of an instant style flip, so the strip settles into (and out of) its muted state.
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
    <Animated.View className="min-w-0 flex-1 flex-row items-center" style={style}>
      {props.children}
    </Animated.View>
  );
}

/**
 * The one voice HUD for both composers: a full recording pill (cancel circle · clock · scrolling
 * waveform · send circle) that either covers the composer surface in place (`overlay`) or sits
 * inline above the composer chrome. While a push-to-talk finger is down the buttons are inert —
 * release decides — and a centered hint above the pill names what releasing does; sliding up
 * arms cancel, which turns the X and hint red. Renders nothing when Voice Input is idle so it
 * can sit unconditionally in the tree.
 */
export function VoiceRecordingBar(props: {
  readonly state: VoiceInputState;
  readonly subscribeLevel: (listener: (level: number) => void) => () => void;
  readonly onCancel: () => void;
  /** Stop the recording and transcribe (the pill's send-arrow action). */
  readonly onStop: () => void;
  readonly onCleanupChange: (cleanup: boolean) => void;
  /** A push-to-talk finger is down: show the release hint and make the pill inert. */
  readonly holdActive?: boolean;
  /** Slide-up cancel is armed: the X and hint flip to danger, release discards. */
  readonly cancelArmed?: boolean;
  /** Absolutely cover the composer surface instead of flowing inline above it. */
  readonly overlay?: { readonly borderRadius: number };
}) {
  const isDarkMode = useColorScheme() === "dark";
  const foregroundColor = useThemeColor("--color-foreground");
  const iconColor = useThemeColor("--color-icon");
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const dangerColor = useThemeColor("--color-danger");
  const primaryFg = useThemeColor("--color-primary-foreground");

  const recording = props.state.type === "recording" ? props.state : null;
  const busy = props.state.type === "stopping" || props.state.type === "transcribing";
  const requesting = props.state.type === "requesting_permission";
  const holdActive = props.holdActive === true;
  const cancelArmed = holdActive && props.cancelArmed === true;
  if (!recording && !busy && !requesting) return null;

  // Opaque pill colors match the composer surface fallback so the overlay swap is seamless on
  // top of both the liquid-glass and opaque surfaces.
  const pillBackground = isDarkMode ? "rgba(44,44,46,0.98)" : "rgba(255,255,255,0.98)";
  const pillBorder = isDarkMode ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
  const circleBackground = isDarkMode ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)";

  const aboveRow = holdActive ? (
    // Both labels name what releasing right now does, because release is the only thing that
    // decides: wandering into the cancel zone arms the discard, it doesn't perform it.
    <Text
      className={cn(
        "text-sm font-t3-medium",
        cancelArmed ? "text-danger" : "text-foreground-muted",
      )}
      accessibilityLiveRegion="polite"
    >
      {cancelArmed ? "Release to cancel" : "Release to send"}
    </Text>
  ) : recording ? (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: recording.cleanup }}
      onPress={() => props.onCleanupChange(!recording.cleanup)}
      className={cn("rounded-full px-2.5 py-1", recording.cleanup ? "bg-danger/10" : "bg-subtle")}
    >
      <Text className={cn("text-xs", recording.cleanup ? "text-danger" : "text-foreground-muted")}>
        Cleanup {recording.cleanup ? "on" : "off"}
      </Text>
    </Pressable>
  ) : null;

  const pillContent = recording ? (
    <Animated.View
      key="recording"
      entering={stateEnter}
      exiting={stateExit}
      className="min-w-0 flex-1 flex-row items-center gap-2"
      accessibilityRole="toolbar"
      accessibilityLabel="Voice recording controls"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel recording"
        disabled={holdActive}
        onPress={props.onCancel}
        className={cn(
          "size-9 items-center justify-center rounded-full",
          cancelArmed ? "bg-danger/25" : undefined,
        )}
        style={cancelArmed ? undefined : { backgroundColor: circleBackground }}
      >
        <SymbolView
          name="xmark"
          size={15}
          tintColor={cancelArmed ? dangerColor : iconColor}
          type="monochrome"
        />
      </Pressable>
      <RecordingClock startedAt={recording.startedAt} />
      <ArmedDim dimmed={cancelArmed}>
        <VoiceWaveform subscribeLevel={props.subscribeLevel} color={foregroundColor} />
      </ArmedDim>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Stop recording and transcribe"
        disabled={holdActive}
        onPress={props.onStop}
        className="size-9 items-center justify-center rounded-full bg-primary"
      >
        <SymbolView name="arrow.up" size={16} tintColor={primaryFg} type="monochrome" />
      </Pressable>
    </Animated.View>
  ) : requesting ? (
    // No cancel affordance here: the OS permission sheet owns the screen, and the pill exists
    // only so first-time users see the flow started while the sheet is up.
    <Animated.View
      key="requesting"
      entering={stateEnter}
      exiting={stateExit}
      className="min-w-0 flex-1 flex-row items-center gap-2 pl-1"
      accessibilityLiveRegion="polite"
      accessibilityLabel="Waiting for microphone access"
    >
      <ActivityIndicator size="small" color={iconSubtle} />
      <Text className="text-xs text-foreground-muted">Waiting for microphone access…</Text>
    </Animated.View>
  ) : (
    <Animated.View
      key="transcribing"
      entering={stateEnter}
      exiting={stateExit}
      className="min-w-0 flex-1 flex-row items-center gap-2"
      accessibilityRole="toolbar"
      accessibilityLabel="Voice transcription in progress"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel transcription"
        onPress={props.onCancel}
        className="size-9 items-center justify-center rounded-full"
        style={{ backgroundColor: circleBackground }}
      >
        <SymbolView name="xmark" size={15} tintColor={iconColor} type="monochrome" />
      </Pressable>
      <TranscribingDots />
      <Text className="text-xs text-foreground-muted">Transcribing…</Text>
      <View className="flex-1" />
      <View className="size-9 items-center justify-center rounded-full bg-subtle-strong">
        <ActivityIndicator size="small" color={iconSubtle} />
      </View>
    </Animated.View>
  );

  if (props.overlay) {
    return (
      <View className="absolute inset-0" pointerEvents="box-none">
        {aboveRow ? (
          <Animated.View
            pointerEvents={holdActive ? "none" : "box-none"}
            className="absolute inset-x-0 bottom-full items-center pb-3"
            entering={stateEnter}
            exiting={stateExit}
          >
            {aboveRow}
          </Animated.View>
        ) : null}
        <Animated.View
          entering={stateEnter}
          exiting={stateExit}
          className="absolute inset-0 flex-row items-center"
          style={{
            borderRadius: props.overlay.borderRadius,
            backgroundColor: pillBackground,
            borderWidth: 1,
            borderColor: pillBorder,
            paddingHorizontal: 5,
          }}
        >
          {pillContent}
        </Animated.View>
      </View>
    );
  }

  return (
    <Animated.View entering={barEnter} exiting={barExit} layout={barLayout} className="px-2 pb-2">
      {aboveRow ? <View className="items-center pb-2">{aboveRow}</View> : null}
      <View
        className="h-12 flex-row items-center rounded-full"
        style={{
          backgroundColor: pillBackground,
          borderWidth: 1,
          borderColor: pillBorder,
          paddingHorizontal: 6,
        }}
      >
        {pillContent}
      </View>
    </Animated.View>
  );
}
