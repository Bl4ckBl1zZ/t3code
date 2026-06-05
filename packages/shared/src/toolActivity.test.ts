import { describe, expect, it } from "vite-plus/test";

import { deriveToolActivityPresentation } from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("uses nested raw tool arguments for read-file paths", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Tool call",
        data: {
          rawInput: {
            toolName: "read_file",
            arguments: {
              relativePath: "apps/web/src/components/ChatView.tsx",
            },
          },
        },
        fallbackSummary: "Tool call",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "apps/web/src/components/ChatView.tsx",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });

  it("labels browser click tools with a browser action", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Tool call",
        data: {
          rawInput: {
            payload: {
              tool: "browser_click",
              arguments: {
                ref: "button-submit",
              },
            },
          },
        },
        fallbackSummary: "Tool call",
      }),
    ).toEqual({
      summary: "Clicked browser",
      detail: "button-submit",
      browserAction: "click",
    });
  });

  it("labels browser scroll and screenshot tools", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "browser_scroll",
        data: {
          rawInput: {
            deltaY: 800,
          },
        },
      }),
    ).toEqual({
      summary: "Scrolled browser",
      browserAction: "scroll",
    });

    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "browser_screenshot",
      }),
    ).toEqual({
      summary: "Captured browser screenshot",
      browserAction: "screenshot",
    });
  });

  it("labels deep browser runtime inspection tools", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Tool call",
        data: {
          rawInput: {
            tool: "browser_cdp_evaluate",
            arguments: {
              expression: "window.__APP_STATE__",
            },
          },
        },
      }),
    ).toEqual({
      summary: "Evaluated browser runtime",
      detail: "window.__APP_STATE__",
      browserAction: "runtime-evaluate",
    });
  });

  it("labels Codex dynamic browser items from nested item data", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Tool call",
        data: {
          item: {
            type: "dynamicToolCall",
            tool: "browser_open_tab",
            arguments: {
              url: "http://localhost:5173/",
            },
          },
        },
      }),
    ).toEqual({
      summary: "Opened browser tab",
      detail: "http://localhost:5173/",
      browserAction: "open",
    });
  });
});
