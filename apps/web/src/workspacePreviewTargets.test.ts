import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorkspaceId,
  type PreviewTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findWorkspacePreviewTargetForTerminal,
  markWorkspacePreviewTargetsStaleForTerminal,
  pruneWorkspacePreviewTargets,
  upsertWorkspacePreviewTarget,
  workspacePreviewTargetsForScope,
  type WorkspacePreviewTargetsById,
} from "./workspacePreviewTargets";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-web");
const WORKSPACE_ID = WorkspaceId.make("workspace-web");
const OTHER_WORKSPACE_ID = WorkspaceId.make("workspace-other");
const THREAD_ID = ThreadId.make("thread-1");

function target(
  input: {
    readonly id?: string;
    readonly port?: number;
    readonly terminalId?: string;
    readonly workspaceId?: WorkspaceId;
    readonly firstSeenAt?: string;
    readonly lastSeenAt?: string;
    readonly status?: PreviewTarget["status"];
  } = {},
): PreviewTarget {
  const port = input.port ?? 5173;
  const terminalId = input.terminalId ?? "term-1";
  const id =
    input.id ?? `detected:${ENVIRONMENT_ID}:${WORKSPACE_ID}:${THREAD_ID}:${terminalId}:${port}`;
  const firstSeenAt = input.firstSeenAt ?? "2026-06-07T10:00:00.000Z";
  const lastSeenAt = input.lastSeenAt ?? firstSeenAt;
  return {
    id,
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    workspaceId: input.workspaceId ?? WORKSPACE_ID,
    cwd: "/repo",
    url: `http://127.0.0.1:${port}/`,
    host: "127.0.0.1",
    port,
    status: input.status ?? "reachable",
    source: "process-listener",
    confidence: 90,
    terminalId,
    threadId: THREAD_ID,
    firstSeenAt,
    lastSeenAt,
    lastVerifiedAt: lastSeenAt,
  };
}

describe("workspace preview targets", () => {
  it("upserts targets while preserving the original first-seen timestamp", () => {
    const initial = target({ lastSeenAt: "2026-06-07T10:00:00.000Z" });
    const updated = target({ lastSeenAt: "2026-06-07T10:05:00.000Z" });

    const targets = upsertWorkspacePreviewTarget(
      upsertWorkspacePreviewTarget({}, initial),
      updated,
    );

    expect(targets[initial.id]).toMatchObject({
      firstSeenAt: "2026-06-07T10:00:00.000Z",
      lastSeenAt: "2026-06-07T10:05:00.000Z",
    });
  });

  it("marks all targets for a terminal stale when the script or terminal stops", () => {
    const first = target({ id: "target-1", terminalId: "term-1" });
    const second = target({ id: "target-2", terminalId: "term-2" });
    const targets = markWorkspacePreviewTargetsStaleForTerminal(
      {
        [first.id]: first,
        [second.id]: second,
      },
      {
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        terminalId: "term-1",
        now: new Date("2026-06-07T10:10:00.000Z"),
      },
    );

    expect(targets[first.id]?.status).toBe("stale");
    expect(targets[first.id]?.lastSeenAt).toBe("2026-06-07T10:10:00.000Z");
    expect(targets[second.id]?.status).toBe("reachable");
  });

  it("filters targets by workspace scope", () => {
    const inScope = target({ id: "in-scope" });
    const outOfScope = target({ id: "out-of-scope", workspaceId: OTHER_WORKSPACE_ID });
    const targets = workspacePreviewTargetsForScope(
      {
        [inScope.id]: inScope,
        [outOfScope.id]: outOfScope,
      },
      {
        environmentId: ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
      },
    );

    expect(targets.map((entry) => entry.id)).toEqual(["in-scope"]);
  });

  it("finds terminal-owned targets and prunes old stale targets", () => {
    const live = target({ id: "live", terminalId: "term-live" });
    const stale = target({
      id: "stale",
      terminalId: "term-stale",
      status: "stale",
      lastSeenAt: "2026-06-06T10:00:00.000Z",
    });
    const targets: WorkspacePreviewTargetsById = {
      [live.id]: live,
      [stale.id]: stale,
    };

    expect(
      findWorkspacePreviewTargetForTerminal(targets, {
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        terminalId: "term-live",
      })?.id,
    ).toBe("live");
    expect(
      Object.keys(
        pruneWorkspacePreviewTargets(targets, {
          now: new Date("2026-06-07T12:00:00.000Z"),
          maxAgeMs: 60_000,
        }),
      ),
    ).toEqual(["live"]);
  });
});
