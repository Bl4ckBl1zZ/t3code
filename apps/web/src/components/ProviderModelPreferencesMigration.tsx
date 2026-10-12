import { useAtomValue } from "@effect/atom-react";
import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { modelPreferencesMigrationPatch } from "@t3tools/shared/serverSettings";
import { useEffect, useRef } from "react";

import { useEnvironments } from "../state/environments";
import { primaryServerConfigAtom, serverEnvironment } from "../state/server";
import { readEnvironmentScopeDenied } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
  useUpdatePrimarySettings,
} from "../hooks/useSettings";
import { resolveProviderModelPreferencesMigration } from "../providerModelPreferencesMigration";

/**
 * Hands this device's pre-sync model visibility preferences to the server once.
 * Renders nothing. See `providerModelPreferencesMigration.ts` for the rules.
 */
export function ProviderModelPreferencesMigration() {
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const clientSettingsHydrated = useClientSettingsHydrated();
  const legacyPreferences = useClientSettings((settings) => settings.providerModelPreferences);
  const updatePrimarySettings = useUpdatePrimarySettings();
  const updateClientSettings = useUpdateClientSettings();
  const attempted = useRef(false);

  useEffect(() => {
    // Both stores have to be real before we compare them. Against an unloaded
    // server config the map reads as empty, and this would upload a stale
    // local copy over settings that were simply still in flight.
    if (attempted.current || !clientSettingsHydrated || !serverConfig) {
      return;
    }

    const action = resolveProviderModelPreferencesMigration({
      legacyPreferences,
      serverPreferences: serverConfig.settings.providerModelPreferences,
      serverMigrated: serverConfig.settings.providerModelPreferencesMigrated,
    });

    // Latch on the first real evaluation, not on the first render, so a
    // reconnect that transiently swaps the config cannot run this twice.
    attempted.current = true;

    if (action.upload) {
      updatePrimarySettings(action.upload);
    }
    if (action.clearLegacy) {
      updateClientSettings({ providerModelPreferences: {} });
    }
  }, [
    clientSettingsHydrated,
    legacyPreferences,
    serverConfig,
    updateClientSettings,
    updatePrimarySettings,
  ]);

  return null;
}

/** Environments with a favorites seed in flight, so overlapping renders do not send it twice. */
const seedingFavorites = new Set<EnvironmentId>();

/**
 * Seeds this device's pre-sync model favorites into every connected
 * environment that has none yet. Renders nothing.
 *
 * The server applies a seed only while its list is still unset, so a slow
 * device cannot undo favorites another client already edited or cleared. The
 * legacy copy is kept: an environment connected later still needs it.
 */
export function ModelFavoritesMigration() {
  const { environments } = useEnvironments();
  const clientSettingsHydrated = useClientSettingsHydrated();
  const legacyFavorites = useClientSettings((settings) => settings.favorites);
  const seed = useAtomCommand(serverEnvironment.updateSettings, {
    label: "model favorites seed",
    reportFailure: false,
  });

  useEffect(() => {
    if (!clientSettingsHydrated) return;
    for (const environment of environments) {
      const settings = environment.serverConfig?.settings;
      const environmentId = environment.environmentId;
      if (!settings || seedingFavorites.has(environmentId)) continue;
      const patch = modelPreferencesMigrationPatch(settings, { favorites: legacyFavorites });
      if (!patch || readEnvironmentScopeDenied(environmentId, AuthSettingsWriteScope)) continue;
      seedingFavorites.add(environmentId);
      void seed({ environmentId, input: { patch } }).finally(() =>
        seedingFavorites.delete(environmentId),
      );
    }
  }, [clientSettingsHydrated, environments, legacyFavorites, seed]);

  return null;
}
