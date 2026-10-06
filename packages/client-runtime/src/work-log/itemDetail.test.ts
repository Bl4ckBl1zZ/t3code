import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  formatToolValue,
  turnItemDetailRevision,
  turnItemHasDetail,
  turnItemNeedsDetailFetch,
  turnItemOutputImages,
  turnItemOutputText,
} from "./itemDetail.ts";

const updatedAt = DateTime.makeUnsafe("2026-10-04T00:00:01.000Z");
const base = {
  id: TurnItemId.make("item-1"),
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  startedAt: updatedAt,
  completedAt: updatedAt,
  updatedAt,
};
const command = { ...base, type: "command_execution" as const, input: "pnpm test" };
const tool = { ...base, type: "dynamic_tool" as const, toolName: "mcp__github__pr", input: {} };

describe("turn item detail", () => {
  it("fetches only output the timeline withheld", () => {
    expect(turnItemNeedsDetailFetch({ ...command, outputOmitted: true })).toBe(true);
    expect(turnItemNeedsDetailFetch(command)).toBe(false);
    expect(turnItemNeedsDetailFetch({ ...tool, output: { ok: true } })).toBe(false);
    expect(turnItemNeedsDetailFetch({ ...tool, input: { summary: "big", truncated: true } })).toBe(
      true,
    );
  });

  it("keeps one cache key while an item runs and a new one when it settles", () => {
    expect(turnItemDetailRevision({ ...command, status: "running" })).toBe("live");
    expect(turnItemDetailRevision(command)).toBe("2026-10-04T00:00:01.000Z");
  });

  it("only offers a disclosure when expanding shows something", () => {
    expect(turnItemHasDetail({ ...command, input: " " })).toBe(false);
    expect(turnItemHasDetail({ ...command, input: " ", outputOmitted: true })).toBe(true);
    expect(turnItemHasDetail(tool)).toBe(false);
    expect(turnItemHasDetail({ ...tool, input: { pr: 42 } })).toBe(true);
    expect(turnItemHasDetail({ ...base, type: "file_search", title: "Grep", pattern: "" })).toBe(
      false,
    );
    expect(turnItemHasDetail({ ...base, type: "file_search", pattern: "TODO" })).toBe(true);
  });

  it("shows text results as text and older Claude bash results as their streams", () => {
    expect(
      turnItemOutputText({
        ...tool,
        output: { content: [{ type: "text", text: '{"ok":true}' }] },
      } satisfies OrchestrationV2TurnItem),
    ).toBe('{\n  "ok": true\n}');
    expect(
      turnItemOutputText({
        ...command,
        output: JSON.stringify({ stdout: "built", stderr: "", interrupted: false }),
      }),
    ).toBe("built");
    expect(turnItemOutputText({ ...tool, output: { ok: true }, outputOmitted: true })).toBeNull();
    expect(formatToolValue({})).toBeNull();
  });
});

describe("tool output images", () => {
  const screenshot = {
    id: TurnItemId.make("tool-screenshot"),
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
    title: null,
    toolName: "mcp__t3-code__preview_snapshot",
    input: {},
    // What a detail read returns: the image's position without its bytes.
    output: {
      content: [
        { type: "text", text: "Captured the home screen." },
        { type: "image", mimeType: "image/png" },
      ],
    },
    startedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
    completedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
  };

  it("shows a screenshot as an image asset, not as text", () => {
    expect(turnItemOutputImages(screenshot)).toEqual([
      {
        _tag: "tool-output-image",
        threadId: screenshot.threadId,
        itemId: screenshot.id,
        index: 0,
      },
    ]);
    expect(turnItemOutputText(screenshot)).toBe("Captured the home screen.");
    expect(
      turnItemOutputText({ ...screenshot, output: { content: [screenshot.output.content[1]] } }),
    ).toBeNull();
  });

  it("keeps a placeholder for images it cannot show", () => {
    const output = { content: [{ type: "image", mimeType: "image/svg+xml" }] };
    expect(turnItemOutputImages({ ...screenshot, output })).toEqual([]);
    expect(turnItemOutputText({ ...screenshot, output })).toBe("[image]");
  });
});
