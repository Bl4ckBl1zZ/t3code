import { managedRelaySessionAtom, ManagedRelay } from "@t3tools/client-runtime/relay";
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

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";

async function withRelay<A>(
  operation: (
    client: ManagedRelay.ManagedRelayClient["Service"],
    clerkToken: string,
  ) => Effect.Effect<A, ManagedRelay.ManagedRelayClientError>,
): Promise<A> {
  const session = appAtomRegistry.get(managedRelaySessionAtom);
  const clerkToken = session ? await runtime.runPromise(session.readClerkToken()) : null;
  if (!clerkToken) throw new Error("Sign in to T3 Connect to use Voice Input.");
  return runtime.runPromise(
    ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => operation(client, clerkToken))),
  );
}

function unavailable<A>(): Effect.Effect<A, ManagedRelay.ManagedRelayClientError> {
  return Effect.die(new Error("The connected relay does not support Voice Input."));
}

export const getOpenRouterIntegration = (): Promise<OpenRouterIntegrationStatus> =>
  withRelay(
    (client, clerkToken) => client.getOpenRouterIntegration?.({ clerkToken }) ?? unavailable(),
  );

export const putOpenRouterCredential = (apiKey: string): Promise<OpenRouterIntegrationStatus> =>
  withRelay(
    (client, clerkToken) =>
      client.putOpenRouterCredential?.({ clerkToken, apiKey }) ?? unavailable(),
  );

export const validateOpenRouterCredential = (): Promise<OpenRouterIntegrationStatus> =>
  withRelay(
    (client, clerkToken) => client.validateOpenRouterCredential?.({ clerkToken }) ?? unavailable(),
  );

export const deleteOpenRouterCredential = (): Promise<OpenRouterIntegrationStatus> =>
  withRelay(
    (client, clerkToken) => client.deleteOpenRouterCredential?.({ clerkToken }) ?? unavailable(),
  );

export const getVoiceInputSettings = (): Promise<VoiceInputSettings> =>
  withRelay(
    (client, clerkToken) => client.getVoiceInputSettings?.({ clerkToken }) ?? unavailable(),
  );

export const patchVoiceInputSettings = (
  patch: VoiceInputSettingsPatch,
): Promise<VoiceInputSettings> =>
  withRelay(
    (client, clerkToken) =>
      client.patchVoiceInputSettings?.({ clerkToken, patch }) ?? unavailable(),
  );

export const listOpenRouterModels = (
  capability: OpenRouterModelCapability,
): Promise<ReadonlyArray<OpenRouterModelOption>> =>
  withRelay(
    (client, clerkToken) =>
      client.listOpenRouterModels?.({ clerkToken, capability }) ?? unavailable(),
  );

export const transcribeVoice = (
  request: VoiceTranscriptionRequest,
): Promise<VoiceTranscriptionResponse> =>
  withRelay(
    (client, clerkToken) => client.transcribeVoice?.({ clerkToken, request }) ?? unavailable(),
  );
