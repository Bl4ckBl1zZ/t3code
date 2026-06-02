/**
 * Unified settings hook.
 *
 * Abstracts the split between server-authoritative settings (persisted in
 * `settings.json` on the server, fetched via `server.getConfig`) and the
 * legacy client settings cache used for migration/fallback.
 *
 * Consumers use `useSettings(selector)` to read, and `useUpdateSettings()` to
 * write. The hook transparently routes reads/writes to the correct backing
 * store.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  type ClientSettingsPatch,
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  SYNCED_CLIENT_SETTING_KEYS,
  UnifiedSettings,
} from "@t3tools/contracts/settings";
import { ensureLocalApi } from "~/localApi";
import * as Struct from "effect/Struct";
import * as Equal from "effect/Equal";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import {
  applySettingsUpdated,
  getServerConfig,
  onServerConfigUpdated,
  useServerConfigLoaded,
  useServerSettings,
} from "~/rpc/serverState";

const CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE = "[CLIENT_SETTINGS]";

const clientSettingsListeners = new Set<() => void>();
const clientSettingsHydrationListeners = new Set<() => void>();
let clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
let clientSettingsHydrated = false;
let clientSettingsHydrationPromise: Promise<void> | null = null;
let legacyClientSettingsMigrationAttempted = false;

const syncedClientSettingKeySet = new Set<string>(SYNCED_CLIENT_SETTING_KEYS);

function emitClientSettingsChange() {
  for (const listener of clientSettingsListeners) {
    listener();
  }
}

function emitClientSettingsHydrationChange() {
  for (const listener of clientSettingsHydrationListeners) {
    listener();
  }
}

function getClientSettingsSnapshot(): ClientSettings {
  return clientSettingsSnapshot;
}

function replaceClientSettingsSnapshot(settings: ClientSettings): void {
  clientSettingsSnapshot = settings;
  emitClientSettingsChange();
}

function setClientSettingsHydrated(nextHydrated: boolean): void {
  if (clientSettingsHydrated === nextHydrated) {
    return;
  }
  clientSettingsHydrated = nextHydrated;
  emitClientSettingsHydrationChange();
}

function subscribeClientSettings(listener: () => void): () => void {
  clientSettingsListeners.add(listener);
  void hydrateClientSettings();
  return () => {
    clientSettingsListeners.delete(listener);
  };
}

function getClientSettingsHydratedSnapshot(): boolean {
  return clientSettingsHydrated;
}

function subscribeClientSettingsHydration(listener: () => void): () => void {
  clientSettingsHydrationListeners.add(listener);
  void hydrateClientSettings();
  return () => {
    clientSettingsHydrationListeners.delete(listener);
  };
}

async function hydrateClientSettings(): Promise<void> {
  if (clientSettingsHydrated) {
    return;
  }
  if (clientSettingsHydrationPromise) {
    return clientSettingsHydrationPromise;
  }

  const nextHydration = (async () => {
    try {
      const persistedSettings = await ensureLocalApi().persistence.getClientSettings();
      if (persistedSettings) {
        replaceClientSettingsSnapshot({ ...DEFAULT_CLIENT_SETTINGS, ...persistedSettings });
      }
    } catch (error) {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} hydrate failed`, error);
    } finally {
      setClientSettingsHydrated(true);
      migrateLegacyClientSettingsToServer();
    }
  })();

  const hydrationPromise = nextHydration.finally(() => {
    if (clientSettingsHydrationPromise === hydrationPromise) {
      clientSettingsHydrationPromise = null;
    }
  });
  clientSettingsHydrationPromise = hydrationPromise;

  return clientSettingsHydrationPromise;
}

function persistClientSettings(settings: ClientSettings): void {
  replaceClientSettingsSnapshot(settings);
  void ensureLocalApi()
    .persistence.setClientSettings(settings)
    .catch((error) => {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} persist failed`, error);
    });
}

// ── Key sets for routing patches ─────────────────────────────────────

const SERVER_SETTINGS_KEYS = new Set<string>(Struct.keys(ServerSettings.fields));

function splitPatch(patch: Partial<UnifiedSettings>): {
  serverPatch: ServerSettingsPatch;
  clientPatch: ClientSettingsPatch;
} {
  const serverPatch: Record<string, unknown> = {};
  const clientPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SERVER_SETTINGS_KEYS.has(key)) {
      serverPatch[key] = value;
    } else {
      clientPatch[key] = value;
    }
  }
  return {
    serverPatch: serverPatch as ServerSettingsPatch,
    clientPatch: clientPatch as ClientSettingsPatch,
  };
}

function pickSyncedClientSettings(settings: ServerSettings): ClientSettings {
  const syncedSettings = { ...DEFAULT_CLIENT_SETTINGS } as Record<string, unknown>;
  const settingsRecord = settings as unknown as Record<string, unknown>;
  for (const key of SYNCED_CLIENT_SETTING_KEYS) {
    syncedSettings[key] = settingsRecord[key];
  }
  return syncedSettings as ClientSettings;
}

function buildLegacyClientSettingsMigrationPatch(
  localSettings: ClientSettings,
  serverSettings: ServerSettings,
): ServerSettingsPatch {
  const patch: Record<string, unknown> = {};
  const localRecord = localSettings as unknown as Record<string, unknown>;
  const clientDefaults = DEFAULT_CLIENT_SETTINGS as unknown as Record<string, unknown>;
  const serverRecord = serverSettings as unknown as Record<string, unknown>;
  const serverDefaults = DEFAULT_SERVER_SETTINGS as unknown as Record<string, unknown>;

  for (const key of SYNCED_CLIENT_SETTING_KEYS) {
    const localValue = localRecord[key];
    if (Equal.equals(localValue, clientDefaults[key])) {
      continue;
    }
    if (!Equal.equals(serverRecord[key], serverDefaults[key])) {
      continue;
    }
    patch[key] = localValue;
  }

  return patch as ServerSettingsPatch;
}

function migrateLegacyClientSettingsToServer(): void {
  if (legacyClientSettingsMigrationAttempted || !clientSettingsHydrated) {
    return;
  }

  const currentServerConfig = getServerConfig();
  if (!currentServerConfig) {
    return;
  }

  const patch = buildLegacyClientSettingsMigrationPatch(
    getClientSettingsSnapshot(),
    currentServerConfig.settings,
  );
  if (Object.keys(patch).length === 0) {
    legacyClientSettingsMigrationAttempted = true;
    return;
  }

  legacyClientSettingsMigrationAttempted = true;
  applySettingsUpdated(applyServerSettingsPatch(currentServerConfig.settings, patch));
  void ensureLocalApi()
    .server.updateSettings(patch)
    .catch((error) => {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} migration failed`, error);
    });
}

onServerConfigUpdated(() => {
  migrateLegacyClientSettingsToServer();
});

// ── Hooks ────────────────────────────────────────────────────────────

/**
 * Read merged settings. Selector narrows the subscription so components
 * only re-render when the slice they care about changes.
 */

