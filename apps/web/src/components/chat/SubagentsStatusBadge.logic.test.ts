import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "~/session-logic";
import { subagentOrbSeed, workingSubagentsFromTimeline } from "./SubagentsStatusBadge.logic";

const CREATED_AT = "2026-09-19T12:00:00.000Z";

function subagentEntry(
  id: string,
  status: OrchestrationV2TurnItem["status"],
  childThreadId: string | null = `thread-${id}`,
): TimelineEntry {
  return {
    id,
    kind: "event",
    createdAt: CREATED_AT,
    projectedItem: {
      position: 0,
      visibility: "local",
      sourceThreadId: "thread-1",
      sourceItemId: id,
      item: {
        id,
        threadId: "thread-1",
        runId: "run-1",
        nodeId: `node-${id}`,
        providerThreadId: "provider-thread-1",
        providerTurnId: "provider-turn-1",
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status,
        title: `Subagent: ${id}`,
        startedAt: null,
        completedAt: null,
        updatedAt: {},
        type: "subagent",
        subagentId: `node-${id}`,
        origin: "provider_native",
        driver: "claudeAgent",
        providerInstanceId: "claudeAgent",
        childThreadId,
        prompt: "Inspect the package",
        result: null,
      },
    } as never,
  };
}

describe("workingSubagentsFromTimeline", () => {
  it("keeps subagents still in flight, in timeline order", () => {
    const working = workingSubagentsFromTimeline([
      subagentEntry("a", "running"),
      subagentEntry("b", "completed"),
      subagentEntry("c", "pending"),
      subagentEntry("d", "failed"),
      subagentEntry("e", "waiting"),
      subagentEntry("f", "cancelled"),
    ]);
    expect(working.map((item) => item.id)).toEqual(["a", "c", "e"]);
  });

  it("finds nothing when every subagent has settled", () => {
    expect(
      workingSubagentsFromTimeline([
        subagentEntry("a", "completed"),
        subagentEntry("b", "interrupted"),
      ]),
    ).toEqual([]);
  });
});

describe("subagentOrbSeed", () => {
  it("seeds by child thread so the orb matches the relationships panel", () => {
    const [item] = workingSubagentsFromTimeline([subagentEntry("a", "running")]);
    expect(item && subagentOrbSeed(item)).toBe("thread-a");
  });

  it("falls back to the subagent id before a child thread exists", () => {
    const [item] = workingSubagentsFromTimeline([subagentEntry("a", "running", null)]);
    expect(item && subagentOrbSeed(item)).toBe("node-a");
  });
});
