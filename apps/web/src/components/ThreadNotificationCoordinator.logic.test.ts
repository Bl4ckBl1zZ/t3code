import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadNotificationEvents,
  type ThreadNotificationMemory,
  type ThreadNotificationThread,
} from "./ThreadNotificationCoordinator.logic";

const environmentId = EnvironmentId.make("env-1");

function thread(
  input: {
    readonly run?: string;
    readonly status?: NonNullable<ThreadNotificationThread["runtime"]>["status"];
    readonly approval?: boolean;
    readonly userInput?: boolean;
    readonly archived?: boolean;
    readonly subagent?: boolean;
    readonly backgroundProcessCount?: number;
  } = {},
): ThreadNotificationThread {
  const runId = RunId.make(input.run ?? "run-1");
  const status = input.status ?? "running";
  return {
    environmentId,
    id: ThreadId.make("thread-1"),
    title: "Fix the login form",
    archivedAt: input.archived ? "2026-09-13T10:00:00.000Z" : null,
    lineage: {
      relationshipToParent: input.subagent ? "subagent" : null,
    } as ThreadNotificationThread["lineage"],
    latestRun: {
      runId,
      status: status === "idle" ? "completed" : status,
      requestedAt: null,
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    },
    runtime: {
      status,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: null,
      lastError: null,
      updatedAt: "2026-09-13T10:00:00.000Z",
    },
    hasPendingApprovals: input.approval ?? false,
    hasPendingUserInput: input.userInput ?? false,
    backgroundProcessCount: input.backgroundProcessCount ?? 0,
    activeAgentCount: 0,
  };
}

function step(
  previous: ReadonlyMap<string, ThreadNotificationMemory>,
  ...threads: ThreadNotificationThread[]
) {
  return resolveThreadNotificationEvents(previous, threads);
}

describe("resolveThreadNotificationEvents", () => {
  it("stays quiet for work that was already finished when the thread was first seen", () => {
    const first = step(new Map(), thread({ status: "completed" }));
    expect(first.events).toEqual([]);
    expect(step(first.next, thread({ status: "completed" })).events).toEqual([]);
  });

  it("alerts once when a running thread completes", () => {
    const running = step(new Map(), thread());
    const completed = step(running.next, thread({ status: "completed" }));
    expect(completed.events.map(({ kind, title, tone }) => ({ kind, title, tone }))).toEqual([
      { kind: "completion", title: "Thread completed", tone: "success" },
    ]);
    expect(step(completed.next, thread({ status: "completed" })).events).toEqual([]);
  });

  it("alerts again when a later run completes", () => {
    const first = step(new Map(), thread({ status: "completed" }));
    const running = step(first.next, thread({ run: "run-2" }));
    expect(running.events).toEqual([]);
    const completed = step(running.next, thread({ run: "run-2", status: "completed" }));
    expect(completed.events.map((event) => event.kind)).toEqual(["completion"]);
  });

  it("waits for background work before calling a thread completed", () => {
    const running = step(new Map(), thread());
    const background = step(
      running.next,
      thread({ status: "completed", backgroundProcessCount: 1 }),
    );
    expect(background.events).toEqual([]);
    expect(
      step(background.next, thread({ status: "completed" })).events.map((event) => event.kind),
    ).toEqual(["completion"]);
  });

  it("does not call interrupted runs completed", () => {
    const running = step(new Map(), thread());
    expect(step(running.next, thread({ status: "interrupted" })).events).toEqual([]);
  });

  it("alerts when a thread starts waiting on the user, once per request kind", () => {
    const running = step(new Map(), thread());
    const approval = step(running.next, thread({ approval: true }));
    expect(approval.events.map((event) => event.title)).toEqual(["Approval needed"]);
    expect(step(approval.next, thread({ approval: true })).events).toEqual([]);
    const input = step(approval.next, thread({ userInput: true }));
    expect(input.events.map((event) => event.title)).toEqual(["Input needed"]);
  });

  it("reports failed runs as errors", () => {
    const running = step(new Map(), thread());
    const failed = step(running.next, thread({ status: "failed" }));
    expect(failed.events.map(({ kind, title, tone }) => ({ kind, title, tone }))).toEqual([
      { kind: "input", title: "Thread failed", tone: "error" },
    ]);
  });

  it("ignores archived and subagent threads", () => {
    const running = step(new Map(), thread());
    expect(step(running.next, thread({ status: "completed", archived: true })).events).toEqual([]);
    expect(step(running.next, thread({ status: "completed", subagent: true })).events).toEqual([]);
  });

  it("forgets threads that left so a returning thread only seeds the memory", () => {
    const running = step(new Map(), thread());
    const gone = step(running.next);
    expect(gone.next.size).toBe(0);
    expect(step(gone.next, thread({ status: "completed" })).events).toEqual([]);
  });
});