/**
 * Non-hook accessor for the current merged client settings snapshot.
 * Used by non-React code paths (e.g. runtime services) that need the latest
 * settings without subscribing.
 */
export function getClientSettings(): ClientSettings {
  const serverConfig = getServerConfig();
  if (!serverConfig) {
    return getClientSettingsSnapshot();
  }

  return {
    ...getClientSettingsSnapshot(),
    ...pickSyncedClientSettings(serverConfig.settings),
  };
}

export function useClientSettingsHydrated(): boolean {
  return useSyncExternalStore(
    subscribeClientSettingsHydration,
    getClientSettingsHydratedSnapshot,
    () => false,
  );
}

export function useSettings<T = UnifiedSettings>(selector?: (s: UnifiedSettings) => T): T {
  const serverConfigLoaded = useServerConfigLoaded();
  const serverSettings = useServerSettings();
  const clientSettings = useSyncExternalStore(
    subscribeClientSettings,
    getClientSettingsSnapshot,
    () => DEFAULT_CLIENT_SETTINGS,
  );

  const merged = useMemo<UnifiedSettings>(
    () =>
      serverConfigLoaded
        ? {
            ...clientSettings,
            ...serverSettings,
          }
        : {
            ...serverSettings,
            ...clientSettings,
          },
    [clientSettings, serverConfigLoaded, serverSettings],
  );

  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

/**
 * Returns an updater that routes each key to the correct backing store.
 *
 * Server keys are optimistically patched in atom-backed server state, then
 * persisted via RPC. Client keys go through client persistence.
 */
export function useUpdateSettings() {
  const updateSettings = useCallback((patch: Partial<UnifiedSettings>) => {
    const { serverPatch, clientPatch } = splitPatch(patch);

    if (Object.keys(serverPatch).length > 0) {
      const currentServerConfig = getServerConfig();
      if (currentServerConfig) {
        applySettingsUpdated(applyServerSettingsPatch(currentServerConfig.settings, serverPatch));
      }
      // Fire-and-forget RPC — push will reconcile on success
      void ensureLocalApi().server.updateSettings(serverPatch);
    }

    if (Object.keys(clientPatch).length > 0) {
      persistClientSettings({
        ...getClientSettingsSnapshot(),
        ...Object.fromEntries(
          Object.entries(clientPatch).filter(([key]) => !syncedClientSettingKeySet.has(key)),
        ),
      });
    }
  }, []);

  const resetSettings = useCallback(() => {
    updateSettings(DEFAULT_UNIFIED_SETTINGS);
  }, [updateSettings]);

  return {
    updateSettings,
    resetSettings,
  };
}

export function __resetClientSettingsPersistenceForTests(): void {
  clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
  clientSettingsHydrated = false;
  clientSettingsHydrationPromise = null;
  legacyClientSettingsMigrationAttempted = false;
  clientSettingsListeners.clear();
  clientSettingsHydrationListeners.clear();
}
