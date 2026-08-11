/**
 * One-time upload of pre-sync, device-local model visibility preferences.
 *
 * `providerModelPreferences` used to live in `ClientSettings`, so each device
 * kept its own copy: one per browser origin, one per desktop state dir, and
 * none at all on mobile — which is why models hidden on the desktop app kept
 * showing up in the native pickers. The setting is server-authoritative now,
 * but the values a user already configured only exist in those local stores,
 * so exactly one device has to hand its copy to the server.
 *
 * The rules below are deliberately order-independent: whichever device the
 * user happens to open first must not destroy what another one is holding.
 */
import type { ProviderModelPreferences } from "@t3tools/contracts/settings";

export type ProviderModelPreferencesMigrationAction = {
  /** Server patch to send, or `null` to leave the server untouched. */
  readonly upload: {
    readonly providerModelPreferences: ProviderModelPreferences;
    readonly providerModelPreferencesMigrated: true;
  } | null;
  /** Whether to drop the legacy device-local copy. */
  readonly clearLegacy: boolean;
};

const NO_ACTION: ProviderModelPreferencesMigrationAction = {
  upload: null,
  clearLegacy: false,
};

function isEmpty(preferences: ProviderModelPreferences): boolean {
  return Object.keys(preferences).length === 0;
}

export function resolveProviderModelPreferencesMigration(input: {
  /** The legacy device-local map, still decoded off this device's client store. */
  readonly legacyPreferences: ProviderModelPreferences;
  /** The live server-authoritative map. */
  readonly serverPreferences: ProviderModelPreferences;
  /** Whether some device has already handed its copy over. */
  readonly serverMigrated: boolean;
}): ProviderModelPreferencesMigrationAction {
  // Nothing local to donate. Notably we do *not* mark the migration done here:
  // a browser with no hides must not claim the migration and strand the
  // desktop copy the user actually cares about.
  if (isEmpty(input.legacyPreferences)) {
    return NO_ACTION;
  }

  // Someone already migrated, or the user has since configured this from a
  // synced client. The server wins; this device's copy is stale by definition,
  // so drop it rather than resurrecting hides the user may have undone.
  if (input.serverMigrated || !isEmpty(input.serverPreferences)) {
    return { upload: null, clearLegacy: true };
  }

  return {
    upload: {
      providerModelPreferences: input.legacyPreferences,
      providerModelPreferencesMigrated: true,
    },
    clearLegacy: true,
  };
}
