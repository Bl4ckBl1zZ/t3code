import {
  ManagedRelay,
  ManagedRelaySessionError,
  relayProtectedErrorMessage,
  relayVoiceInputErrorIsRetryable,
  relayVoiceInputErrorMessage,
  transcribeManagedRelayVoice,
} from "@t3tools/client-runtime/relay";
import { RelayVoiceInputError, type VoiceTranscriptionRequest } from "@t3tools/contracts/relay";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { refreshManagedRelayVoiceInput } from "../cloud/managedRelayState";
import { randomUUID } from "../lib/utils";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  startWebVoiceRecording,
  type WebVoiceClip,
  type WebVoiceRecording,
} from "./webVoiceRecorder";

/**
 * The app's one voice recording. It lives outside React so switching threads
 * or remounting the composer does not drop audio: the transcript goes to the
 * composer that started it when that composer is mounted, and otherwise into
 * its stored draft.
 */

export type VoiceSessionState =
  | { readonly phase: "idle" }
  | { readonly phase: "starting"; readonly targetKey: string }
  | {
      readonly phase: "recording";
      readonly targetKey: string;
      readonly startedAt: number;
      readonly maxSeconds: number;
      /** Push-to-talk: releasing the button stops the recording. */
      readonly hold: boolean;
    }
  | { readonly phase: "transcribing"; readonly targetKey: string }
  | {
      readonly phase: "failed";
      readonly targetKey: string;
      readonly message: string;
      /** The clip is kept and can be sent again. */
      readonly canRetry: boolean;
    };

export interface VoiceTarget {
  /** The composer draft the transcript belongs to. */
  readonly key: string;
  /** Spoken-language hint, used for word spacing when inserting. */
  readonly locale: string;
  readonly maxClipSeconds: number;
  /** Used when no composer for `key` is mounted when the transcript arrives. */
  readonly deliverOffscreen: (text: string) => void;
}

type ComposerDelivery = (text: string, locale: string) => void;

const IDLE: VoiceSessionState = { phase: "idle" };
const isRelayVoiceInputError = Schema.is(RelayVoiceInputError);
const isRequestTimeout = Schema.is(ManagedRelay.ManagedRelayRequestTimeoutError);
const isRequestFailed = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);

let state: VoiceSessionState = IDLE;
const stateListeners = new Set<() => void>();
const levelListeners = new Set<(level: number) => void>();
const composers = new Map<string, ComposerDelivery>();

let generation = 0;
let target: VoiceTarget | null = null;
let recording: WebVoiceRecording | null = null;
let clipTimer: number | null = null;
let transcription: AbortController | null = null;
let pendingClip: { readonly clip: WebVoiceClip; readonly requestId: string } | null = null;

function setState(next: VoiceSessionState): void {
  state = next;
  for (const listener of stateListeners) listener();
}

