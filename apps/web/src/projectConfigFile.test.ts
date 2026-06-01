import type { ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildScriptsWithWorktreeSetupCommand,
  getProjectConfigNewThreadEnvMode,
  parseProjectConfigContents,
  setProjectConfigNewThreadEnvMode,
} from "./projectConfigFile";

function script(overrides: Partial<ProjectScript> = {}): ProjectScript {
  return {
    id: "dev",
    name: "Dev",
    command: "bun dev",
    icon: "play",
    runOnWorktreeCreate: false,
    ...overrides,
  };
}

describe("projectConfigFile", () => {
  it("preserves config fields while updating the new thread mode", () => {
    const config = parseProjectConfigContents(
      JSON.stringify({
        browser: { previewUrl: "http://localhost:3000" },
        custom: { keep: true },
      }),
    );

    setProjectConfigNewThreadEnvMode(config, "worktree");

    expect(getProjectConfigNewThreadEnvMode(config)).toBe("worktree");
    expect(config.browser).toEqual({ previewUrl: "http://localhost:3000" });
    expect(config.custom).toEqual({ keep: true });
  });

  it("creates one worktree setup script and clears previous setup flags", () => {
    const scripts = buildScriptsWithWorktreeSetupCommand(
      [
        script({ id: "dev", runOnWorktreeCreate: true }),
        script({ id: "lint", name: "Lint", command: "bun lint", icon: "lint" }),
      ],
      "cp .env.example .env",
    );

    expect(scripts).toEqual([
      script({ id: "dev", command: "cp .env.example .env", runOnWorktreeCreate: true }),
      script({ id: "lint", name: "Lint", command: "bun lint", icon: "lint" }),
    ]);
  });

  it("removes worktree setup scripts when the command is empty", () => {
    const scripts = buildScriptsWithWorktreeSetupCommand(
      [
        script({
          id: "setup",
          name: "Setup",
          command: "cp .env.example .env",
          icon: "configure",
          runOnWorktreeCreate: true,
        }),
        script({ id: "dev" }),
      ],
      " ",
    );

    expect(scripts).toEqual([script({ id: "dev" })]);
  });
});
