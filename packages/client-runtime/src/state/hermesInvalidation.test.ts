import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2ThreadStreamItem } from "@t3tools/contracts";
import { createHermesThreadInvalidationFilter } from "./hermesInvalidation.ts";

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
