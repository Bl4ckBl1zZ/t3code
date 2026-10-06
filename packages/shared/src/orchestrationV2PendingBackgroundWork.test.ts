import { type OrchestrationV2PendingBackgroundTask, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
} from "./orchestrationV2PendingBackgroundWork.ts";

describe("backgroundWorkHoldsCompletion", () => {
  const task = (
    taskId: string,
    kind: OrchestrationV2PendingBackgroundTask["kind"],
  ): OrchestrationV2PendingBackgroundTask => ({ taskId, kind });

  it.each([
    ["nothing pending", false, []],
    ["a dev server", false, [task("dev", "command")]],
    ["two long-lived shells", false, [task("web", "command"), task("api", "command")]],
    ["a subagent", true, [task("review", "subagent")]],
    ["a monitor", true, [task("watch", "monitor")]],
    ["a command and a monitor", true, [task("dev", "command"), task("watch", "monitor")]],
    ["a command and a subagent", true, [task("dev", "command"), task("review", "subagent")]],
    // Also what an unknown kind from a newer server decodes to.
    ["work the server cannot name", true, [task("opaque", "background_task")]],
  ] as const)("with %s pending, holds completion: %s", (_case, holds, tasks) => {
    expect(backgroundWorkHoldsCompletion(tasks)).toBe(holds);
  });
});

const command = (
  id: string,
  overrides: Partial<Parameters<typeof derivePendingBackgroundWork>[0]["turnItems"][number]> = {},
) => ({
  id,
  type: "command_execution" as const,
  status: "running" as const,
  title: null,
  input: "npm run dev",
  background: true,
  ...overrides,
});

const subagent = (
  id: string,
  overrides: Partial<Parameters<typeof derivePendingBackgroundWork>[0]["subagents"][number]> = {},
) => ({
  id,
  status: "running" as const,
  title: null,
  childThreadId: null,
  ...overrides,
});

describe("derivePendingBackgroundWork", () => {
  it("names what a settled run left running, by kind", () => {
    expect(
      derivePendingBackgroundWork({
        latestRunStatus: "completed",
        hasActiveRun: false,
        turnItems: [
          command("dev", { title: "Start the dev server" }),
          command("tests"),
          command("watch", { title: "Watch the build", waitKind: "monitor" }),
          command("done", { status: "completed" }),
          command("foreground", { background: undefined }),
          {
            id: "message",
            type: "assistant_message" as const,
            status: "running" as const,
            title: null,
          },
        ],
        subagents: [
          subagent("review", {
            title: "Review the diff",
            childThreadId: ThreadId.make("thread-child"),
          }),
          subagent("monitor-loop", { taskType: "monitor" }),
          subagent("finished", { status: "completed" }),
        ],
      }),
    ).toEqual([
      { taskId: "dev", description: "Start the dev server", kind: "command" },
      { taskId: "tests", description: "npm run dev", kind: "command" },
      { taskId: "watch", description: "Watch the build", kind: "monitor" },
      {
        taskId: "review",
        description: "Review the diff",
        kind: "subagent",
        childThreadId: ThreadId.make("thread-child"),
      },
    ]);
  });

  it("is empty while a run is in flight or the latest run was rolled back", () => {
    const sources = { turnItems: [command("dev")], subagents: [subagent("review")] };
    expect(
      derivePendingBackgroundWork({ latestRunStatus: "running", hasActiveRun: true, ...sources }),
    ).toEqual([]);
    expect(
      derivePendingBackgroundWork({ latestRunStatus: "completed", hasActiveRun: true, ...sources }),
    ).toEqual([]);
    expect(
      derivePendingBackgroundWork({
        latestRunStatus: "rolled_back",
        hasActiveRun: false,
        ...sources,
      }),
    ).toEqual([]);
    expect(
      derivePendingBackgroundWork({ latestRunStatus: null, hasActiveRun: false, ...sources }),
    ).toEqual([]);
    expect(
      derivePendingBackgroundWork({ latestRunStatus: "failed", hasActiveRun: false, ...sources }),
    ).toHaveLength(2);
  });

  it("cuts a long command to a name", () => {
    const [task] = derivePendingBackgroundWork({
      latestRunStatus: "completed",
      hasActiveRun: false,
      turnItems: [command("long", { input: `  ${"x".repeat(500)}` })],
      subagents: [],
    });
    expect(task?.description).toHaveLength(200);
  });
});

describe("derivePendingBackgroundWork pull request watches", () => {
  const watch = {
    startedAt: "2026-10-05T00:00:00.000Z",
    headSha: null,
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarksThrough: "2026-10-05T00:00:00.000Z",
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  };
  const link = (
    number: number,
    extra: { source?: "agent" | "stack-dismissed"; watched?: boolean } = {},
  ) => ({
    host: "github.com",
    repository: "acme/app",
    number,
    source: extra.source ?? "agent",
    ...(extra.watched === false ? {} : { watch }),
  });
  const pullRequests = [
    link(1),
    link(2, { watched: false }),
    link(3, { source: "stack-dismissed" }),
  ];
  const base = { hasActiveRun: false, turnItems: [], subagents: [], pullRequests };

  it("keeps a settled run waiting on each visible watch, as a monitor", () => {
    const tasks = derivePendingBackgroundWork({ ...base, latestRunStatus: "completed" });
    expect(tasks).toEqual([
      {
        taskId: "pull-request-watch:github.com/acme/app#1",
        description: "Watching pull request #1",
        kind: "monitor",
      },
    ]);
    expect(backgroundWorkHoldsCompletion(tasks)).toBe(true);
  });

  it("keeps a thread that never ran waiting on its watch", () => {
    expect(
      derivePendingBackgroundWork({ ...base, latestRunStatus: null }).map((task) => task.taskId),
    ).toEqual(["pull-request-watch:github.com/acme/app#1"]);
  });

  it("lists no watch while a run is active", () => {
    expect(
      derivePendingBackgroundWork({ ...base, latestRunStatus: "running", hasActiveRun: true }),
    ).toEqual([]);
  });
});
