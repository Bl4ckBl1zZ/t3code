import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { AGENT_ACTIVITY_REPORT_TTL_MS, canAutoInstall } from "./autoInstallPolicy.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

const NOW = 1_000_000;

const downloaded: DesktopUpdateState = {
  ...createInitialDesktopUpdateState(
    "1.0.0",
    { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
    "latest",
  ),
  enabled: true,
  status: "downloaded",
  availableVersion: "1.1.0",
  downloadedVersion: "1.1.0",
  autoUpdateEnabled: true,
};

const idle = (ageMs = 0) => ({ busy: false, reportedAtMs: NOW - ageMs });

describe("canAutoInstall", () => {
  it("installs once every running backend recently reported no agent work", () => {
    expect(
      canAutoInstall({
        state: downloaded,
        runningBackendIds: ["local"],
        activity: new Map([["local", idle(1_000)]]),
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("installs right away when no backend is running", () => {
    expect(
      canAutoInstall({ state: downloaded, runningBackendIds: [], activity: new Map(), nowMs: NOW }),
    ).toBe(true);
  });

  it("waits while a backend is busy, silent, or last heard from too long ago", () => {
    const waits = (activity: Map<string, { busy: boolean; reportedAtMs: number }>) =>
      canAutoInstall({
        state: downloaded,
        runningBackendIds: ["local", "wsl:ubuntu"],
        activity,
        nowMs: NOW,
      });

    // The WSL backend has no control channel, so it never reports.
    expect(waits(new Map([["local", idle()]]))).toBe(false);
    expect(
      waits(
        new Map([
          ["local", idle()],
          ["wsl:ubuntu", { busy: true, reportedAtMs: NOW }],
        ]),
      ),
    ).toBe(false);
    expect(
      waits(
        new Map([
          ["local", idle()],
          ["wsl:ubuntu", idle(AGENT_ACTIVITY_REPORT_TTL_MS + 1)],
        ]),
      ),
    ).toBe(false);
  });

  it("never installs unless the setting is on and an update is downloaded", () => {
    const activity = new Map([["local", idle()]]);
    // A desktop build that predates the setting leaves it out.
    const { autoUpdateEnabled: _, ...withoutSetting } = downloaded;
    for (const state of [
      { ...downloaded, autoUpdateEnabled: false },
      withoutSetting,
      { ...downloaded, status: "available" as const },
      { ...downloaded, status: "error" as const, errorContext: "install" as const },
    ]) {
      expect(canAutoInstall({ state, runningBackendIds: ["local"], activity, nowMs: NOW })).toBe(
        false,
      );
    }
  });
});
