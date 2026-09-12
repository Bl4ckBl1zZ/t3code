import { describe, expect, it } from "vite-plus/test";

import { resolveT3McpToolPresentation } from "./t3McpToolPresentation.ts";

describe("resolveT3McpToolPresentation", () => {
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

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveT3McpToolPresentation("mcp__github__search_issues")).toBeNull();
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
