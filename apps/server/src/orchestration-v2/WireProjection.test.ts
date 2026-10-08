import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { MAX_TOOL_OUTPUT_IMAGES, toolOutputImages } from "@t3tools/shared/toolOutput";
import { projectTurnItemForDetail, projectTurnItemForWire } from "./WireProjection.ts";

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
    // Clients fetch the summarized result on demand, so they need to know it exists.
    expect(projected).toMatchObject({ outputOmitted: true });
  });

  it("sends a captured MCP app as its reference, however large the result", () => {
    const app = {
      attachmentId: "thread-1-00000000-0000-0000-0000-000000000000-html",
      server: "weather",
      tool: "get_weather",
      resourceUri: "ui://weather/dashboard",
    };
    const item = {
      ...base,
      toolName: "weather.get_weather",
      output: { t3McpApp: app, result: { content: [{ type: "text", text: "x".repeat(100_000) }] } },
    } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);
    expect(projected.type === "dynamic_tool" ? projected.output : null).toEqual({ t3McpApp: app });
    expect(projected).toMatchObject({ outputOmitted: true });
    // A result only imitating another server's app is summarized like any other.
    const forged = projectTurnItemForWire({ ...item, toolName: "evil.lookup" });
    expect(forged.type === "dynamic_tool" ? forged.output : null).toMatchObject({
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
    expect(projectTurnItemForWire(item)).toEqual({ ...expected, outputOmitted: true });
  });

  it.each([undefined, "", "  \n"])("does not offer to fetch blank output %#", (output) => {
    const item = {
      ...command,
      exitCode: 0,
      ...(output === undefined ? {} : { output }),
    } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).not.toHaveProperty("outputOmitted");
  });

  it.each([
    ["echo ok", "echo ok"],
    ["a".repeat(262_143) + "😀", "a".repeat(262_143) + "\n… output truncated for transport"],
  ])("bounds fetched command input without changing persistence, case %#", (input, expected) => {
    const item = { ...command, input, output: "ok" } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForDetail(item);
    expect(projected).toMatchObject({ input: expected, output: "ok" });
    expect(item.input).toBe(input);
  });

  it("leaves a screenshot's bytes out of the fetched tool output", () => {
    const data = "A".repeat(600_000);
    const item = {
      ...base,
      toolName: "mcp__t3-code__preview_snapshot",
      input: {},
      output: {
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
      },
    };
    expect(projectTurnItemForDetail(item)).toMatchObject({
      output: { content: [{ type: "image", mimeType: "image/png" }] },
    });
    expect(item.output.content[0]?.source.data).toBe(data);
  });

  it("keeps image markers when the rest of a tool output is too large to send", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    };
    const item = {
      ...base,
      output: { content: [{ type: "text", text: "x".repeat(300_000) }, image] },
    };
    const projected = projectTurnItemForDetail(item);
    const output = projected.type === "dynamic_tool" ? projected.output : null;
    expect(Array.isArray(output) ? output.slice(1) : null).toEqual([
      { type: "image", mimeType: "image/png" },
    ]);
    expect(JSON.stringify(output).length).toBeLessThan(270_000);
  });

  it("bounds a tool output made of many images", () => {
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    const item = { ...base, output: Array.from({ length: 10_000 }, () => image) };
    const projected = projectTurnItemForDetail(item);
    const output = projected.type === "dynamic_tool" ? projected.output : null;
    // The truncated text block plus a fixed number of markers, however many images there are.
    expect(Array.isArray(output) ? output.length : null).toBe(1 + MAX_TOOL_OUTPUT_IMAGES);
    expect(Array.isArray(output) ? String(output[0]?.text).length : null).toBeLessThan(263_000);
    expect(toolOutputImages(output)).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });

  it("returns a fetched dynamic tool's full result, bounded for the wire", () => {
    const output = { content: [{ type: "text", text: "first line\n" + "x".repeat(100_000) }] };
    const item = { ...base, output } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForDetail(item)).toMatchObject({ output });
    const huge = { ...base, output: "y".repeat(300_000) } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForDetail(huge);
    expect(projected.type === "dynamic_tool" ? projected.output : null).toMatch(
      /… output truncated for transport$/u,
    );
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
