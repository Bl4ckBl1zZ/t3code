import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type {
  OpenRouterIntegrationStatus,
  OpenRouterModelCapability,
  OpenRouterModelOption,
  VoiceInputSettings,
  VoiceInputSettingsPatch,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResponse,
} from "@t3tools/contracts/voice";
import * as Effect from "effect/Effect";

import { runtime } from "../lib/runtime";
import { readManagedRelayClerkToken } from "./managedAuth";

async function withRelay<A>(
  operation: (
    client: ManagedRelay.ManagedRelayClient["Service"],
    clerkToken: string,
  ) => Effect.Effect<A, ManagedRelay.ManagedRelayClientError>,
): Promise<A> {
  const clerkToken = await readManagedRelayClerkToken();
  if (!clerkToken) throw new Error("Sign in to T3 Connect to use Voice Input.");
  return runtime.runPromise(
    ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => operation(client, clerkToken))),
  );
}

function unavailable<A>(): Effect.Effect<A, ManagedRelay.ManagedRelayClientError> {
  return Effect.die(new Error("The connected relay does not support Voice Input."));
}

export function getOpenRouterIntegration(): Promise<OpenRouterIntegrationStatus> {
  return withRelay(
    (client, clerkToken) => client.getOpenRouterIntegration?.({ clerkToken }) ?? unavailable(),
  );
}

export function putOpenRouterCredential(apiKey: string): Promise<OpenRouterIntegrationStatus> {
  return withRelay(
    (client, clerkToken) =>
      client.putOpenRouterCredential?.({ clerkToken, apiKey }) ?? unavailable(),
  );
}

export function validateOpenRouterCredential(): Promise<OpenRouterIntegrationStatus> {
  return withRelay(
    (client, clerkToken) => client.validateOpenRouterCredential?.({ clerkToken }) ?? unavailable(),
  );
}

export function deleteOpenRouterCredential(): Promise<OpenRouterIntegrationStatus> {
  return withRelay(
    (client, clerkToken) => client.deleteOpenRouterCredential?.({ clerkToken }) ?? unavailable(),
  );
}

export function getVoiceInputSettings(): Promise<VoiceInputSettings> {
  return withRelay(
    (client, clerkToken) => client.getVoiceInputSettings?.({ clerkToken }) ?? unavailable(),
  );
}

export function patchVoiceInputSettings(
  patch: VoiceInputSettingsPatch,
): Promise<VoiceInputSettings> {
  return withRelay(
    (client, clerkToken) =>
      client.patchVoiceInputSettings?.({ clerkToken, patch }) ?? unavailable(),
  );
}

export function listOpenRouterModels(
  capability: OpenRouterModelCapability,
): Promise<ReadonlyArray<OpenRouterModelOption>> {
  return withRelay(
    (client, clerkToken) =>
      client.listOpenRouterModels?.({ clerkToken, capability }) ?? unavailable(),
  );
}

export function transcribeVoice(
  request: VoiceTranscriptionRequest,
  _signal: AbortSignal,
): Promise<VoiceTranscriptionResponse> {
  return withRelay(
    (client, clerkToken) => client.transcribeVoice?.({ clerkToken, request }) ?? unavailable(),
  );
}
