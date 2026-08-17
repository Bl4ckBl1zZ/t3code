import {
  EnvironmentId,
  isProviderAvailable,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "./hooks/useLocalStorage";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "./providerInstances";
import { HERMES_DRIVER_KIND } from "./t3WorkProject";

/**
 * The environment T3 Work and T3 Chat are scoped to.
 *
 * Both workspaces compose on one machine's Hermes, so the scope is a single
 * environment rather than "all of them". Persisted because re-picking the
 * machine on every reload is state the user already gave us once.
 */
export const WORK_ENVIRONMENT_SCOPE_STORAGE_KEY = "t3code:work-environment-scope";
const WORK_ENVIRONMENT_SCOPE_SCHEMA = Schema.NullOr(EnvironmentId);

/** The last environment the user picked for Work/Chat, `null` until they pick one. */
export function useWorkEnvironmentScopePreference() {
  return useLocalStorage(WORK_ENVIRONMENT_SCOPE_STORAGE_KEY, null, WORK_ENVIRONMENT_SCOPE_SCHEMA);
}

/** The ready Hermes instance a Work/Chat conversation would launch on, if any. */
export function findReadyHermesEntry(
  providers: ReadonlyArray<ServerProvider>,
): ProviderInstanceEntry | null {
  return (
    deriveProviderInstanceEntries(providers).find(
      (entry) =>
        entry.driverKind === HERMES_DRIVER_KIND &&
        entry.enabled &&
        entry.isAvailable &&
        entry.status === "ready",
    ) ?? null
  );
}

/**
 * A machine T3 Work can actually run on: a ready Hermes instance plus the
 * private work directory those conversations compose in. The backing project
 * is deliberately not required — it is created on demand the first time this
 * environment is scoped.
 */
export function hasValidHermesSetup(config: ServerConfig | undefined): boolean {
  if (config === undefined || config.t3WorkDirectory === undefined) return false;
  return config.providers.some(
    (provider) =>
      provider.driver === HERMES_DRIVER_KIND &&
      provider.enabled &&
      provider.status === "ready" &&
      isProviderAvailable(provider),
  );
}

export interface WorkEnvironmentScope<T> {
  /** Environments worth offering in the Work/Chat scope menu, in catalog order. */
  readonly options: ReadonlyArray<T>;
  /** The environment Work/Chat is scoped to; `null` only when nothing resolves yet. */
  readonly scopeId: EnvironmentId | null;
}

/**
 * Resolves which environment Work and Chat are looking at.
 *
 * The menu lists environments with a valid Hermes setup, plus any environment
 * that still owns visible Work/Chat threads — a machine that goes offline
 * loses its Hermes readiness, and hiding its conversations with no way back
 * would be a one-way door. The resolved scope prefers what the user last
 * picked, then the primary environment, then the first Hermes-ready one.
 * `null` means "nothing resolved yet", and callers leave the list unfiltered
 * rather than flashing an empty inbox during hydration.
 */
export function resolveWorkEnvironmentScope<
  T extends { readonly environmentId: EnvironmentId },
>(input: {
  readonly environments: ReadonlyArray<T>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly threadEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly storedEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): WorkEnvironmentScope<T> {
  const isHermesReady = (environmentId: EnvironmentId) =>
    hasValidHermesSetup(input.serverConfigs.get(environmentId));
  const options = input.environments.filter(
    (environment) =>
      isHermesReady(environment.environmentId) ||
      input.threadEnvironmentIds.has(environment.environmentId),
  );
  const stored =
    input.storedEnvironmentId !== null &&
    options.some((environment) => environment.environmentId === input.storedEnvironmentId)
      ? input.storedEnvironmentId
      : null;
  const scopeId =
    stored ??
    (input.primaryEnvironmentId !== null && isHermesReady(input.primaryEnvironmentId)
      ? input.primaryEnvironmentId
      : (options.find((environment) => isHermesReady(environment.environmentId))?.environmentId ??
        null));
  return { options, scopeId };
}
