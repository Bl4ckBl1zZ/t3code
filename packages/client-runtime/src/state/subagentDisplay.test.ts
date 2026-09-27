import type { OrchestrationV2TurnItemStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  subagentGroupSummary,
  subagentGroupTiming,
  summarizeSubagentStatuses,
} from "./subagentDisplay.js";

describe("subagentGroupSummary", () => {
  it.each(["pending", "running", "waiting"] as const)(
    "keeps a mixed group live while a member is %s",
    (status) => {
      expect(subagentGroupSummary([{ status: "completed" }, { status }])).toEqual({
        label: "Kicked off 2 subagents",
        active: true,
        failed: false,
      });
    },
  );

  it("settles the label without disguising a failed member as success", () => {
    const statuses: OrchestrationV2TurnItemStatus[] = [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ];
    expect(subagentGroupSummary(statuses.map((status) => ({ status })))).toEqual({
      label: "Ran 4 subagents",
      active: false,
      failed: true,
    });
  });

  it("uses a singular label for one idle member", () => {
    expect(subagentGroupSummary([{ status: "idle" }])).toEqual({
      label: "Ran 1 subagent",
      active: false,
      failed: false,
    });
  });
});

describe("summarizeSubagentStatuses", () => {
  it("counts working first, then outcomes, and leaves out empty buckets", () => {
    expect(
      summarizeSubagentStatuses([
        "completed",
        "running",
        "failed",
        "pending",
        "cancelled",
        "interrupted",
        "idle",
        "waiting",
      ]),
    ).toBe("3 working · 1 done · 1 failed · 2 stopped · 1 idle");
    expect(summarizeSubagentStatuses(["completed", "completed"])).toBe("2 done");
  });
});

describe("subagentGroupTiming", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);

  it("spans first launch to last settle once every member finished", () => {
    expect(
      subagentGroupTiming([
        {
          status: "completed",
          startedAt: at("2026-01-01T00:00:10.000Z"),
          completedAt: at("2026-01-01T00:01:00.000Z"),
        },
        {
          status: "failed",
          startedAt: at("2026-01-01T00:00:00.000Z"),
          completedAt: at("2026-01-01T00:02:00.000Z"),
        },
      ]),
    ).toEqual({
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:02:00.000Z",
    });
  });

  it("keeps running while a member works", () => {
    expect(
      subagentGroupTiming([
        {
          status: "completed",
          startedAt: at("2026-01-01T00:00:00.000Z"),
          completedAt: at("2026-01-01T00:01:00.000Z"),
        },
        { status: "running", startedAt: at("2026-01-01T00:00:30.000Z"), completedAt: null },
      ]),
    ).toEqual({ status: "running", startedAt: "2026-01-01T00:00:00.000Z", completedAt: null });
  });

  it("withholds the end when a settled member has no completion time", () => {
    expect(
      subagentGroupTiming([
        { status: "completed", startedAt: at("2026-01-01T00:00:00.000Z"), completedAt: null },
      ]).completedAt,
    ).toBeNull();
  });
});
