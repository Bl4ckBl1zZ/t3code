import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { projectTurnItemForWire } from "./WireProjection.ts";

const base = {
  id: TurnItemId.make("tool-1"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: "MCP tool",
  toolName: "mcp__github__fetch_pr",
  input: { pr: 42 },
  startedAt: DateTime.makeUnsafe("2026-08-13T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
};

describe("orchestration V2 wire projection", () => {
  it("summarizes oversized dynamic tool results without mutating persistence data", () => {
    const output = { content: [{ type: "text", text: "first line\n" + "x".repeat(100_000) }] };
    const item = { ...base, output } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);

    expect(item.output).toBe(output);
    expect(projected).not.toBe(item);
    expect(JSON.stringify(projected).length).toBeLessThan(2_000);
    expect(projected.type === "dynamic_tool" ? projected.output : null).toMatchObject({
      truncated: true,
    });
  });

  it("keeps small dynamic tool values intact", () => {
    const item = { ...base, output: { ok: true } } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual(item);
  });

  it("keeps undefined dynamic input intact", () => {
    const item = { ...base, input: undefined } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual(item);
  });

  const command = {
    id: base.id,
    type: "command_execution" as const,
    threadId: base.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed" as const,
    title: "pnpm test",
    input: "pnpm test",
    startedAt: base.startedAt,
    completedAt: base.completedAt,
    updatedAt: base.updatedAt,
  };

  it("keeps a finished command's outcome without sending the output that proved it", () => {
    const output = `${"x".repeat(100_000)}\npnpm: command not found`;
    const item = { ...command, output } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);

    expect(projected.type === "command_execution" ? projected.output : "unset").toBeUndefined();
    expect(JSON.stringify(projected).length).toBeLessThan(1_000);
    expect(projected).toMatchObject({ outputIndicatesFailure: true });
  });

  it("reports a nonzero exit even when the provider closed the item as completed", () => {
    const item = { ...command, exitCode: 2, output: "done" } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toMatchObject({ outputIndicatesFailure: true });
  });

  it("leaves a successful command unflagged and output-free", () => {
    const item = { ...command, exitCode: 0, output: "done" } satisfies OrchestrationV2TurnItem;
    const { output: _output, ...expected } = item;
    expect(projectTurnItemForWire(item)).toEqual(expected);
  });

  it("sends only the last line of a background command that is still running", () => {
    const item = {
      ...command,
      background: true,
      status: "running" as const,
      completedAt: null,
      output: `${"x".repeat(100_000)}\nListening on :3000\n`,
    } satisfies OrchestrationV2TurnItem;

    expect(projectTurnItemForWire(item)).toMatchObject({ output: "Listening on :3000" });
  });

  it("stops sending a background command's tail once it finishes", () => {
    const item = {
      ...command,
      background: true,
      output: "Listening on :3000\n",
    } satisfies OrchestrationV2TurnItem;

    const projected = projectTurnItemForWire(item);
    expect(projected.type === "command_execution" ? projected.output : "unset").toBeUndefined();
  });
});
