import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  NodeId,
  type OrchestrationV2CommandExecutionItem,
  type OrchestrationV2ProjectedTurnItem,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

import {
  backgroundElapsedTickMs,
  backgroundProcessOutcome,
  backgroundProcessTail,
  formatBackgroundElapsed,
  formatBackgroundSinceOutput,
  liveBackgroundProcesses,
  resolveBackgroundProcessView,
} from "./backgroundProcess";

const START = DateTime.makeUnsafe("2026-08-04T12:00:00.000Z");
const NOW_MS = new Date("2026-08-04T12:01:12.000Z").getTime();

function at(iso: string): DateTime.Utc {
  return DateTime.makeUnsafe(iso);
}

function commandItem(
  overrides: Partial<OrchestrationV2CommandExecutionItem> = {},
): OrchestrationV2CommandExecutionItem {
  return {
    id: TurnItemId.make("item-1"),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    nodeId: NodeId.make("node-1"),
    providerThreadId: ProviderThreadId.make("pt-1"),
    providerTurnId: ProviderTurnId.make("ptn-1"),
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "waiting" as const,
    title: null,
    startedAt: START,
    completedAt: null,
    updatedAt: START,
    type: "command_execution" as const,
    input: "pnpm vitest run apps/web",
    background: true,
    taskId: "bs891h9i0",
    ...overrides,
  };
}

function projected(item: OrchestrationV2CommandExecutionItem): OrchestrationV2ProjectedTurnItem {
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
}

describe("resolveBackgroundProcessView", () => {
  it("shows a tail and no progress bar when output is readable", () => {
    const view = resolveBackgroundProcessView(
      commandItem({ outputPath: "/tmp/tasks/x.output", output: "step 1\nstep 2\n" }),
      NOW_MS,
    );
    expect(view.variant).toBe("tail");
    expect(view.tail).toBe("step 2");
    expect(view.deadlineFraction).toBeNull();
    expect(view.live).toBe(true);
  });

  it("shows a determinate bar only when a deadline was declared", () => {
    const view = resolveBackgroundProcessView(
      commandItem({ background: undefined, timeoutMs: 120_000 }),
      NOW_MS,
    );
    expect(view.variant).toBe("deadline");
    expect(view.deadlineFraction).toBeCloseTo(0.6, 5);
    expect(view.deadlineRemainingMs).toBe(48_000);
  });

  it("prefers a tail over a bar when the command is visibly printing", () => {
    const view = resolveBackgroundProcessView(
      commandItem({ timeoutMs: 120_000, output: "working" }),
      NOW_MS,
    );
    expect(view.variant).toBe("tail");
  });

  it("treats a monitor as a wait rather than as work", () => {
    const view = resolveBackgroundProcessView(
      commandItem({ waitKind: "monitor", timeoutMs: 120_000, waitingOnTaskId: "byggcdigy" }),
      NOW_MS,
    );
    expect(view.variant).toBe("monitor");
    expect(view.waitingOnTaskId).toBe("byggcdigy");
  });

  it("excludes paused time from elapsed and reports the pause", () => {
    const view = resolveBackgroundProcessView(
      commandItem({ paused: true, pausedMs: 12_000 }),
      NOW_MS,
    );
    expect(view.paused).toBe(true);
    expect(formatBackgroundElapsed(view.elapsedMs)).toBe("1m 00s");
  });

  it("stops the clock at completion instead of counting for ever", () => {
    const view = resolveBackgroundProcessView(
      commandItem({
        status: "completed",
        completedAt: at("2026-08-04T12:00:30.000Z"),
        exitCode: 0,
      }),
      NOW_MS,
    );
    expect(view.live).toBe(false);
    expect(formatBackgroundElapsed(view.elapsedMs)).toBe("30s");
  });

  it("reports how long output has been silent", () => {
    const view = resolveBackgroundProcessView(
      commandItem({ lastOutputAt: at("2026-08-04T12:01:09.000Z"), output: "x" }),
      NOW_MS,
    );
    expect(formatBackgroundSinceOutput(view.sinceOutputMs ?? 0)).toBe("3s ago");
  });

  it("has no staleness to report when nothing has been printed", () => {
    expect(resolveBackgroundProcessView(commandItem(), NOW_MS).sinceOutputMs).toBeNull();
  });
});

