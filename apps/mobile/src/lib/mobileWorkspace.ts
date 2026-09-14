import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isProviderAvailable,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";

export type MobileWorkspace = "work" | "code";

export function mobileProviderInstanceKey(
  environmentId: EnvironmentId,
  providerInstanceId: ProviderInstanceId,
): string {
  return `${environmentId}\u0000${providerInstanceId}`;
}

export function buildProviderDriverMap(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
): ReadonlyMap<string, ProviderDriverKind> {
  const drivers = new Map<string, ProviderDriverKind>();
  for (const [environmentId, config] of serverConfigs) {
    for (const provider of config.providers) {
      drivers.set(mobileProviderInstanceKey(environmentId, provider.instanceId), provider.driver);
    }
  }
  return drivers;
}

export function isHermesThread(
  thread: Pick<
    EnvironmentThreadShell,
    "environmentId" | "providerInstanceId" | "modelSelection" | "runtime"
  >,
  providerDrivers: ReadonlyMap<string, ProviderDriverKind>,
): boolean {
  const providerInstanceId =
    thread.runtime?.providerInstanceId ??
    thread.providerInstanceId ??
    thread.modelSelection.instanceId;
  const driver = providerDrivers.get(
    mobileProviderInstanceKey(thread.environmentId, providerInstanceId),
  );
  // Cached shells can arrive before server config. The canonical legacy
  // instance id is a safe fallback; custom instance ids wait for metadata.
  return driver === "hermes" || (driver === undefined && providerInstanceId === "hermes");
}

export function isHermesProviderInstance(
  environmentId: EnvironmentId,
  providerInstanceId: ProviderInstanceId,
  providerDrivers: ReadonlyMap<string, ProviderDriverKind>,
): boolean {
  const driver = providerDrivers.get(mobileProviderInstanceKey(environmentId, providerInstanceId));
  return driver === "hermes" || (driver === undefined && providerInstanceId === "hermes");
}

export function isMobileWorkspaceThread(
  thread: Pick<
    EnvironmentThreadShell,
    "archivedAt" | "environmentId" | "lineage" | "providerInstanceId" | "modelSelection" | "runtime"
  >,
  workspace: MobileWorkspace,
  providerDrivers: ReadonlyMap<string, ProviderDriverKind>,
): boolean {
  if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent") {
    return false;
  }
  const isHermes = isHermesThread(thread, providerDrivers);
  return workspace === "work" ? isHermes : !isHermes;
}

/**
 * Archived, parked, or finished work does not offer the pin affordance.
 */
export function canPinMobileWorkThread(input: {
  readonly thread: Pick<
    EnvironmentThreadShell,
    | "archivedAt"
    | "environmentId"
    | "lineage"
    | "providerInstanceId"
    | "modelSelection"
    | "runtime"
    | "workInboxRole"
  >;
  readonly providerDrivers: ReadonlyMap<string, ProviderDriverKind>;
  readonly isSnoozed: boolean;
  readonly isSettled: boolean;
}): boolean {
  return (
    input.thread.archivedAt === null &&
    input.thread.lineage.relationshipToParent !== "subagent" &&
    isHermesThread(input.thread, input.providerDrivers) &&
    !input.isSnoozed &&
    !input.isSettled
  );
}

/**
 * A T3 Work conversation routes through a backing project that exists only to
 * own the thread: the Work composer hides the Workspace pill and the launch
 * path sends `prepareWorkspace: false`, so there is no way to pick a base
 * branch and the server rejects a worktree strategy outright. Honouring a
 * server-configured `worktree` default there would leave the composer's send
 * gate permanently disabled, so Work always resolves to the current checkout.
 */
export function resolveDraftWorkspaceMode(input: {
  readonly isWorkConversation: boolean;
  readonly requestedMode: "local" | "worktree";
}): "local" | "worktree" {
  return input.isWorkConversation ? "local" : input.requestedMode;
}

/** Selects an available environment; the server owns profile and session creation. */
export function resolveHermesConversationTarget(input: {
  readonly serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly requiredEnvironmentId: EnvironmentId | null;
  readonly requiredProviderInstanceId?: string;
}) {
  for (const [environmentId, config] of input.serverConfigs) {
    if (input.requiredEnvironmentId !== null && environmentId !== input.requiredEnvironmentId)
      continue;
    const provider = config.providers.find(
      (provider) =>
        provider.driver === "hermes" &&
        (input.requiredProviderInstanceId === undefined ||
          provider.instanceId === input.requiredProviderInstanceId) &&
        provider.enabled &&
        provider.installed &&
        provider.status === "ready" &&
        isProviderAvailable(provider),
    );
    if (provider) return { environmentId, providerInstanceId: provider.instanceId };
  }
  return null;
}
