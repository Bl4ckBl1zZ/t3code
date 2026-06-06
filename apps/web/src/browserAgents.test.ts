import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { shouldShowBrowserAgentControls } from "./browserAgents";

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