describe("backgroundProcessOutcome", () => {
  it("separates a failure from work that never got to finish", () => {
    expect(backgroundProcessOutcome(commandItem({ status: "failed", exitCode: 1 }))).toEqual({
      tone: "danger",
      label: "failed exit 1",
    });
    expect(
      backgroundProcessOutcome(commandItem({ status: "cancelled", exitReason: "killed" })),
    ).toEqual({ tone: "warning", label: "stopped when the session ended" });
    expect(
      backgroundProcessOutcome(commandItem({ status: "cancelled", exitReason: "unknown" })),
    ).toEqual({
      tone: "warning",
      label: "outcome unknown, server restarted while it ran",
    });
  });

  it("reports a clean exit with its code", () => {
    expect(backgroundProcessOutcome(commandItem({ status: "completed", exitCode: 0 }))).toEqual({
      tone: "success",
      label: "finished exit 0",
    });
  });

  it("treats a nonzero exit as a failure even when the item says completed", () => {
    expect(backgroundProcessOutcome(commandItem({ status: "completed", exitCode: 2 }))).toEqual({
      tone: "danger",
      label: "failed exit 2",
    });
  });

  it("has nothing to say while the command is still running", () => {
    expect(backgroundProcessOutcome(commandItem())).toBeNull();
  });
});

describe("liveBackgroundProcesses", () => {
  it("folds a monitor into the command it watches", () => {
    const command = commandItem({ id: TurnItemId.make("cmd"), taskId: "byggcdigy" });
    const monitor = commandItem({
      id: TurnItemId.make("mon"),
      taskId: "b8zv6rtg9",
      waitKind: "monitor",
      waitingOnTaskId: "byggcdigy",
    });
    const processes = liveBackgroundProcesses([projected(command), projected(monitor)]);
    expect(processes).toHaveLength(1);
    expect(processes[0]?.item.id).toBe("cmd");
    expect(processes[0]?.monitor?.id).toBe("mon");
  });

  it("still shows a monitor that watches something it cannot name", () => {
    const monitor = commandItem({ id: TurnItemId.make("mon"), waitKind: "monitor" });
    const processes = liveBackgroundProcesses([projected(monitor)]);
    expect(processes).toHaveLength(1);
    expect(processes[0]?.monitor).toBeNull();
  });

  it("ignores commands that have already settled", () => {
    const done = commandItem({ status: "completed", exitCode: 0 });
    expect(liveBackgroundProcesses([projected(done)])).toHaveLength(0);
  });

  it("ignores foreground commands, which the turn already accounts for", () => {
    const foreground = commandItem({ background: undefined, status: "running" });
    expect(liveBackgroundProcesses([projected(foreground)])).toHaveLength(0);
  });
});

describe("formatBackgroundElapsed", () => {
  it("keeps seconds where they matter and drops them where they do not", () => {
    expect(formatBackgroundElapsed(12_000)).toBe("12s");
    expect(formatBackgroundElapsed(72_000)).toBe("1m 12s");
    expect(formatBackgroundElapsed(14 * 60_000)).toBe("14m");
    expect(formatBackgroundElapsed(95 * 60_000)).toBe("1h 35m");
  });

  it("slows the tick once seconds stop being shown", () => {
    expect(backgroundElapsedTickMs(30_000)).toBe(1_000);
    expect(backgroundElapsedTickMs(20 * 60_000)).toBe(30_000);
  });
});

describe("backgroundProcessTail", () => {
  it("skips trailing blank lines", () => {
    expect(backgroundProcessTail("a\nb\n\n  \n")).toBe("b");
  });

  it("has nothing to show for empty output", () => {
    expect(backgroundProcessTail(undefined)).toBeNull();
    expect(backgroundProcessTail("   ")).toBeNull();
  });
});
