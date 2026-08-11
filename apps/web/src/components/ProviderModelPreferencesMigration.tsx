import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

import { primaryServerConfigAtom } from "../state/server";
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
