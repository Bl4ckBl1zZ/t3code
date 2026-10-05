import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { derivePendingBackgroundWork } from "./orchestrationV2PendingBackgroundWork.ts";

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
