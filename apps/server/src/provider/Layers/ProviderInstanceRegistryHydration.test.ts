import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const hermesId = ProviderInstanceId.make("hermes_local");

function settings(enableHermes: boolean, instanceEnabled: boolean | undefined): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    enableHermes,
    providerInstances: {
      [hermesId]: {
        driver: ProviderDriverKind.make("hermes"),
        ...(instanceEnabled === undefined ? {} : { enabled: instanceEnabled }),
        config: {
          endpoint: "ws://127.0.0.1:9119/api/ws",
          profileKey: "real-profile",
        },
      },
    },
  };
}

describe("Hermes provider-instance hydration gate", () => {
  it.each([
    { global: false, instance: true, expected: false },
    { global: true, instance: false, expected: false },
    { global: true, instance: undefined, expected: false },
    { global: true, instance: true, expected: true },
  ])(
    "requires global=$global and explicit instance=$instance",
    ({ global, instance, expected }) => {
      expect(deriveProviderInstanceConfigMap(settings(global, instance))[hermesId]?.enabled).toBe(
        expected,
      );
    },
  );

  it("applies both gates to the built-in Hermes instance", () => {
    const enabled = {
      ...DEFAULT_SERVER_SETTINGS,
      enableHermes: true,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        hermes: {
          ...DEFAULT_SERVER_SETTINGS.providers.hermes,
          enabled: true,
          endpoint: "ws://127.0.0.1:9119/api/ws",
        },
      },
    };
    const disabled = {
      ...enabled,
      enableHermes: false,
    };
    const defaultId = ProviderInstanceId.make("hermes");

    expect(deriveProviderInstanceConfigMap(enabled)[defaultId]?.enabled).toBe(true);
    expect(deriveProviderInstanceConfigMap(disabled)[defaultId]?.enabled).toBe(false);
  });

  it("requires an independent global and per-instance opt-in for remote Hermes", () => {
    const base: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableHermes: true,
      providerInstances: {
        [hermesId]: {
          driver: ProviderDriverKind.make("hermes"),
          enabled: true,
          config: {
            endpoint: "wss://gateway.example.com/api/ws",
            profileKey: "remote-profile",
            remoteAccessEnabled: true,
          },
        },
      },
    };
    const remoteInstance = base.providerInstances[hermesId]!;

    expect(deriveProviderInstanceConfigMap(base)[hermesId]?.enabled).toBe(false);
    expect(
      deriveProviderInstanceConfigMap({ ...base, enableRemoteHermes: true })[hermesId]?.enabled,
    ).toBe(true);
    expect(
      deriveProviderInstanceConfigMap({
        ...base,
        enableRemoteHermes: true,
        providerInstances: {
          [hermesId]: {
            ...remoteInstance,
            config: {
              ...(remoteInstance.config as Record<string, unknown>),
              remoteAccessEnabled: false,
            },
          },
        },
      })[hermesId]?.enabled,
    ).toBe(false);
  });
});

describe("per-project provider instance overrides", () => {
  const projectId = ProjectId.make("project-a");
  const workId = ProviderInstanceId.make("codex_work");
  const codex = ProviderDriverKind.make("codex");

  it("starts an instance the machine turned off when a project turns it on", () => {
    const base: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [workId]: { driver: codex, enabled: false, config: {} } },
    };
    expect(deriveProviderInstanceConfigMap(base)[workId]?.enabled).toBe(false);
    const overridden = {
      ...base,
      projectProviderInstanceOverrides: { [projectId]: { [workId]: { enabled: true } } },
    };
    expect(deriveProviderInstanceConfigMap(overridden)[workId]?.enabled).toBe(true);
  });

  it("clears a config-level off flag along with the envelope", () => {
    const map = deriveProviderInstanceConfigMap({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [workId]: { driver: codex, config: { enabled: false } } },
      projectProviderInstanceOverrides: { [projectId]: { [workId]: { enabled: true } } },
    });
    expect(map[workId]).toMatchObject({ enabled: true, config: { enabled: true } });
  });

  it("keeps a deleted instance out and leaves Hermes behind its rollout gate", () => {
    const map = deriveProviderInstanceConfigMap({
      ...settings(false, true),
      projectProviderInstanceOverrides: {
        [projectId]: { [workId]: { enabled: true }, [hermesId]: { enabled: true } },
      },
    });
    expect(map[workId]).toBeUndefined();
    expect(map[hermesId]?.enabled).toBe(false);
  });
});
