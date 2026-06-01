import { PROJECT_CONFIG_SCHEMA_URL, type ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildScriptsWithWorktreeSetupCommand,
  getProjectConfigNewThreadEnvMode,
  parseProjectConfigContents,
  setProjectConfigNewThreadEnvMode,
  updateProjectConfigJson,
} from "./projectConfigFile";

const devScript: ProjectScript = {
  id: "dev",
  name: "Dev",
  command: "pnpm dev",
  icon: "play",
  runOnWorktreeCreate: false,
  pinnedToTopBar: true,
};

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

  it("writes scripts and normalized project preview URLs", () => {
    const parsed = JSON.parse(
      updateProjectConfigJson("", {
        scripts: [devScript],
        browserPreviewUrl: ":5173",
      }),
    ) as Record<string, unknown>;

    expect(parsed).toEqual({
      $schema: PROJECT_CONFIG_SCHEMA_URL,
      browser: { previewUrl: "http://localhost:5173" },
      scripts: [devScript],
    });
  });

  it("preserves unrelated config keys while updating browser preview URL", () => {
    const parsed = JSON.parse(
      updateProjectConfigJson(
        JSON.stringify({
          $schema: "https://example.test/project.schema.json",
          browser: { openInBackground: true },
          theme: "dark",
        }),
        {
          browserPreviewUrl: "localhost:3001",
        },
      ),
    ) as Record<string, unknown>;

    expect(parsed).toEqual({
      $schema: "https://example.test/project.schema.json",
      browser: {
        openInBackground: true,
        previewUrl: "http://localhost:3001",
      },
      theme: "dark",
    });
  });

  it("removes browser preview URL when cleared", () => {
    const parsed = JSON.parse(
      updateProjectConfigJson(
        JSON.stringify({
          browser: { previewUrl: "http://localhost:3000/" },
          scripts: [devScript],
        }),
        {
          browserPreviewUrl: "",
        },
      ),
    ) as Record<string, unknown>;

    expect(parsed).toEqual({
      $schema: PROJECT_CONFIG_SCHEMA_URL,
      scripts: [devScript],
    });
  });

  it("rejects invalid project config JSON roots", () => {
    expect(() => updateProjectConfigJson("[]", { scripts: [] })).toThrow(
      "Project config must be a JSON object.",
    );
  });
});
