import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import { type OrchestrationV2Run, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { canContinueAfterRestart } from "./RestartContinuationPolicy.ts";

const run = {
  id: "run",
  ordinal: 1,
  providerInstanceId: "codex",
  providerThreadId: "native",
  status: "running",
} as OrchestrationV2Run;
const fixture = () =>
  ({
    thread: {
      id: "thread",
      archivedAt: null,
      deletedAt: null,
      providerInstanceId: "codex",
      activeProviderThreadId: "native",
      settledOverride: null,
    },
    runs: [run],
    turnItems: [],
    runtimeRequests: [],
    messages: [],
    providerThreads: [
      {
        id: "native",
        ownerNodeId: null,
        status: "active",
        nativeThreadRef: { nativeId: "saved", strength: "strong" },
      },
    ],
  }) as unknown as OrchestrationV2ThreadProjection;

describe("restart continuation ownership", () => {
  it("prepares only running work with a saved provider reference", () => {
    const projection = fixture();
    expect(canContinueAfterRestart(projection, run, "prepare")).toBe(true);
    for (const status of ["starting", "queued", "completed", "cancelled", "failed"] as const)
      expect(canContinueAfterRestart(projection, { ...run, status }, "prepare")).toBe(false);
    expect(canContinueAfterRestart({ ...projection, providerThreads: [] }, run, "prepare")).toBe(
      false,
    );
    expect(
      canContinueAfterRestart(
        {
          ...projection,
          providerThreads: projection.providerThreads.map((thread) => ({
            ...thread,
            nativeThreadRef: { ...thread.nativeThreadRef!, nativeId: null },
          })),
        },
        run,
        "prepare",
      ),
    ).toBe(false);
  });
  it("does not resume archived, settled, superseded or blocked work", () => {
    const projection = fixture();
    const pending = {
      ...run,
      status: "cancelled" as const,
      restartContinuation: { messageId: "continuation", reason: "restart", status: "pending" },
    } as OrchestrationV2Run;
    const recovered = { ...projection, runs: [pending] };
    expect(canContinueAfterRestart(recovered, pending, "resume")).toBe(true);
    for (const thread of [
      { ...projection.thread, archivedAt: DateTime.makeUnsafe(0) },
      { ...projection.thread, settledOverride: "settled" },
      { ...projection.thread, activeProviderThreadId: null },
    ])
      expect(
        canContinueAfterRestart(
          { ...recovered, thread } as unknown as OrchestrationV2ThreadProjection,
          pending,
          "resume",
        ),
      ).toBe(false);
    expect(
      canContinueAfterRestart(
        { ...recovered, runs: [pending, { ...run, ordinal: 2 }] },
        pending,
        "resume",
      ),
    ).toBe(false);
    expect(
      canContinueAfterRestart(
        {
          ...recovered,
          messages: [{ id: "continuation" }],
        } as unknown as OrchestrationV2ThreadProjection,
        pending,
        "resume",
      ),
    ).toBe(false);
    expect(
      canContinueAfterRestart(
        {
          ...recovered,
          runtimeRequests: [{ status: "pending", responseMode: "callback" }],
        } as unknown as OrchestrationV2ThreadProjection,
        pending,
        "resume",
      ),
    ).toBe(false);
  });
});
