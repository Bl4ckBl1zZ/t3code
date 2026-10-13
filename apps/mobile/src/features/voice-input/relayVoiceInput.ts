import {
  describeManagedRelayVoiceFailure,
  managedRelaySessionAtom,
  transcribeManagedRelayVoice,
} from "@t3tools/client-runtime/relay";
import {
  VoiceTranscriptionError,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { File } from "expo-file-system";

import { runtime } from "../../lib/runtime";
import { uuidv4 } from "../../lib/uuid";
import { managedRelayQueryManager } from "../cloud/managedRelayState";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { createRelayVoiceTranscriber } from "./relayVoiceTranscriber";

function rejected(cause: Cause.Cause<unknown>): VoiceTranscriptionError {
  const failure = describeManagedRelayVoiceFailure(Cause.squash(cause));
  return new VoiceTranscriptionError("rejected", failure.message, { cause });
}

/**
 * T3 Connect voice input for the signed-in account, or null when signed out
 * or when the relay has voice input turned off, so on-device dictation is used.
 */
export function getRelayVoiceTranscriber(
  registry: AtomRegistry.AtomRegistry,
): VoiceTranscriber | null {
  if (!hasCloudPublicConfig()) return null;
  const session = registry.get(managedRelaySessionAtom);
  if (!session) return null;
  const statusAtom = managedRelayQueryManager.voiceInputAtom(session.accountId);
  const status = registry.get(statusAtom);
  if (AsyncResult.isSuccess(status) && !status.value.available) return null;

  return createRelayVoiceTranscriber({
    loadStatus: async (signal) => {
      const exit = await Effect.runPromiseExit(
        AtomRegistry.getResult(registry, statusAtom, { suspendOnWaiting: true }).pipe(
          Effect.timeout("15 seconds"),
        ),
        { signal },
      );
      if (Exit.isFailure(exit)) throw rejected(exit.cause);
      return exit.value;
    },
    readAudio: (uri) => new File(uri).base64(),
    transcribe: async (request, signal) => {
      const exit = await runtime.runPromiseExit(transcribeManagedRelayVoice(registry, request), {
        signal,
      });
      // Keep today's usage current for the next recording's status read.
      managedRelayQueryManager.refreshVoiceInput(registry, session.accountId);
      if (Exit.isFailure(exit)) throw rejected(exit.cause);
      return exit.value;
    },
    deviceLocale: () => Intl.DateTimeFormat().resolvedOptions().locale,
    requestId: uuidv4,
  });
}
