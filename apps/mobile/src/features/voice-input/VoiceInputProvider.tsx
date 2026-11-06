import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { AudioModule, IOSOutputFormat, RecordingPresets, type RecordingStatus } from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { Atom, AsyncResult } from "effect/reactivity";
import { makeMutable } from "react-native-reanimated";

import {
  type MicrophoneEntry,
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../../lib/microphonePriority";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { createVoiceRecorder } from "../../native/voiceRecorder";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { managedRelayQueryManager } from "../cloud/managedRelayState";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  voiceInputBlocksSubmission,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { createLazyVoiceRecorder } from "./lazyVoiceRecorder";
import { getRelayVoiceTranscriber } from "./relayVoiceInput";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";
import { createVoiceRecordingPermission } from "./voiceRecordingPermission";
import { voiceRouteAtom } from "./voiceDestination";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";

const SIGNED_OUT_VOICE_STATUS_ATOM = Atom.make(AsyncResult.initial<never>()).pipe(
  Atom.withLabel("voice-input:mobile:relay-status:signed-out"),
);
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

function keepScreenAwake(tag: string): () => void {
  const activation = activateKeepAwakeAsync(tag);
  void activation.catch(() => {});
  // Release after activation settles, even if the recording ends immediately.
  return () => void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
}

export const deviceMicrophoneOrder = (saved?: ReadonlyArray<MicrophoneEntry>) =>
  microphoneOrder(saved, Platform.OS === "android" ? "android" : "ios");

/** "checking" until the first availability probe settles; re-probed on foreground. */
export const localVoiceTranscriberAtom = makePermissionStatusAtom<
  VoiceTranscriber | null | "checking"
>({
  label: "mobile:voice-input:transcriber",
  initial: "checking",
  read: () => getLocalVoiceTranscriber().catch(() => null),
}).pipe(Atom.keepAlive);

/** A chosen environment decides alone: its audio never falls back to T3 Connect or the device. */
const voiceInputAvailableAtom = Atom.make((get): boolean | "route-unavailable" => {
  const route = get(voiceRouteAtom);
  if (route) return route.transcriber !== null || "route-unavailable";
  const transcriber = get(localVoiceTranscriberAtom);
  return transcriber !== null && transcriber !== "checking";
});

/**
 * The app has one microphone and one dictation at a time, so the session
 * lives for the registry's lifetime rather than any screen's.
 */
const voiceInputAtom = Atom.make((get) => {
  const registry = get.registry;
  // Mounted so the recorder can read and remember microphones synchronously.
  get.mount(mobilePreferencesAtom);
  get.mount(updateMobilePreferencesAtom);
  const audioLevels = makeMutable<ReadonlyArray<number>>(
    Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0),
  );
  let keepAwakeSequence = 0;
  let audioToken: ReturnType<typeof acquireAudioSession> | null = null;
  const permission = createVoiceRecordingPermission(() => {
    void session.controller.appMovedToBackground();
  });
  const recorder = createLazyVoiceRecorder({
    getDestination: () => (registry.get(voiceRouteAtom) === null ? "local" : "environment"),
    create: (destination) =>
      destination === "local"
        ? createVoiceRecorder(VOICE_RECORDING_OPTIONS)
        : new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
    onStatus: (status: RecordingStatus) => {
      session.controller.handleRecorderStatus({
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
      const known = deviceMicrophoneOrder(preferences.value.microphones);
      const order = rememberMicrophones(known, inputs);
      if (order !== known) {
        registry.set(updateMobilePreferencesAtom, {
          transform: (current) => ({
            microphones: rememberMicrophones(deviceMicrophoneOrder(current.microphones), inputs),
          }),
        });
      }
      return preferredMicrophoneInput(inputs, order);
    },
  });
  const session: VoiceInputSession = new VoiceInputSession({
    recorder,
    getTranscriber: () => {
      // An environment the user chose beats the T3 Connect default; on-device is the fallback.
      const route = registry.get(voiceRouteAtom);
      if (route) return route.transcriber;
      const local = registry.get(localVoiceTranscriberAtom);
      return getRelayVoiceTranscriber(registry) ?? (local === "checking" ? null : local);
    },
    requestPermission: permission.requestPermission,
    configureRecording: async () => {
      const token = acquireAudioSession("recording");
      audioToken = token;
      try {
        await activateAudioSession(token);
      } catch (error) {
        await releaseAudioSession(token).catch(() => {});
        throw error;
      }
    },
    releaseRecording: async () => {
      if (audioToken) await releaseAudioSession(audioToken);
      audioToken = null;
    },
    deleteRecording: (uri) => new File(uri).delete(),
    sampleRecording: () => {
      const status = recorder.getStatus();
      return status?.isRecording
        ? { durationMillis: status.durationMillis, metering: status.metering }
        : null;
    },
    publishAudioLevels: (levels) => audioLevels.set(levels),
    keepAwake: () => keepScreenAwake(`voice-input:${++keepAwakeSequence}`),
  });
  get.subscribe(voiceRouteAtom, () => session.controller.cancel());
  get.addFinalizer(() => {
    permission.dispose();
    session.dispose();
    recorder.release();
  });
  return { session, audioLevels };
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-input"));

export function useGlobalVoiceInput() {
  const { session, audioLevels } = useAtomValue(voiceInputAtom);
  const isTranscriberAvailable = useAtomValue(voiceInputAvailableAtom);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
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
  return {
    ...snapshot,
    // T3 Connect voice input works on any device; on-device dictation needs
    // iOS 26 or Android 12. Store screenshots show the button even on simulators.
    isAvailable:
      isTranscriberAvailable === "route-unavailable"
        ? false
        : relayVoiceAvailable || isTranscriberAvailable || getNativeShowcaseScene() !== null,
    relayVoiceAvailable,
    audioLevels,
    isBusy: voiceInputBlocksSubmission(snapshot.state),
    session,
    stop: () => session.controller.stop(),
    cancel: () => session.controller.cancel(),
  };
}
