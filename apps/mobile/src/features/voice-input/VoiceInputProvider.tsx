import { RegistryContext, useAtomMount, useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  AudioModule,
  IOSOutputFormat,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type RecorderState,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import { AsyncResult, Atom } from "effect/reactivity";
import { useSharedValue } from "react-native-reanimated";

import {
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../../lib/microphonePriority";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { managedRelayQueryManager } from "../cloud/managedRelayState";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { createLazyVoiceRecorder, type LazyVoiceRecorder } from "./lazyVoiceRecorder";
import { getRelayVoiceTranscriber } from "./relayVoiceInput";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const SIGNED_OUT_VOICE_STATUS_ATOM = Atom.make(AsyncResult.initial<never>()).pipe(
  Atom.withLabel("voice-input:mobile:relay-status:signed-out"),
);
const VOICE_METERING_INTERVAL_MS = 80;
// The native constructor expects platform-flattened options, as built by useAudioRecorder.
// iOS records 16 kHz mono PCM WAV because the relay's speech model accepts only
// WAV and MP3 (two minutes is under 4 MB). Android's recorder cannot write WAV.
const VOICE_RECORDING_OPTIONS =
  Platform.OS === "ios"
    ? {
        extension: ".wav",
        sampleRate: 16_000,
        numberOfChannels: 1,
        bitRate: 256_000,
        isMeteringEnabled: true,
        ...RecordingPresets.HIGH_QUALITY.ios,
        outputFormat: IOSOutputFormat.LINEARPCM,
      }
    : {
        extension: RecordingPresets.HIGH_QUALITY.extension,
        sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
        numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
        bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
        isMeteringEnabled: true,
        ...RecordingPresets.HIGH_QUALITY.android,
      };

async function releaseVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    // Expo never deactivates AVAudioSession after recording; do so to resume interrupted audio.
    await setIsAudioActiveAsync(false);
  }
}

async function configureVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    await setIsAudioActiveAsync(true);
  } catch (error) {
    try {
      await releaseVoiceRecordingAudio();
    } catch {}
    throw error;
  }
}

const VoiceInputContext = createContext<ReturnType<typeof useVoiceInputRuntime> | null>(null);

export function VoiceInputProvider({ children }: { readonly children: ReactNode }) {
  const runtime = useVoiceInputRuntime();
  return <VoiceInputContext value={runtime}>{children}</VoiceInputContext>;
}

export function useGlobalVoiceInput() {
  const context = use(VoiceInputContext);
  if (!context) throw new Error("Voice input provider is missing.");
  return context;
}

