import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import {
  isV2LifecycleTimelineItem,
  resolveLifecyclePresentation,
  subagentOrbSeed,
  workingSubagents,
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
  it("renders interrupt request as a danger divider, matching its result", () => {
    expect(
      resolveLifecyclePresentation(
        item({ type: "run_interrupt_request", message: "user requested stop" }),
        [],
      ),
    ).toMatchObject({
      kind: "divider",
      label: "Interrupt requested",
      detail: "user requested stop",
      tone: "danger",
    });
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

  it("renders thread creation as a related-thread row with a muted note", () => {
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
      preview: "claude · claude-opus-5",
      detail: null,
      meta: "Created",
      status: null,
      threadId: "thread-child",
      orbSeed: null,
      orbState: null,
    });
  });

  it("names a subagent, previews its task, and prefers results once it stops", () => {
    const base = {
      type: "subagent",
      subagentId: "node-1",
      origin: "app_owned",
      driver: "claudeAgent",
      providerInstanceId: "claude",
      childThreadId: "thread-child",
      title: "Flaky test hunter",
      prompt: "Find the flaky test\n\nand   fix it",
      progress: "working on step 2",
      result: "all done",
    };
    expect(resolveLifecyclePresentation(item({ ...base, status: "completed" }), [])).toMatchObject({
      title: "Flaky test hunter",
      preview: "Find the flaky test and fix it",
      detail: "all done",
      meta: null,
      status: null,
      orbSeed: "thread-child",
      orbState: "done",
    });
    expect(resolveLifecyclePresentation(item({ ...base, status: "running" }), [])).toMatchObject({
      detail: "working on step 2",
      status: "running",
      orbState: "active",
    });
    expect(resolveLifecyclePresentation(item({ ...base, status: "cancelled" }), [])).toMatchObject({
      detail: "all done",
      status: "stopped",
      orbState: "done",
    });
    expect(resolveLifecyclePresentation(item({ ...base, status: "failed" }), [])).toMatchObject({
      status: "failed",
      orbSeed: "thread-child",
      orbState: "failed",
    });
    // The task is already the preview, so an agent with nothing streamed yet
    // has no second line rather than the prompt twice.
    expect(
      resolveLifecyclePresentation(
        item({
          ...base,
          childThreadId: null,
          status: "running",
          progress: undefined,
          result: null,
        }),
        [],
      ),
    ).toMatchObject({ orbSeed: "node-1", detail: null });
  });

  it("returns null for non-lifecycle items", () => {
    expect(resolveLifecyclePresentation(item({ type: "checkpoint", files: [] }), [])).toBeNull();
  });
});

describe("checkpoint rollback presentation", () => {
  it("renders as a neutral divider counting turns and restored files", () => {
    expect(
      resolveLifecyclePresentation(
        item({
          type: "checkpoint_rollback",
          checkpointId: "checkpoint-1",
          scopeId: "scope-1",
          restoredFileCount: 3,
          rolledBackRunCount: 2,
        }),
        [],
      ),
    ).toMatchObject({
      kind: "divider",
      label: "Rolled back",
      detail: "2 turns · 3 files restored",
      tone: "neutral",
    });
  });

  it("is treated as a first-class lifecycle row, not work-log activity", () => {
    expect(isV2LifecycleTimelineItem(item({ type: "checkpoint_rollback" }))).toBe(true);
  });
});

describe("workingSubagents", () => {
  const projected = (partial: Record<string, unknown>) =>
    ({
      position: 0,
      visibility: "local",
      sourceThreadId: "thread-1",
      sourceItemId: String(partial.id),
      item: item({
        type: "subagent",
        subagentId: `node-${String(partial.id)}`,
        childThreadId: null,
        prompt: "Inspect the package",
        result: null,
        ...partial,
      }),
    }) as never;

  it("keeps subagents still in flight, in timeline order", () => {
    const working = workingSubagents([
      projected({ id: "a", status: "running" }),
      projected({ id: "b", status: "completed" }),
      projected({ id: "c", status: "pending" }),
      projected({ id: "d", status: "failed" }),
      projected({ id: "e", status: "waiting" }),
      projected({ id: "f", status: "interrupted" }),
      projected({ id: "g", type: "command_execution", status: "running" }),
    ]);
    expect(working.map((subagent) => subagent.id)).toEqual(["a", "c", "e"]);
  });

  it("seeds the orb by child thread, falling back to the subagent id", () => {
    const [withThread, withoutThread] = workingSubagents([
      projected({ id: "a", status: "running", childThreadId: "thread-a" }),
      projected({ id: "b", status: "running" }),
    ]);
    expect(withThread && subagentOrbSeed(withThread)).toBe("thread-a");
    expect(withoutThread && subagentOrbSeed(withoutThread)).toBe("node-b");
  });
});
