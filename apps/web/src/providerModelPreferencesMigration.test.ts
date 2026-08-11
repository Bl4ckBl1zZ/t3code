import { describe, expect, it } from "vite-plus/test";
import type { ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderModelPreferences } from "@t3tools/contracts/settings";

import { resolveProviderModelPreferencesMigration } from "./providerModelPreferencesMigration";

const hermes = "hermes" as ProviderInstanceId;

const withHides = (...hiddenModels: string[]): ProviderModelPreferences =>
  ({ [hermes]: { hiddenModels, modelOrder: [] } }) as ProviderModelPreferences;

const EMPTY: ProviderModelPreferences = {} as ProviderModelPreferences;

describe("resolveProviderModelPreferencesMigration", () => {
  it("uploads the device-local copy when the server has never been migrated", () => {
    expect(
      resolveProviderModelPreferencesMigration({
        legacyPreferences: withHides("claude-3-opus"),
        serverPreferences: EMPTY,
        serverMigrated: false,
      }),
    ).toEqual({
      upload: {
        providerModelPreferences: withHides("claude-3-opus"),
        providerModelPreferencesMigrated: true,
      },
      clearLegacy: true,
    });
  });

  it("does not claim the migration from a device with nothing to donate", () => {
    // A browser with no hides must leave the flag alone, or the desktop copy
    // the user actually configured would be stranded and then cleared.
    expect(
      resolveProviderModelPreferencesMigration({
        legacyPreferences: EMPTY,
        serverPreferences: EMPTY,
        serverMigrated: false,
      }),
    ).toEqual({ upload: null, clearLegacy: false });
  });

  it("drops a stale local copy once another device has migrated", () => {
    expect(
      resolveProviderModelPreferencesMigration({
        legacyPreferences: withHides("gpt-4"),
        serverPreferences: EMPTY,
        serverMigrated: true,
      }),
    ).toEqual({ upload: null, clearLegacy: true });
  });

  it("never overwrites preferences the user has already configured on the server", () => {
    expect(
      resolveProviderModelPreferencesMigration({
        legacyPreferences: withHides("gpt-4"),
        serverPreferences: withHides("claude-3-opus"),
        serverMigrated: false,
      }),
    ).toEqual({ upload: null, clearLegacy: true });
  });

  it("does not resurrect hides the user cleared after migrating", () => {
    // Server map is empty because the user un-hid everything; the flag is what
    // stops a stale device from putting the old hides back.
    expect(
      resolveProviderModelPreferencesMigration({
        legacyPreferences: withHides("gpt-4"),
        serverPreferences: EMPTY,
        serverMigrated: true,
      }).upload,
    ).toBeNull();
  });
});
