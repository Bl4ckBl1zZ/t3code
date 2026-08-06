import { NodeId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import {
  formatOrchestrationV2RollbackDetail,
  formatOrchestrationV2TimelineDayLabel,
  isOrchestrationV2TurnItemVisible,
  orchestrationV2TimelineDayKey,
} from "./orchestrationV2Timeline.ts";

const runId = RunId.make("run:timeline-visibility");
const nodeId = NodeId.make("node:timeline-visibility");

describe("isOrchestrationV2TurnItemVisible", () => {
  it("hides unpaired interruption results from superseded attempts", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "running" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "superseded" }],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(false);
  });

  it("keeps paired interruption results from superseded attempts", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "running" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "superseded" }],
        items: [
          { type: "run_interrupt_request", runId, nodeId },
          { type: "run_interrupt_result", runId, nodeId },
        ],
      }),
    ).toBe(true);
  });

  it("keeps interruption results from terminal attempts without a request", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "interrupted" }],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(true);
  });

  it("keeps interruption results from terminal attempts with a request", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "interrupted" }],
        items: [
          { type: "run_interrupt_request", runId, nodeId },
          { type: "run_interrupt_result", runId, nodeId },
        ],
      }),
    ).toBe(true);
  });

  it("hides queued user messages once their run is cancelled", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "user_message", inputIntent: "queued_turn", runId, nodeId },
        runs: [{ id: runId, status: "cancelled" }],
        attempts: [],
        items: [{ type: "user_message", inputIntent: "queued_turn", runId, nodeId }],
      }),
    ).toBe(false);
  });

  it("keeps queued user messages while their run is queued", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "user_message", inputIntent: "queued_turn", runId, nodeId },
        runs: [{ id: runId, status: "queued" }],
        attempts: [],
        items: [{ type: "user_message", inputIntent: "queued_turn", runId, nodeId }],
      }),
    ).toBe(true);
  });

  it("keeps non-queued user messages on cancelled runs", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "user_message", inputIntent: "turn_start", runId, nodeId },
        runs: [{ id: runId, status: "cancelled" }],
        attempts: [],
        items: [{ type: "user_message", inputIntent: "turn_start", runId, nodeId }],
      }),
    ).toBe(true);
  });

  it("does not hide an interruption because another attempt was superseded", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [
          {
            runId,
            rootNodeId: NodeId.make("node:timeline-visibility:older"),
            status: "superseded",
          },
          { runId, rootNodeId: nodeId, status: "interrupted" },
        ],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(true);
  });
});

describe("timeline day boundaries", () => {
  // Anchored to a wall-clock time in the local zone, then serialised as a
  // zone-qualified instant, so expectations hold in any timezone and across DST.
  const localAt = (year: number, month: number, day: number, hour = 12) =>
    DateTime.makeZonedUnsafe(
      { year, month, day, hour },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
  const localIso = (year: number, month: number, day: number, hour = 12) =>
    DateTime.formatIso(localAt(year, month, day, hour));
  const nowMs = DateTime.toEpochMillis(localAt(2026, 3, 19));

  it("keys a timestamp to its local calendar day, late evening included", () => {
    expect(orchestrationV2TimelineDayKey(localIso(2026, 3, 19, 9))).toBe("2026-03-19");
    expect(orchestrationV2TimelineDayKey(localIso(2026, 3, 19, 23))).toBe("2026-03-19");
    expect(orchestrationV2TimelineDayKey("not a date")).toBeNull();
  });

  it("names the days a reader still holds in their head", () => {
    expect(formatOrchestrationV2TimelineDayLabel(localIso(2026, 3, 19, 9), nowMs)).toBe("Today");
    expect(formatOrchestrationV2TimelineDayLabel(localIso(2026, 3, 18, 22), nowMs)).toBe(
      "Yesterday",
    );
    expect(formatOrchestrationV2TimelineDayLabel("bad input", nowMs)).toBe("Earlier");
  });

  it("dates older days, and only shows the year once it differs", () => {
    const thisYear = formatOrchestrationV2TimelineDayLabel(localIso(2026, 3, 2), nowMs);
    const lastYear = formatOrchestrationV2TimelineDayLabel(localIso(2025, 11, 2), nowMs);

    expect(thisYear).not.toBe("Today");
    expect(thisYear).not.toContain("2026");
    expect(lastYear).toContain("2025");
  });
});

describe("rollback detail", () => {
  it("drops either half when it is zero, and both when nothing moved", () => {
    expect(
      formatOrchestrationV2RollbackDetail({ rolledBackRunCount: 1, restoredFileCount: 1 }),
    ).toBe("1 turn · 1 file restored");
    expect(
      formatOrchestrationV2RollbackDetail({ rolledBackRunCount: 2, restoredFileCount: 0 }),
    ).toBe("2 turns");
    expect(
      formatOrchestrationV2RollbackDetail({ rolledBackRunCount: 0, restoredFileCount: 3 }),
    ).toBe("3 files restored");
    expect(
      formatOrchestrationV2RollbackDetail({ rolledBackRunCount: 0, restoredFileCount: 0 }),
    ).toBeNull();
  });
});
