import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { selectMissingTurnItems, turnItemContentKey } from "./TurnItemIdentity.ts";

const at = DateTime.makeUnsafe("2026-01-01T00:00:00Z");

function base(id: string) {
  return {
    id: id as OrchestrationV2TurnItem["id"],
    threadId: "thread:test" as OrchestrationV2TurnItem["threadId"],
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
}

describe("turnItemContentKey", () => {
  it("matches the same command whether it was streamed live or read back", () => {
    const live = {
      ...base("live"),
      type: "command_execution" as const,
      input: "pnpm test",
      output: "1000 passing",
    } satisfies OrchestrationV2TurnItem;
    const hydrated = {
      ...base("hydrated"),
      type: "command_execution" as const,
      input: "pnpm test",
      // History truncates outputs at its own limit, which is why the key
      // covers the call and not its result.
      output: "1000 pass… [output truncated]",
    } satisfies OrchestrationV2TurnItem;

    assert.equal(turnItemContentKey(live), turnItemContentKey(hydrated));
  });

  it("ignores tool input key order so a round-tripped payload still matches", () => {
    const live = {
      ...base("live"),
      type: "dynamic_tool" as const,
      toolName: "send_email",
      input: { to: "a@example.com", subject: "hi" },
    } satisfies OrchestrationV2TurnItem;
    const hydrated = {
      ...base("hydrated"),
      type: "dynamic_tool" as const,
      toolName: "send_email",
      input: { subject: "hi", to: "a@example.com" },
    } satisfies OrchestrationV2TurnItem;

    assert.equal(turnItemContentKey(live), turnItemContentKey(hydrated));
  });

  it("separates different calls of the same tool", () => {
    const first = {
      ...base("first"),
      type: "dynamic_tool" as const,
      toolName: "send_email",
      input: { to: "a@example.com" },
    } satisfies OrchestrationV2TurnItem;
    const second = {
      ...base("second"),
      type: "dynamic_tool" as const,
      toolName: "send_email",
      input: { to: "b@example.com" },
    } satisfies OrchestrationV2TurnItem;

    assert.notEqual(turnItemContentKey(first), turnItemContentKey(second));
  });

  it("keys reasoning by its text", () => {
    const item = {
      ...base("reasoning"),
      type: "reasoning" as const,
      text: "checking the batch",
      streaming: false,
    } satisfies OrchestrationV2TurnItem;

    assert.equal(turnItemContentKey(item), "reasoning\nchecking the batch");
  });

  it("declines to key items no rehydration produces", () => {
    const checkpoint = {
      ...base("checkpoint"),
      type: "checkpoint" as const,
      checkpointId: "checkpoint:1" as never,
      scopeId: "scope:1" as never,
      files: [],
    } satisfies OrchestrationV2TurnItem;

    assert.equal(turnItemContentKey(checkpoint), null);
  });
});

function command(id: string, input: string): OrchestrationV2TurnItem {
  return { ...base(id), type: "command_execution", input };
}

describe("selectMissingTurnItems", () => {
  it("drops a hydrated item that restates work already streamed live", () => {
    const missing = selectMissingTurnItems({
      projected: [command("live:1", "send batch")],
      snapshot: [command("history:1", "send batch")],
    });

    assert.deepEqual(missing, []);
  });

  it("keeps the second occurrence of a call that genuinely ran twice", () => {
    const missing = selectMissingTurnItems({
      projected: [command("live:1", "send batch")],
      snapshot: [command("history:1", "send batch"), command("history:2", "send batch")],
    });

    assert.deepEqual(
      missing.map((item) => String(item.id)),
      ["history:2"],
    );
  });

  it("keeps work the projection has never seen", () => {
    const missing = selectMissingTurnItems({
      projected: [command("live:1", "send batch")],
      snapshot: [command("history:1", "send the other batch")],
    });

    assert.deepEqual(
      missing.map((item) => String(item.id)),
      ["history:1"],
    );
  });

  it("counts an already-hydrated row once rather than twice", () => {
    // History holds two occurrences. The projection already accounts for
    // both: one hydrated earlier under its own id, one streamed live. The
    // hydrated row must not also spend budget as if it were a third.
    const missing = selectMissingTurnItems({
      projected: [command("history:1", "send batch"), command("live:1", "send batch")],
      snapshot: [command("history:1", "send batch"), command("history:2", "send batch")],
    });

    assert.deepEqual(missing, []);
  });

  it("hydrates an occurrence beyond everything the projection accounts for", () => {
    const missing = selectMissingTurnItems({
      projected: [command("history:1", "send batch"), command("live:1", "send batch")],
      snapshot: [
        command("history:1", "send batch"),
        command("history:2", "send batch"),
        command("history:3", "send batch"),
      ],
    });

    assert.deepEqual(
      missing.map((item) => String(item.id)),
      ["history:3"],
    );
  });
});
