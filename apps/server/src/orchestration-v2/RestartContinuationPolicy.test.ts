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
    providerTurns: [],
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
  it("continues past a held queue, which waits behind the continuation", () => {
    const projection = fixture();
    const held = { ...run, id: "held", ordinal: 2, status: "queued", queueHeld: true };
    expect(
      canContinueAfterRestart(
        { ...projection, runs: [run, { ...held, queueHeld: false }] } as never,
        run,
        "prepare",
      ),
    ).toBe(true);
    const pending = {
      ...run,
      status: "cancelled" as const,
      completedAt: DateTime.makeUnsafe(1_000),
      restartContinuation: { messageId: "continuation", reason: "restart", status: "pending" },
    } as OrchestrationV2Run;
    expect(
      canContinueAfterRestart({ ...projection, runs: [pending, held] } as never, pending, "resume"),
    ).toBe(true);
    // A queue that is not held would start on its own instead.
    expect(
      canContinueAfterRestart(
        { ...projection, runs: [pending, { ...held, queueHeld: false }] } as never,
        pending,
        "resume",
      ),
    ).toBe(false);
  });
  it("leaves a run waiting on a secret or with an ended provider turn for the user", () => {
    const projection = fixture();
    const withAttempt = { ...run, activeAttemptId: "attempt" } as OrchestrationV2Run;
    const secret = (secretStatus: string) =>
      ({
        ...projection,
        runs: [withAttempt],
        turnItems: [{ type: "secret_request", runId: "run", secretStatus }],
      }) as unknown as OrchestrationV2ThreadProjection;
    expect(canContinueAfterRestart(secret("saved"), withAttempt, "prepare")).toBe(true);
    expect(canContinueAfterRestart(secret("pending"), withAttempt, "prepare")).toBe(false);
    const turn = (status: string) =>
      ({
        ...projection,
        runs: [withAttempt],
        providerTurns: [{ runAttemptId: "attempt", ordinal: 1, status }],
      }) as unknown as OrchestrationV2ThreadProjection;
    expect(canContinueAfterRestart(turn("running"), withAttempt, "prepare")).toBe(true);
    for (const status of ["completed", "failed", "interrupted"])
      expect(canContinueAfterRestart(turn(status), withAttempt, "prepare")).toBe(false);
  });
  it("stops after three automatic continuations in a row", () => {
    // Each continuation run starts from the message its source reserved.
    const chain = (length: number) => {
      const runs: OrchestrationV2Run[] = [{ ...run, userMessageId: "user" } as OrchestrationV2Run];
      const message = { text: "Continue", attachments: [] };
      const messages: Array<{ id: string; restartContinuation?: boolean }> = [
        { ...message, id: "user" },
      ];
      for (let index = 1; index <= length; index++) {
        const messageId = `continuation-${index}`;
        runs[index - 1] = {
          ...runs[index - 1]!,
          status: "cancelled",
          restartContinuation: { messageId, reason: "restart", status: "consumed" },
        } as OrchestrationV2Run;
        runs.push({
          ...run,
          id: `run-${index}`,
          ordinal: index + 1,
          userMessageId: messageId,
        } as OrchestrationV2Run);
        messages.push({ ...message, id: messageId, restartContinuation: true });
      }
      const latest = runs.at(-1)!;
      return {
        latest,
        projection: { ...fixture(), runs, messages } as unknown as OrchestrationV2ThreadProjection,
      };
    };
    for (const length of [0, 1, 2]) {
      const { latest, projection } = chain(length);
      expect(canContinueAfterRestart(projection, latest, "prepare")).toBe(true);
    }
    const { latest, projection } = chain(3);
    expect(canContinueAfterRestart(projection, latest, "prepare")).toBe(false);
  });
  it("does not continue a native maintenance command", () => {
    const compact = { ...run, userMessageId: "compact" } as OrchestrationV2Run;
    const projection = {
      ...fixture(),
      runs: [compact],
      messages: [{ id: "compact", text: "/compact", attachments: [] }],
    } as unknown as OrchestrationV2ThreadProjection;
    expect(canContinueAfterRestart(projection, compact, "prepare")).toBe(false);
  });
});
