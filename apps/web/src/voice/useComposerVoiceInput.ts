import { useCallback, useEffect, useMemo, useRef } from "react";

import { useManagedRelayVoiceInput } from "../cloud/managedRelayState";
import {
  resolveComposerDraftKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "../composerDraftStore";
import { toastManager } from "../components/ui/toast";
import { voiceTranscriptInsertion } from "./voiceTranscriptInsertion";
import {
  bindVoiceComposer,
  getVoiceSessionState,
  startVoiceRecording,
  stopVoiceRecording,
  type VoiceTarget,
} from "./webVoiceSession";

/** Adds a transcript to a draft whose composer is not on screen. */
function appendTranscriptToStoredDraft(
  draftTarget: ComposerThreadTarget,
  transcript: string,
  locale: string,
): void {
  const store = useComposerDraftStore.getState();
  const key = resolveComposerDraftKey(store, draftTarget);
  const prompt = (key ? store.draftsByThreadKey[key]?.prompt : undefined) ?? "";
  const insertion = voiceTranscriptInsertion({
    value: prompt,
    position: prompt.length,
    transcript,
    locale,
  });
  if (insertion === null) return;
  store.setPrompt(draftTarget, prompt + insertion);
  toastManager.add({
    type: "info",
    title: "Voice transcript added",
    description: "It is in the draft of the conversation you dictated it for.",
  });
}

/**
 * Connects a composer to relay voice input. `target` is null while voice is
 * unavailable: signed out of T3 Connect, or turned off on the relay.
 */
export function useComposerVoiceInput(input: {
  readonly draftTarget: ComposerThreadTarget;
  readonly draftKey: string;
  readonly readSnapshot: () => { readonly value: string; readonly expandedCursor: number };
  readonly replaceRange: (start: number, end: number, text: string) => boolean;
}) {
  const { data: status } = useManagedRelayVoiceInput();
  const { draftTarget, draftKey, readSnapshot, replaceRange } = input;
  const anchorRef = useRef<{ readonly value: string; readonly position: number } | null>(null);

  const available = status?.available === true;
  const language = status?.settings.language ?? null;
  const maxClipSeconds = status?.limits.maxClipSeconds ?? null;
  const target = useMemo<VoiceTarget | null>(
    () =>
      available && maxClipSeconds !== null
        ? {
            key: draftKey,
            locale: language ?? navigator.language,
            maxClipSeconds,
            deliverOffscreen: (text) =>
              appendTranscriptToStoredDraft(draftTarget, text, language ?? navigator.language),
          }
        : null,
    [available, draftKey, draftTarget, language, maxClipSeconds],
  );

  // Remember where the caret was when dictation started; the transcript goes
  // there unless the draft changed meanwhile, then to the current caret.
  const captureAnchor = useCallback(() => {
    const snapshot = readSnapshot();
    anchorRef.current = { value: snapshot.value, position: snapshot.expandedCursor };
  }, [readSnapshot]);

  useEffect(
    () =>
      bindVoiceComposer(draftKey, (text, locale) => {
        const anchor = anchorRef.current;
        anchorRef.current = null;
        const snapshot = readSnapshot();
        const position =
          anchor && anchor.value === snapshot.value ? anchor.position : snapshot.expandedCursor;
        const insertion = voiceTranscriptInsertion({
          value: snapshot.value,
          position,
          transcript: text,
          locale,
        });
        if (insertion === null) return;
        if (!replaceRange(position, position, insertion)) {
          toastManager.add({
            type: "warning",
            title: "Could not insert the voice transcript here",
            description: text,
          });
        }
      }),
    [draftKey, readSnapshot, replaceRange],
  );

  /** Starts hands-free dictation, or stops the active recording. */
  const toggle = useCallback(() => {
    const session = getVoiceSessionState();
    if (session.phase === "recording") {
      void stopVoiceRecording();
      return;
    }
    if (!target || (session.phase !== "idle" && session.phase !== "failed")) return;
    captureAnchor();
    void startVoiceRecording(target);
  }, [captureAnchor, target]);

  return { target, captureAnchor, toggle };
}
