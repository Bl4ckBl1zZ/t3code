import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProjectProviderRows,
  projectProviderOverridePatch,
} from "./ProjectProviderSettings.logic";

const codex = ProviderInstanceId.make("codex");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const provider = (instanceId: string, driver: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-12T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

describe("project provider switches", () => {
  it("reads each instance's project choice next to the machine's", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerInstances: { [codex]: { driver: ProviderDriverKind.make("codex"), enabled: false } },
      ...projectProviderOverridePatch([projectA], codex, "on"),
    });
    const rows = deriveProjectProviderRows([
      {
        projectIds: [projectA],
        settings,
        providers: [provider("codex", "codex")],
      },
    ]);
    expect(rows).toEqual([
      { instanceId: codex, displayName: expect.any(String), choice: "on", machineEnabled: false },
    ]);
  });

  it("reports checkouts that disagree as mixed and resets only the chosen instance", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      ...projectProviderOverridePatch([projectA], codex, "off"),
    });
    const [row] = deriveProjectProviderRows([
      { projectIds: [projectA, projectB], settings, providers: [provider("codex", "codex")] },
    ]);
    expect(row?.choice).toBe("mixed");

    const reset = applyServerSettingsPatch(
      settings,
      projectProviderOverridePatch([projectA, projectB], codex, "inherit"),
    );
    expect(reset.projectProviderInstanceOverrides).toEqual({});
  });
});