function useVoiceInputRuntime() {
  const registry = use(RegistryContext);
  useAtomMount(mobilePreferencesAtom);
  useAtomMount(updateMobilePreferencesAtom);
  // Signed-in T3 Connect accounts dictate through the relay; load its status
  // early so the first recording knows its clip limit and language.
  const relaySession = useAtomValue(managedRelaySessionAtom);
  const relayVoiceStatus = useAtomValue(
    relaySession && hasCloudPublicConfig()
      ? managedRelayQueryManager.voiceInputAtom(relaySession.accountId)
      : SIGNED_OUT_VOICE_STATUS_ATOM,
  );
  const relayVoiceAvailable =
    relaySession !== null &&
    hasCloudPublicConfig() &&
    !(AsyncResult.isSuccess(relayVoiceStatus) && !relayVoiceStatus.value.available);
  const [{ state, ownerKey, label }, setState] = useState({
    state: INITIAL_STATE,
    ownerKey: null as string | null,
    label: null as string | null,
  });
  const [focusedOwners, setFocusedOwners] = useState<ReadonlySet<string>>(new Set());
  const setOwnerFocused = useCallback((key: string, focused: boolean) => {
    setFocusedOwners((current) => {
      const next = new Set(current);
      if (focused) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const keepAwakeId = useId();
  const keepAwakeSessionRef = useRef(0);
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);
  const sessionRef = useRef<VoiceInputSession | null>(null);
  const recorderRef = useRef<LazyVoiceRecorder<RecorderState> | null>(null);

  if (!sessionRef.current || !recorderRef.current) {
    const recorder = createLazyVoiceRecorder({
      create: () => new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
      onStatus: (status: RecordingStatus) => {
        sessionRef.current?.controller.handleRecorderStatus({
          isFinished: status.isFinished,
          hasError: status.hasError || status.mediaServicesDidReset === true,
          error: status.error,
          url: status.url,
        });
      },
      // Read when recording starts so preference changes do not re-render every composer.
      selectInput: (inputs) => {
        const preferences = registry.get(mobilePreferencesAtom);
        if (!AsyncResult.isSuccess(preferences)) return null;
        const known = microphoneOrder(preferences.value.microphones);
        const order = rememberMicrophones(known, inputs);
        if (order !== known) {
          registry.set(updateMobilePreferencesAtom, {
            transform: (current) => ({
              microphones: rememberMicrophones(microphoneOrder(current.microphones), inputs),
            }),
          });
        }
        return preferredMicrophoneInput(inputs, order);
      },
    });
    recorderRef.current = recorder;
    sessionRef.current = new VoiceInputSession({
      recorder,
      getTranscriber: () => getRelayVoiceTranscriber(registry) ?? getLocalVoiceTranscriber(),
      requestPermission: async () => {
        const permission = await requestRecordingPermissionsAsync();
        return { granted: permission.granted, canAskAgain: permission.canAskAgain };
      },
      configureRecording: configureVoiceRecordingAudio,
      releaseRecording: releaseVoiceRecordingAudio,
      deleteRecording: (uri) => new File(uri).delete(),
      onStateChange: (nextState) =>
        setState({
          state: nextState,
          ownerKey: sessionRef.current?.ownerKey ?? null,
          label: sessionRef.current?.label ?? null,
        }),
    });
  }

  const session = sessionRef.current;
  const controller = session.controller;
  const recorder = recorderRef.current;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // iOS permission dialogs report inactive; cancel preparation only on background. Recorder status handles capture interruptions.
      if (nextState === "background") controller.appMovedToBackground();
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(
    () => () => {
      controller.dispose();
      recorder.release();
    },
    [controller, recorder],
  );

  useEffect(() => {
    if (state.phase !== "recording") return;

    const tag = `voice-input:${keepAwakeId}:${++keepAwakeSessionRef.current}`;
    const activation = activateKeepAwakeAsync(tag);
    void activation.catch(() => {});
    return () => {
      // Release after activation settles, even if the recording ends immediately.
      void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
    };
  }, [keepAwakeId, state.phase]);

  useEffect(() => {
    if (state.phase !== "preparing" && state.phase !== "recording") return;

    if (audioLevelsRef.current.some((level) => level !== 0)) {
      audioLevelsRef.current = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
      audioLevels.value = audioLevelsRef.current;
    }
    if (elapsedSecondsRef.current !== 0) {
      elapsedSecondsRef.current = 0;
      setElapsedSeconds(0);
    }
    if (state.phase !== "recording") return;

    const sampleRecording = () => {
      if (controller.currentState.phase !== "recording") return;
      const status = recorder.getStatus();
      if (!status?.isRecording) return;

      const level = normalizeVoiceInputDecibels(status.metering);
      const history = audioLevelsRef.current;
      if (level !== 0 || history.some((sample) => sample !== 0)) {
        const nextLevels = [...history.slice(1), level];
        audioLevelsRef.current = nextLevels;
        audioLevels.value = nextLevels;
      }

      const nextElapsedSeconds = Math.min(
        VOICE_RECORDING_LIMIT_SECONDS,
        Math.max(0, Math.floor(status.durationMillis / 1_000)),
      );
      if (nextElapsedSeconds !== elapsedSecondsRef.current) {
        elapsedSecondsRef.current = nextElapsedSeconds;
        setElapsedSeconds(nextElapsedSeconds);
      }
    };

    sampleRecording();
    const intervalId = setInterval(sampleRecording, VOICE_METERING_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [audioLevels, controller, recorder, state.phase]);

  const stop = useCallback(() => controller.stop(), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);

  return {
    // T3 Connect voice input works on any device; on-device dictation needs
    // iOS 26. Store screenshots show the button even on simulators.
    isAvailable:
      relayVoiceAvailable ||
      getLocalVoiceTranscriber() !== null ||
      getNativeShowcaseScene() !== null,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    ownerKey,
    label,
    focusedOwners,
    setOwnerFocused,
    session,
    stop,
    cancel,
  };
}
