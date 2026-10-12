import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

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

  it("keeps a deleted instance out", () => {
    const map = deriveProviderInstanceConfigMap({
      ...DEFAULT_SERVER_SETTINGS,
      projectProviderInstanceOverrides: { [projectId]: { [workId]: { enabled: true } } },
    });
    expect(map[workId]).toBeUndefined();
  });
});
