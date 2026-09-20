import { describe, expect, it } from "vite-plus/test";

import { T3_MCP_TOOL_NAMES, resolveT3McpToolPresentation } from "./t3McpToolPresentation.ts";

describe("resolveT3McpToolPresentation", () => {
  it("recognizes every T3 tool across provider prefixes and completion suffixes", () => {
    for (const tool of T3_MCP_TOOL_NAMES) {
      const presentation = resolveT3McpToolPresentation(tool);
      for (const prefix of [
        "mcp__t3-code__",
        "mcp__t3_code__",
        "mcp__t3code__",
        "T3-code.",
        "t3_code/",
        "t3code:",
        "mcp_t3-code_",
        "T3 Code ",
        "t3-code · ",
      ]) {
        expect(resolveT3McpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveT3McpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("pretty prints Claude and Cursor T3 MCP tool names", () => {
    expect(resolveT3McpToolPresentation("mcp__t3-code__t3_thread_read")).toEqual({
      displayName: "Read a T3 thread",
      logo: "t3-code",
    });
  });

  it("pretty prints Codex T3 MCP tool names", () => {
    expect(resolveT3McpToolPresentation("t3-code.create_threads")).toEqual({
      displayName: "Create T3 threads",
      logo: "t3-code",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveT3McpToolPresentation("mcp__t3-code__t3_thread_update")).toEqual({
      displayName: "Update T3 thread metadata",
      logo: "t3-code",
    });
  });

  it("pretty prints bare T3 MCP toolkit names", () => {
    expect(resolveT3McpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "t3-code",
    });
  });

  it("pretty prints worktree T3 MCP tool names", () => {
    expect(resolveT3McpToolPresentation("mcp__t3-code__t3_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "t3-code",
    });
    expect(resolveT3McpToolPresentation("t3-code.t3_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "t3-code",
    });
  });

  it("pretty prints preview T3 MCP tool names", () => {
    expect(resolveT3McpToolPresentation("T3-code.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "browser",
    });
    expect(resolveT3McpToolPresentation("mcp__t3-code__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "browser",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_t3-code_delegate_task",
      "t3_code:delegate_task",
      "t3code/delegate_task",
      "t3-code delegate_task",
      "T3 Code delegate_task",
      "t3-code__delegate_task",
    ]) {
      expect(resolveT3McpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveT3McpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveT3McpToolPresentation("t3-code.not_a_real_tool")).toBeNull();
  });
});

// State is provider data: a failed request must never read as a successful link.
describe("tool intent and status", () => {
  it.each([
    ["running", "Linking PR #42"],
    ["completed", "Linked PR #42"],
    ["failed", "Failed to link PR #42"],
    ["cancelled", "Stopped linking PR #42"],
  ])("presents %s linking", (status, displayName) => {
    expect(
      resolveT3McpToolPresentation("t3-code · link_pull_request", status, {
        url: "https://github.com/org/repo/pull/42/files",
        number: 9,
      }),
    ).toEqual({ displayName, logo: "pull-request", action: "link-pr" });
  });
  it("does not invent a PR number from an unrelated URL or invalid number", () => {
    expect(
      resolveT3McpToolPresentation("unlink_pull_request", "completed", {
        url: "https://example.com/org/repo/pull/42",
        number: -1,
      })?.displayName,
    ).toBe("Unlinked a pull request");
    expect(
      resolveT3McpToolPresentation("list_thread_pull_requests", "completed", { number: 42 })
        ?.displayName,
    ).toBe("Checked linked pull requests");
  });
  it("uses provider completion for readable browser actions", () => {
    expect(resolveT3McpToolPresentation("mcp__t3_code__preview_snapshot", "completed")).toEqual({
      displayName: "Took a snapshot of the preview page",
      logo: "browser",
    });
  });
});
