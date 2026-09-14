import { Effect, Fiber, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2ThreadStreamItem } from "@t3tools/contracts";
import {
  batchHermesInvalidations,
  createHermesThreadInvalidationFilter,
} from "./hermesInvalidation.ts";

function event(type: string, payload: Record<string, unknown>) {
  return { kind: "event", event: { type, payload } } as OrchestrationV2ThreadStreamItem;
}

describe("Hermes thread detail invalidation", () => {
  it("ignores token and thinking updates while observing session transitions", () => {
    const invalidate = createHermesThreadInvalidationFilter();
    const session = {
      id: "session",
      providerInstanceId: "hermes",
      status: "running",
      cwd: "/work",
    };
    expect(invalidate(event("provider-session.updated", session))).toBe(true);
    expect(
      invalidate(event("provider-session.updated", { ...session, activityText: "Thinking" })),
    ).toBe(false);
    expect(invalidate(event("message.updated", { id: "message", text: "answer token" }))).toBe(
      false,
    );
    expect(invalidate(event("provider-session.updated", { ...session, status: "ready" }))).toBe(
      true,
    );
    expect(invalidate(event("provider-session.updated", { ...session, cwd: "/other" }))).toBe(true);
  });

  it("refreshes once for a completed native tool, never for streamed output", () => {
    const invalidate = createHermesThreadInvalidationFilter();
    const tool = { id: "tool", type: "dynamic_tool", status: "running" };
    expect(invalidate(event("turn-item.updated", tool))).toBe(false);
    expect(invalidate(event("turn-item.updated", { ...tool, status: "completed" }))).toBe(true);
    expect(
      invalidate(
        event("turn-item.updated", { ...tool, status: "completed", output: "same receipt" }),
      ),
    ).toBe(false);
    expect(
      invalidate(
        event("turn-item.updated", {
          id: "answer",
          type: "assistant_message",
          status: "completed",
        }),
      ),
    ).toBe(false);
  });

  it("observes run boundaries and authoritative binding replacement", () => {
    const invalidate = createHermesThreadInvalidationFilter();
    expect(invalidate(event("run.created", { id: "run", status: "running" }))).toBe(true);
    expect(invalidate(event("run.updated", { id: "run", status: "running" }))).toBe(false);
    expect(invalidate(event("run.updated", { id: "run", status: "completed" }))).toBe(true);
    const binding = {
      id: "binding",
      providerInstanceId: "hermes",
      providerSessionId: "session",
      nativeThreadRef: { id: "native" },
      status: "active",
    };
    expect(invalidate(event("provider-thread.updated", binding))).toBe(true);
    expect(invalidate(event("provider-thread.updated", { ...binding, updatedAt: "later" }))).toBe(
      false,
    );
    expect(invalidate({ kind: "synchronized" })).toBe(false);
  });
});

it.effect("flushes during continuous events and retains the final invalidation", () =>
  Effect.gen(function* () {
    const seen: number[] = [];
    const fiber = yield* Stream.range(1, 10).pipe(
      Stream.tap(() => Effect.sleep("50 millis")),
      batchHermesInvalidations,
      Stream.runForEach((value) =>
        Effect.sync(() => {
          seen.push(value);
        }),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("250 millis");
    expect(seen.length).toBeGreaterThan(0);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    expect(seen.at(-1)).toBe(10);
  }).pipe(Effect.provide(TestClock.layer())),
);

it("refreshes reattached sessions and tools that become terminal again", () => {
  const invalidate = createHermesThreadInvalidationFilter();
  const session = { id: "session", providerInstanceId: "hermes", status: "ready", cwd: "/work" };
  expect(invalidate(event("provider-session.attached", session))).toBe(true);
  expect(invalidate(event("provider-session.detached", { providerSessionId: "session" }))).toBe(
    true,
  );
  expect(invalidate(event("provider-session.attached", session))).toBe(true);
  const tool = { id: "tool", type: "dynamic_tool", status: "completed" };
  expect(invalidate(event("turn-item.updated", tool))).toBe(true);
  expect(invalidate(event("turn-item.updated", { ...tool, status: "running" }))).toBe(false);
  expect(invalidate(event("turn-item.updated", tool))).toBe(true);
});
