import type { VoiceInputState } from "@t3tools/client-runtime/voice";
import { VOICE_INPUT_MAX_DURATION_SECONDS } from "@t3tools/contracts/voice";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";

const COUNTDOWN_THRESHOLD_SECONDS = 15;
const LEVEL_BAR_COUNT = 10;
const LEVEL_BAR_MAX_HEIGHT = 14;

export function voiceMicButtonProps(state: VoiceInputState): {
  readonly icon: "mic" | "stop.fill";
  readonly variant?: "danger";
  readonly disabled: boolean;
  readonly accessibilityLabel: string;
} {
  const recording = state.type === "recording";
  const busy =
    state.type === "requesting_permission" ||
    state.type === "stopping" ||
    state.type === "transcribing";
  return {
    icon: recording ? "stop.fill" : "mic",
    ...(recording ? { variant: "danger" as const } : {}),
    disabled: busy,
    accessibilityLabel: recording
      ? "Stop recording and transcribe"
      : state.type === "transcribing"
        ? "Transcribing voice input"
        : "Dictate message",
  };
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

function VoiceLevelMeter(props: {
  readonly subscribeLevel: (listener: (level: number) => void) => () => void;
}) {
  const [levels, setLevels] = useState<ReadonlyArray<number>>(() =>
    Array.from({ length: LEVEL_BAR_COUNT }, () => 0),
  );
  useEffect(
    () =>
      props.subscribeLevel((level) => {
        setLevels((previous) => [...previous.slice(1), level]);
      }),
    [props.subscribeLevel],
  );
  return (
    <View
      className="flex-row items-center gap-0.5"
      style={{ height: LEVEL_BAR_MAX_HEIGHT }}
      aria-hidden
    >
      {levels.map((level, index) => (
        <View
          // The bars are fixed positional slots over a rolling sample window.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className="w-0.5 rounded-full bg-danger"
          style={{ height: Math.round(3 + Math.min(1, level) * (LEVEL_BAR_MAX_HEIGHT - 3)) }}
        />
      ))}
    </View>
  );
}

/**
 * Live recording/transcribing status row for the composers. Renders nothing when Voice Input
 * is idle so it can sit unconditionally above the composer toolbars.
 */
export function VoiceRecordingBar(props: {
  readonly state: VoiceInputState;
  readonly subscribeLevel: (listener: (level: number) => void) => () => void;
  readonly onCancel: () => void;
  readonly onStop: () => void;
  readonly onCleanupChange: (cleanup: boolean) => void;
}) {
  const recording = props.state.type === "recording" ? props.state : null;
  const elapsedSeconds = useElapsedSeconds(recording?.startedAt ?? null);
  const remainingSeconds = Math.max(0, VOICE_INPUT_MAX_DURATION_SECONDS - elapsedSeconds);
  const showCountdown = remainingSeconds <= COUNTDOWN_THRESHOLD_SECONDS;

  if (recording) {
    return (
      <View
        className="flex-row items-center gap-2 px-2 pb-2"
        accessibilityRole="toolbar"
        accessibilityLabel="Voice recording controls"
      >
        <VoiceLevelMeter subscribeLevel={props.subscribeLevel} />
        <Text className="text-xs font-t3-medium tabular-nums text-danger">
          {showCountdown ? `-${formatClock(remainingSeconds)}` : formatClock(elapsedSeconds)}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: recording.cleanup }}
          onPress={() => props.onCleanupChange(!recording.cleanup)}
          className="rounded-full bg-subtle px-2 py-1"
        >
          <Text className="text-xs text-foreground-muted">
            Cleanup {recording.cleanup ? "on" : "off"}
          </Text>
        </Pressable>
        <View className="flex-1" />
        <ControlPill icon="xmark" accessibilityLabel="Cancel recording" onPress={props.onCancel} />
        <ControlPill
          icon="stop.fill"
          variant="danger"
          accessibilityLabel="Stop recording and transcribe"
          onPress={props.onStop}
        />
      </View>
    );
  }

  if (props.state.type === "stopping" || props.state.type === "transcribing") {
    return (
      <View
        className="flex-row items-center gap-2 px-2 pb-2"
        accessibilityRole="toolbar"
        accessibilityLabel="Voice transcription in progress"
      >
        <ActivityIndicator size="small" />
        <Text className="text-xs text-foreground-muted">Transcribing…</Text>
        <View className="flex-1" />
        <ControlPill
          icon="xmark"
          accessibilityLabel="Cancel transcription"
          onPress={props.onCancel}
        />
      </View>
    );
  }

  return null;
}

export function VoiceRecoveryRow(props: {
  readonly recovery: {
    readonly rawText: string;
    readonly cleanedText: string;
  } | null;
  readonly onUseRaw: () => void;
  readonly onUndo: () => void;
}) {
  const recovery = props.recovery;
  if (!recovery) return null;
  return (
    <View className="flex-row items-center justify-end gap-3 px-2 pb-2">
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
    </View>
  );
}
