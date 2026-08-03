import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import {
  isV2LifecycleTimelineItem,
  resolveLifecyclePresentation,
  type LifecycleTimelineRun,
} from "./threadLifecycle";

function item(partial: Record<string, unknown>): OrchestrationV2TurnItem {
  return {
    id: "item-1",
    threadId: "thread-1",
    runId: "run-2",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...partial,
  } as never;
}

const RUNS: ReadonlyArray<LifecycleTimelineRun> = [
  { id: "run-1", ordinal: 1, providerInstanceId: "claude", model: "claude-opus-5" },
  { id: "run-2", ordinal: 2, providerInstanceId: "codex", model: "gpt-6" },
];

describe("isV2LifecycleTimelineItem", () => {
  it("classifies lifecycle types and leaves work items alone", () => {
    expect(isV2LifecycleTimelineItem(item({ type: "handoff" }))).toBe(true);
    expect(isV2LifecycleTimelineItem(item({ type: "subagent" }))).toBe(true);
    expect(isV2LifecycleTimelineItem(item({ type: "checkpoint" }))).toBe(false);
    expect(isV2LifecycleTimelineItem(item({ type: "command_execution" }))).toBe(false);
  });
});

describe("resolveLifecyclePresentation", () => {
  it("renders interrupt request as an inline line", () => {
    expect(
      resolveLifecyclePresentation(
        item({ type: "run_interrupt_request", message: "user requested stop" }),
        [],
      ),
    ).toEqual({ kind: "interrupt-request", message: "user requested stop" });
  });

  it("renders interrupt result as a danger divider", () => {
    const presentation = resolveLifecyclePresentation(
      item({ type: "run_interrupt_result", message: "stopped" }),
      [],
    );
    expect(presentation).toMatchObject({
      kind: "divider",
      label: "Run interrupted",
      tone: "danger",
    });
  });

  it("labels compaction with summary, falling back to token counts", () => {
    expect(
      resolveLifecyclePresentation(
        item({ type: "compaction", driver: null, summary: "compacted the earlier work" }),
        [],
      ),
    ).toMatchObject({ detail: "compacted the earlier work" });
    expect(
      resolveLifecyclePresentation(
        item({
          type: "compaction",
          driver: null,
          beforeTokenCount: 90_000,
          afterTokenCount: 12_000,
        }),
        [],
      ),
    ).toMatchObject({ detail: "90000 → 12000 tokens" });
  });

  it("recovers handoff models from runs when the item predates model stamping", () => {
    const presentation = resolveLifecyclePresentation(
      item({
        type: "handoff",
        contextHandoffId: "handoff-1",
        fromProviderThreadIds: [],
        toProviderThreadId: "pt-2",
        fromProviderInstanceIds: ["claude"],
        toProviderInstanceId: "codex",
        strategy: "full_thread_summary",
        runId: "run-2",
      }),
      RUNS,
    );
    expect(presentation).toMatchObject({
      kind: "divider",
      label: "Context handoff",
      detail: "claude-opus-5 → gpt-6",
      tone: "neutral",
    });
  });

  it("renders an in-flight handoff as a busy preparing divider", () => {
    const presentation = resolveLifecyclePresentation(
      item({
        type: "handoff",
        status: "running",
        contextHandoffId: "handoff-1",
        fromProviderThreadIds: [],
        toProviderThreadId: "pt-2",
        fromProviderInstanceIds: ["claude"],
        toProviderInstanceId: "codex",
        fromModelSelections: [{ instanceId: "claude", model: "claude-opus-5" }],
        toModel: "gpt-6",
        strategy: "full_thread_summary",
        runId: "run-2",
      }),
      RUNS,
    );
    expect(presentation).toMatchObject({
      kind: "divider",
      label: "Preparing context handoff",
      detail: "claude-opus-5 → gpt-6",
      layout: "stacked",
      busy: true,
      tone: "neutral",
    });
  });

  it("marks failed handoffs as danger", () => {
    const presentation = resolveLifecyclePresentation(
      item({
        type: "handoff",
        status: "failed",
        contextHandoffId: "handoff-1",
        fromProviderThreadIds: [],
        toProviderThreadId: "pt-2",
        fromProviderInstanceIds: [],
        toProviderInstanceId: "codex",
        toModel: "gpt-6",
        strategy: "manual_context",
        runId: null,
      }),
      [],
    );
    expect(presentation).toMatchObject({ tone: "danger", detail: "gpt-6" });
  });

  it("links a run-sourced fork to the source conversation", () => {
    const presentation = resolveLifecyclePresentation(
      item({
        type: "fork",
        source: { type: "run", threadId: "thread-src", runId: "run-1" },
        targetThreadId: "thread-1",
      }),
      [],
    );
    expect(presentation).toMatchObject({
      kind: "divider",
      label: "Forked from conversation",
      actionLabel: "Open source conversation",
      openThreadId: "thread-src",
    });
  });

  it("renders thread creation as a related-thread card", () => {
    const presentation = resolveLifecyclePresentation(
      item({
        type: "thread_created",
        title: "Investigate flaky test",
        targetThreadId: "thread-child",
        targetRunId: null,
        targetProviderInstanceId: "claude",
        targetModel: "claude-opus-5",
      }),
      [],
    );
    expect(presentation).toMatchObject({
      kind: "related-thread",
      title: "Investigate flaky test",
      detail: "claude · claude-opus-5",
      badge: "created",
      threadId: "thread-child",
      orbSeed: null,
      orbState: null,
    });
  });

  it("prefers streamed results for terminal subagents and progress for live ones", () => {
    const base = {
      type: "subagent",
      subagentId: "node-1",
      origin: "app_owned",
      driver: "claudeAgent",
      providerInstanceId: "claude",
      childThreadId: "thread-child",
      prompt: "do the thing",
      progress: "working on step 2",
      result: "all done",
    };
    expect(resolveLifecyclePresentation(item({ ...base, status: "completed" }), [])).toMatchObject({
      detail: "all done",
      badgeTone: "success",
      orbSeed: "thread-child",
      orbState: "done",
    });
    expect(resolveLifecyclePresentation(item({ ...base, status: "running" }), [])).toMatchObject({
      detail: "working on step 2",
      badgeTone: "neutral",
      orbState: "active",
    });
    expect(resolveLifecyclePresentation(item({ ...base, status: "cancelled" }), [])).toMatchObject({
      detail: "all done",
      orbState: "done",
    });
    expect(resolveLifecyclePresentation(item({ ...base, status: "failed" }), [])).toMatchObject({
      orbSeed: "thread-child",
      orbState: "failed",
    });
    expect(
      resolveLifecyclePresentation(item({ ...base, childThreadId: null, status: "running" }), []),
    ).toMatchObject({ orbSeed: "node-1" });
  });

  it("returns null for non-lifecycle items", () => {
    expect(resolveLifecyclePresentation(item({ type: "checkpoint", files: [] }), [])).toBeNull();
  });
});
