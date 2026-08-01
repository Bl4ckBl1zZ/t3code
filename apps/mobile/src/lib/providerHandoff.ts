import type {
  ModelSelection,
  ServerConfig as T3ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";

export interface CrossProviderHandoffPlan {
  readonly fromInstanceId: ModelSelection["instanceId"];
  readonly toInstanceId: ModelSelection["instanceId"];
  readonly fromLabel: string;
  readonly toLabel: string;
}

function providerLabel(provider: ServerProvider): string {
  return provider.displayName ?? provider.driver;
}

/**
 * Whether moving this thread to `nextModelSelection` requires a cross-provider
 * handoff instead of a plain model change. A started thread is bound to its
 * driver kind and to that driver's resume state, so crossing either boundary
 * means a fresh session — which only remembers the conversation if the
 * outgoing provider hands it a summary first.
 *
 * Mirrors `getCrossProviderHandoffPlan` in the web client; the server is
 * authoritative and rejects a plain model change that crosses the boundary.
 */
export function getCrossProviderHandoffPlan(input: {
  readonly serverConfig: T3ServerConfig | null | undefined;
  readonly threadHasStarted: boolean;
  readonly currentInstanceId: ModelSelection["instanceId"];
  readonly nextModelSelection: ModelSelection;
}): CrossProviderHandoffPlan | null {
  if (!input.threadHasStarted) {
    return null;
  }
  const toInstanceId = input.nextModelSelection.instanceId;
  if (input.currentInstanceId === toInstanceId) {
    return null;
  }
  const providers = input.serverConfig?.providers ?? [];
  const fromProvider = providers.find(
    (provider) => provider.instanceId === input.currentInstanceId,
  );
  const toProvider = providers.find((provider) => provider.instanceId === toInstanceId);
  // An unknown instance on either side means we cannot prove the switch needs
  // a handoff; let the existing path run and the server decide.
  if (!fromProvider || !toProvider) {
    return null;
  }
  const needsHandoff =
    fromProvider.driver !== toProvider.driver ||
    fromProvider.continuation?.groupKey !== toProvider.continuation?.groupKey;
  if (!needsHandoff) {
    return null;
  }
  return {
    fromInstanceId: input.currentInstanceId,
    toInstanceId,
    fromLabel: providerLabel(fromProvider),
    toLabel: providerLabel(toProvider),
  };
}
