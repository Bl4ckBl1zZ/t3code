import {
  HermesSettings,
  type HermesGatewayCompatibility,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";

export interface HermesProviderConnection {
  readonly providerInstanceId: string;
  readonly displayName: string;
  readonly profileKey: string;
  readonly endpoint: string;
  readonly token: string;
}

export interface UnavailableHermesProvider {
  readonly providerInstanceId: string;
  readonly displayName: string;
  readonly profileKey: string;
  readonly diagnostic: string;
}

export interface HermesProviderDirectory {
  readonly ready: ReadonlyArray<HermesProviderConnection>;
  readonly unavailable: ReadonlyArray<UnavailableHermesProvider>;
}

const decodeHermesSettings = Schema.decodeUnknownSync(HermesSettings);

const gatewayTokenFromEnvironment = (
  environment: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly sensitive: boolean;
  }>,
) =>
  environment.find(
    (variable) =>
      variable.name === "HERMES_GATEWAY_TOKEN" &&
      variable.sensitive &&
      variable.value.trim().length > 0,
  )?.value;

export function resolveHermesProviderConnections(
  settings: ServerSettings,
): HermesProviderDirectory {
  const instances = deriveProviderInstanceConfigMap(settings);
  const ready: HermesProviderConnection[] = [];
  const unavailable: UnavailableHermesProvider[] = [];
  for (const [providerInstanceId, instance] of Object.entries(instances)) {
    if (instance.driver !== "hermes") continue;
    let config: HermesSettings;
    try {
      config = decodeHermesSettings(instance.config ?? {});
    } catch {
      unavailable.push({
        providerInstanceId,
        displayName: instance.displayName ?? providerInstanceId,
        profileKey: "unknown",
        diagnostic: "Hermes provider settings are invalid.",
      });
      continue;
    }
    const displayName = instance.displayName ?? providerInstanceId;
    const token = gatewayTokenFromEnvironment(instance.environment ?? []);
    if (instance.enabled !== true || !settings.enableHermes) {
      unavailable.push({
        providerInstanceId,
        displayName,
        profileKey: config.profileKey,
        diagnostic: "Hermes is disabled.",
      });
    } else if (!config.endpoint || !token) {
      unavailable.push({
        providerInstanceId,
        displayName,
        profileKey: config.profileKey,
        diagnostic: "Hermes gateway endpoint or sensitive token is not configured.",
      });
    } else {
      ready.push({
        providerInstanceId,
        displayName,
        profileKey: config.profileKey,
        endpoint: config.endpoint,
        token,
      });
    }
  }
  return { ready, unavailable };
}

export function hermesManageActionInventory(
  compatibility: HermesGatewayCompatibility,
  capability: string,
): ReadonlySet<string> {
  const actions = new Set<string>();
  const inventory = compatibility.inventory;
  const manage =
    inventory !== null && typeof inventory === "object" && !Array.isArray(inventory)
      ? (inventory as Readonly<Record<string, unknown>>)[capability]
      : undefined;
  const manageRecord =
    manage !== null && typeof manage === "object" && !Array.isArray(manage)
      ? (manage as Readonly<Record<string, unknown>>)
      : undefined;
  for (const candidate of [manageRecord?.actions, manageRecord?.operations]) {
    if (!Array.isArray(candidate)) continue;
    for (const action of candidate) {
      if (typeof action === "string") actions.add(action.toLowerCase());
    }
  }
  return actions;
}
