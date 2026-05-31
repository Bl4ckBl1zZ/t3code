import { EnvironmentId, type ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { inferBrowserAgentDevServerUrl, shouldShowBrowserAgentControls } from "./browserAgents";

function script(command: string): ProjectScript {
  return {
    id: command,
    name: command,
    command,
    icon: "play",
    runOnWorktreeCreate: false,
  };
}

describe("inferBrowserAgentDevServerUrl", () => {
  it("uses explicit script ports", () => {
    expect(inferBrowserAgentDevServerUrl([script("pnpm dev --port 4173")])).toBe(
      "http://localhost:4173/",
    );
  });

  it("uses common framework defaults", () => {
    expect(inferBrowserAgentDevServerUrl([script("pnpm next dev")])).toBe("http://localhost:3000/");
    expect(inferBrowserAgentDevServerUrl([script("pnpm vite --host 0.0.0.0")])).toBe(
      "http://localhost:5173/",
    );
  });
});

describe("shouldShowBrowserAgentControls", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows controls for active primary-environment projects", () => {
    expect(
      shouldShowBrowserAgentControls({
        activeProjectName: "repo",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides controls without a project or primary environment match", () => {
    expect(
      shouldShowBrowserAgentControls({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
    expect(
      shouldShowBrowserAgentControls({
        activeProjectName: "repo",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});