function subscribe(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export function getVoiceSessionState(): VoiceSessionState {
  return state;
}

export function useVoiceSession(): VoiceSessionState {
  return useSyncExternalStore(subscribe, getVoiceSessionState);
}

/** Microphone level 0..1, only while recording. */
export function subscribeVoiceLevel(listener: (level: number) => void): () => void {
  levelListeners.add(listener);
  return () => levelListeners.delete(listener);
}

/** Routes transcripts for `key` to a mounted composer until the returned cleanup runs. */
export function bindVoiceComposer(key: string, deliver: ComposerDelivery): () => void {
  composers.set(key, deliver);
  return () => {
    if (composers.get(key) === deliver) composers.delete(key);
  };
}

function clearClipTimer(): void {
  if (clipTimer !== null) window.clearTimeout(clipTimer);
  clipTimer = null;
}

function failureFromCause(cause: unknown): { message: string; canRetry: boolean } {
  if (isRelayVoiceInputError(cause)) {
    return {
      message: relayVoiceInputErrorMessage(cause),
      canRetry: relayVoiceInputErrorIsRetryable(cause),
    };
  }
  if (cause instanceof ManagedRelaySessionError) {
    return { message: "Sign in to T3 Connect to use voice input.", canRetry: false };
  }
  if (isRequestTimeout(cause)) {
    return { message: "Transcription timed out.", canRetry: true };
  }
  if (isRequestFailed(cause)) {
    return {
      message: cause.relayError ? relayProtectedErrorMessage(cause.relayError) : cause.message,
      canRetry: cause.transportFailed === true || cause.relayError === undefined,
    };
  }
  return { message: "Transcription failed.", canRetry: true };
}

async function transcribe(
  current: VoiceTarget,
  clip: WebVoiceClip,
  requestId: string,
): Promise<void> {
  const operation = ++generation;
  const abort = new AbortController();
  transcription = abort;
  pendingClip = { clip, requestId };
  setState({ phase: "transcribing", targetKey: current.key });
  const request: VoiceTranscriptionRequest = {
    requestId,
    audio: { data: clip.data, format: "wav" },
    durationSeconds: Math.max(clip.durationSeconds, 0.1),
  };
  const exit = await runtime.runPromiseExit(transcribeManagedRelayVoice(appAtomRegistry, request), {
    signal: abort.signal,
  });
  if (operation !== generation) return;
  transcription = null;
  refreshManagedRelayVoiceInput();
  if (Exit.isFailure(exit)) {
    const failure = failureFromCause(Cause.squash(exit.cause));
    if (!failure.canRetry) pendingClip = null;
    setState({ phase: "failed", targetKey: current.key, ...failure });
    return;
  }
  pendingClip = null;
  target = null;
  setState(IDLE);
  const deliver = composers.get(current.key);
  if (deliver) deliver(exit.value.text, current.locale);
  else current.deliverOffscreen(exit.value.text);
}

/** Opens the microphone and records into `next`. Ignored while another recording is busy. */
export async function startVoiceRecording(next: VoiceTarget): Promise<void> {
  if (state.phase !== "idle" && state.phase !== "failed") return;
  const operation = ++generation;
  target = next;
  pendingClip = null;
  setState({ phase: "starting", targetKey: next.key });
  let started: WebVoiceRecording;
  try {
    started = await startWebVoiceRecording({
      onLevel: (level) => {
        for (const listener of levelListeners) listener(level);
      },
      onInterrupted: () => void stopVoiceRecording(),
    });
  } catch (cause) {
    if (operation !== generation) return;
    target = null;
    setState({
      phase: "failed",
      targetKey: next.key,
      message: cause instanceof Error ? cause.message : "The microphone could not start.",
      canRetry: false,
    });
    return;
  }
  if (operation !== generation) {
    started.cancel();
    return;
  }
  recording = started;
  clipTimer = window.setTimeout(() => void stopVoiceRecording(), next.maxClipSeconds * 1_000);
  setState({
    phase: "recording",
    targetKey: next.key,
    startedAt: Date.now(),
    maxSeconds: next.maxClipSeconds,
    hold: false,
  });
}

/** Marks the active recording as push-to-talk so the UI can offer slide-to-cancel. */
export function holdVoiceRecording(): void {
  if (state.phase === "recording" && !state.hold) setState({ ...state, hold: true });
}

/** Stops recording and transcribes. Stopping before the microphone opened discards. */
export async function stopVoiceRecording(): Promise<void> {
  if (state.phase === "starting") {
    cancelVoiceRecording();
    return;
  }
  if (state.phase !== "recording" || !recording || !target) return;
  const current = target;
  const active = recording;
  recording = null;
  clearClipTimer();
  const operation = ++generation;
  setState({ phase: "transcribing", targetKey: current.key });
  let clip: WebVoiceClip;
  try {
    clip = await active.stop();
  } catch {
    if (operation !== generation) return;
    target = null;
    setState({
      phase: "failed",
      targetKey: current.key,
      message: "The recording could not be read.",
      canRetry: false,
    });
    return;
  }
  if (operation !== generation) return;
  await transcribe(current, clip, randomUUID());
}

/** Sends the last clip again with the same request id, so the relay never bills it twice. */
export async function retryVoiceTranscription(): Promise<void> {
  if (state.phase !== "failed" || !state.canRetry || !pendingClip || !target) return;
  await transcribe(target, pendingClip.clip, pendingClip.requestId);
}

/** Drops the recording, the transcription in flight, or the error. */
export function cancelVoiceRecording(): void {
  generation += 1;
  clearClipTimer();
  recording?.cancel();
  recording = null;
  transcription?.abort();
  transcription = null;
  pendingClip = null;
  target = null;
  if (state.phase !== "idle") setState(IDLE);
}
