import type { VoiceInputState } from "@t3tools/client-runtime/voice";
import { VOICE_INPUT_MAX_DURATION_SECONDS } from "@t3tools/contracts/voice";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
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
const RECOVERY_AUTO_DISMISS_MS = 6_000;

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
 * draft has content, stop while recording. Hold always records regardless of mode (the press
 * handlers come from useVoiceComposer's comboPressProps).
 */
export function voiceComboButtonProps(
  state: VoiceInputState,
  canSend: boolean,
): {
  readonly icon: "mic" | "stop.fill" | "arrow.up";
  readonly variant?: "danger" | "primary";
  readonly disabled: boolean;
  readonly accessibilityLabel: string;
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
    };
  }
  if (canSend && !busy) {
    return {
      icon: "arrow.up",
      variant: "primary",
      disabled: false,
      accessibilityLabel: "Send. Hold to dictate",
    };
  }
  return {
    icon: "mic",
    disabled: busy,
    accessibilityLabel:
      state.type === "transcribing"
        ? "Transcribing voice input"
        : "Dictate message. Hold to record",
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

function RecordingDot() {
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(1);
  useEffect(() => {
    if (reducedMotion) return;
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
  }, [reducedMotion, progress]);
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

const WAVE_BAR_COUNT = 32;
const WAVE_BAR_WIDTH = 3;
const WAVE_SAMPLE_INTERVAL_MS = 100;

function WaveBar(props: { readonly history: SharedValue<number[]>; readonly index: number }) {
  const { history, index } = props;
  const style = useAnimatedStyle(() => {
    const value = history.value[index] ?? 0;
    return {
      height: withTiming(
        LEVEL_BAR_MIN_HEIGHT + value * (LEVEL_BAR_MAX_HEIGHT - LEVEL_BAR_MIN_HEIGHT),
        { duration: WAVE_SAMPLE_INTERVAL_MS },
      ),
    };
  });
  return (
    <Animated.View
      className="rounded-full bg-foreground-muted"
      style={[style, { width: WAVE_BAR_WIDTH }]}
    />
  );
}

/**
 * Scrolling level history that fills the pill while recording: quiet samples read as a dotted
 * line, speech as bars, with the newest sample entering on the right — the system voice-memo
 * look. One shared array drives every bar; sampling is peak-hold per interval so short
 * transients still register.
 */
function VoiceWaveform(props: {
  readonly subscribeLevel: (listener: (level: number) => void) => () => void;
}) {
  const history = useSharedValue<number[]>(Array.from({ length: WAVE_BAR_COUNT }, () => 0));
  const peak = useRef(0);
  useEffect(
    () =>
      props.subscribeLevel((next) => {
        peak.current = Math.max(peak.current, Math.min(1, Math.max(0, next)));
      }),
    [props.subscribeLevel],
  );
  useEffect(() => {
    const id = setInterval(() => {
      history.value = [...history.value.slice(1), peak.current];
      peak.current = 0;
    }, WAVE_SAMPLE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [history]);
  return (
    <View
      className="min-w-0 flex-1 flex-row items-center justify-between px-2"
      style={{ height: LEVEL_BAR_MAX_HEIGHT }}
      aria-hidden
    >
      {Array.from({ length: WAVE_BAR_COUNT }, (_, index) => (
        // Bars are fixed positional slots in the scrolling history.
        <WaveBar key={index} history={history} index={index} />
      ))}
    </View>
  );
}

/**
 * In-pill replacement for the composer row while Voice Input is active: cancel on the left, a
 * scrolling waveform (recording) or "Transcribing" + spinner (stopping/transcribing) in the
 * middle, and stop / send on the right. Send while recording stops the capture and queues the
 * message to go out as soon as the transcript lands.
 */
export function VoiceInlineComposer(props: {
  readonly state: VoiceInputState;
  readonly subscribeLevel: (listener: (level: number) => void) => () => void;
  readonly onCancel: () => void;
  readonly onStop: () => void;
  readonly onSend: () => void;
  readonly sendQueued: boolean;
}) {
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const recording = props.state.type === "recording";
  return (
    <Animated.View
      entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
      className="min-w-0 flex-1 flex-row items-center gap-1"
      accessibilityRole="toolbar"
      accessibilityLabel={
        recording ? "Voice recording controls" : "Voice transcription in progress"
      }
    >
      <ControlPill
        icon="xmark"
        accessibilityLabel={recording ? "Cancel recording" : "Cancel transcription"}
        onPress={props.onCancel}
      />
      {recording ? (
        <VoiceWaveform subscribeLevel={props.subscribeLevel} />
      ) : (
        <View className="min-w-0 flex-1 flex-row items-center justify-center">
          <Text className="text-base text-foreground-muted" numberOfLines={1}>
            {props.sendQueued ? "Transcribing, will send" : "Transcribing"}
          </Text>
        </View>
      )}
      {recording ? (
        <ControlPill
          icon="stop.fill"
          accessibilityLabel="Stop recording and transcribe"
          onPress={props.onStop}
        />
      ) : (
        <View className="h-11 w-11 items-center justify-center">
          <ActivityIndicator size="small" color={iconSubtle} />
        </View>
      )}
      <ControlPill
        icon="arrow.up"
        variant="primary"
        disabled={props.sendQueued}
        accessibilityLabel={recording ? "Stop and send" : "Send when transcription finishes"}
        onPress={props.onSend}
      />
    </Animated.View>
  );
}

const barLayout = LinearTransition.duration(220)
  .easing(Easing.inOut(Easing.cubic))
  .reduceMotion(ReduceMotion.System);

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
}) {
  const recording = props.state.type === "recording" ? props.state : null;
  const busy = props.state.type === "stopping" || props.state.type === "transcribing";
  if (!recording && !busy) return null;

  return (
    <Animated.View
      entering={FadeInDown.springify().damping(22).stiffness(280).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(140).reduceMotion(ReduceMotion.System)}
      layout={barLayout}
      className="px-2 pb-2"
    >
      {recording ? (
        <Animated.View
          key="recording"
          entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
          className="flex-row items-center gap-2"
          accessibilityRole="toolbar"
          accessibilityLabel="Voice recording controls"
        >
          <RecordingDot />
          <VoiceLevelMeter subscribeLevel={props.subscribeLevel} />
          <RecordingClock startedAt={recording.startedAt} />
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
          {/* The composer mic morphs into the stop control while recording, so the bar only
              carries cancel — a second stop pill here reads as a duplicate. */}
          <ControlPill
            icon="xmark"
            accessibilityLabel="Cancel recording"
            onPress={props.onCancel}
          />
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

export function VoiceRecoveryRow(props: {
  readonly recovery: {
    readonly rawText: string;
    readonly cleanedText: string;
  } | null;
  readonly onUseRaw: () => void;
  readonly onUndo: () => void;
  readonly onDismiss?: () => void;
}) {
  const recovery = props.recovery;
  const onDismiss = props.onDismiss;

  // The chip auto-dismisses so it never lingers in the toolbar; any recovery change (e.g.
  // switching to the raw transcript) restarts the window.
  useEffect(() => {
    if (!recovery || !onDismiss) return;
    const id = setTimeout(onDismiss, RECOVERY_AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [recovery, onDismiss]);

  if (!recovery) return null;
  return (
    <Animated.View
      entering={FadeInDown.duration(200)
        .easing(Easing.out(Easing.cubic))
        .reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(240).reduceMotion(ReduceMotion.System)}
      className="flex-row items-center justify-end gap-3 px-2 pb-2"
    >
      <Text className="text-xs text-foreground-muted">
        {recovery.rawText === recovery.cleanedText ? "Transcript added" : "Cleaned up"}
      </Text>
      {recovery.rawText !== recovery.cleanedText ? (
        <Pressable accessibilityRole="button" onPress={props.onUseRaw}>
          <Text className="text-xs text-accent">Use raw</Text>
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" onPress={props.onUndo}>
        <Text className="text-xs text-accent">Undo</Text>
      </Pressable>
    </Animated.View>
  );
}
