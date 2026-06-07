import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorkspaceId,
  type PreviewTarget,
  type TerminalDetectedWebServer,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  detectedPreviewTarget,
  explicitPreviewTarget,
  isPotentialPreviewScript,
  selectWorkspacePreviewTarget,
} from "./previewTargets";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-web");
const WORKSPACE_ID = WorkspaceId.make("workspace-web");
const OTHER_WORKSPACE_ID = WorkspaceId.make("workspace-other");
const THREAD_ID = ThreadId.make("thread-1");
const NOW = new Date("2026-06-07T12:00:00.000Z");

function server(port: number, pid = port): TerminalDetectedWebServer {
  return {
    url: `http://127.0.0.1:${port}/`,
    host: "127.0.0.1",
    port,
    pid,
    verified: true,
    source: "listening-port",
  };
}

function target(input: {
  readonly port: number;
  readonly terminalId: string;
  readonly workspaceId?: WorkspaceId;
  readonly scriptId?: string;
  readonly detectedAt?: number;
}): PreviewTarget {
  return detectedPreviewTarget({
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    workspaceId: input.workspaceId ?? WORKSPACE_ID,
    cwd: "/repo",
    terminalId: input.terminalId,
    threadId: THREAD_ID,
    server: server(input.port),
    detectedAt: input.detectedAt ?? Date.now(),
    ...(input.scriptId ? { scriptId: input.scriptId } : {}),
  });
}

describe("isPotentialPreviewScript", () => {
  it("recognizes common dev-server commands", () => {
    expect(isPotentialPreviewScript("pnpm dev")).toBe(true);
    expect(isPotentialPreviewScript("npm run storybook")).toBe(true);
    expect(isPotentialPreviewScript("pnpm test")).toBe(false);
  });
});

describe("selectWorkspacePreviewTarget", () => {
  it("uses configured preview URLs before detected targets", () => {
    const explicit = explicitPreviewTarget({
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      cwd: "/repo",
      rawUrl: "localhost:4444",
      now: NOW,
    });

    const selection = selectWorkspacePreviewTarget({
      explicitPreviewUrl: "localhost:4444",
      targets: [target({ port: 5173, terminalId: "term-1" })],
      activeProjectId: PROJECT_ID,
      activeWorkspaceId: WORKSPACE_ID,
      activeProjectCwd: "/repo",
      environmentId: ENVIRONMENT_ID,
      now: NOW,
    });

    expect(explicit?.url).toBe("http://localhost:4444/");
    expect(selection.kind).toBe("ready");
    expect(selection.selectedTarget?.source).toBe("explicit");
    expect(selection.selectedTarget?.url).toBe("http://localhost:4444/");
  });

  it("selects the verified target for the preferred running script", () => {
    const selection = selectWorkspacePreviewTarget({
      targets: [
        target({ port: 5173, terminalId: "term-1", scriptId: "dev" }),
        target({ port: 6006, terminalId: "term-2", scriptId: "storybook" }),
      ],
      activeProjectId: PROJECT_ID,
      activeWorkspaceId: WORKSPACE_ID,
      activeProjectCwd: "/repo",
      environmentId: ENVIRONMENT_ID,
      preferredScriptId: "storybook",
      runningScriptIds: new Set(["dev", "storybook"]),
      now: NOW,
    });

    expect(selection.kind).toBe("ready");
    expect(selection.selectedTarget?.port).toBe(6006);
  });

  it("requires a choice when multiple workspace targets are equally likely", () => {
    const selection = selectWorkspacePreviewTarget({
      targets: [
        target({ port: 5173, terminalId: "term-1" }),
        target({ port: 3001, terminalId: "term-2" }),
      ],
      activeProjectId: PROJECT_ID,
      activeWorkspaceId: WORKSPACE_ID,
      activeProjectCwd: "/repo",
      environmentId: ENVIRONMENT_ID,
      now: NOW,
    });

    expect(selection.kind).toBe("ambiguous");
    expect(selection.selectedTarget).toBeNull();
    expect(selection.targets.map((candidate) => candidate.port).toSorted()).toEqual([3001, 5173]);
  });

  it("ignores targets from sibling workspaces", () => {
    const selection = selectWorkspacePreviewTarget({
      targets: [target({ port: 5173, terminalId: "term-1", workspaceId: OTHER_WORKSPACE_ID })],
      activeProjectId: PROJECT_ID,
      activeWorkspaceId: WORKSPACE_ID,
      activeProjectCwd: "/repo",
      environmentId: ENVIRONMENT_ID,
      now: NOW,
    });

    expect(selection.kind).toBe("hidden");
  });

  it("does not invent default ports while a dev script is still starting", () => {
    const selection = selectWorkspacePreviewTarget({
      targets: [],
      activeProjectId: PROJECT_ID,
      activeWorkspaceId: WORKSPACE_ID,
      activeProjectCwd: "/repo",
      environmentId: ENVIRONMENT_ID,
      hasStartingCandidate: true,
      now: NOW,
    });

    expect(selection.kind).toBe("starting");
    expect(selection.selectedTarget).toBeNull();
    expect(selection.targets).toEqual([]);
  });
});
