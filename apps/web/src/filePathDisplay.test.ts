import { describe, expect, it } from "vite-plus/test";

import { formatPathWithinWorkspace, formatWorkspaceRelativePath } from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  it("formats absolute workspace paths from the workspace root", () => {
    expect(
      formatWorkspaceRelativePath(
        "C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("prefixes relative paths with the workspace root label", () => {
    expect(
      formatWorkspaceRelativePath(
        "apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("keeps paths already rooted at the workspace label stable", () => {
    expect(
      formatWorkspaceRelativePath(
        "t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("preserves columns when present", () => {
    expect(
      formatWorkspaceRelativePath(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501:9",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501:9");
  });
});

describe("formatPathWithinWorkspace", () => {
  const WORKTREE = "/Users/mike/.t3/worktrees/t3code/t3code-139f72d1";

  it("drops the worktree name from an absolute path", () => {
    expect(
      formatPathWithinWorkspace(
        `${WORKTREE}/apps/web/src/components/chat/MessagesTimeline.tsx`,
        WORKTREE,
      ),
    ).toBe("apps/web/src/components/chat/MessagesTimeline.tsx");
  });

  it("leaves an already-relative path alone", () => {
    expect(formatPathWithinWorkspace("apps/web/src/session-logic.ts", WORKTREE)).toBe(
      "apps/web/src/session-logic.ts",
    );
  });

  // The agent often reports paths already prefixed with the worktree directory
  // name; that prefix is the thing being removed, so it must not survive.
  it("drops a workspace label the path already carries", () => {
    expect(formatPathWithinWorkspace("t3code-139f72d1/apps/web/src/main.tsx", WORKTREE)).toBe(
      "apps/web/src/main.tsx",
    );
  });

  it("preserves line and column positions", () => {
    expect(formatPathWithinWorkspace(`${WORKTREE}/apps/web/src/main.tsx:501:9`, WORKTREE)).toBe(
      "apps/web/src/main.tsx:501:9",
    );
  });

  it("handles Windows separators and drive paths", () => {
    expect(
      formatPathWithinWorkspace(
        "C:\\Users\\mike\\dev-stuff\\t3code\\apps\\web\\src\\main.tsx",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("apps/web/src/main.tsx");
  });

  // Trimming here would present another project's file as one of ours.
  it("keeps a path outside the workspace absolute", () => {
    expect(formatPathWithinWorkspace("/etc/hosts", WORKTREE)).toBe("/etc/hosts");
  });

  it("falls back to the workspace name for the workspace root itself", () => {
    expect(formatPathWithinWorkspace(WORKTREE, WORKTREE)).toBe("t3code-139f72d1");
  });

  it("passes the path through when there is no workspace", () => {
    expect(formatPathWithinWorkspace("apps/web/src/main.tsx", undefined)).toBe(
      "apps/web/src/main.tsx",
    );
  });
});
