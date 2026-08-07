import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  VcsCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitRunStackedActionResult,
  GitRunStackedActionInput,
  GitResolvePullRequestResult,
  VcsStatusLocalResult,
} from "./git.ts";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);
const decodeStatusLocalResult = Schema.decodeUnknownSync(VcsStatusLocalResult);

const statusLocalResult = (files: ReadonlyArray<unknown>) => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/per-file-status",
  hasWorkingTreeChanges: files.length > 0,
  workingTree: { files, insertions: 1, deletions: 0 },
});

describe("VcsCreateWorktreeInput", () => {
  it("accepts omitted newRefName for existing-refName worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newRefName).toBeUndefined();
    expect(parsed.refName).toBe("feature/existing");
  });

  it("accepts baseRefName metadata for a new worktree ref", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "0123456789abcdef",
      newRefName: "feature/new",
      baseRefName: "origin/main",
      path: "/tmp/worktree",
    });

    expect(parsed.baseRefName).toBe("origin/main");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
  });
});

describe("VcsStatusLocalResult working-tree files", () => {
  // The whole point of the per-file status fields being optional: a client on
  // this contract still talks to a server that predates them, and every one of
  // them is absent in that payload.
  it("decodes a file from a server that reports no per-file status", () => {
    const parsed = decodeStatusLocalResult(
      statusLocalResult([{ path: "src/legacy.ts", insertions: 1, deletions: 0 }]),
    );

    const file = parsed.workingTree.files[0];
    expect(file?.path).toBe("src/legacy.ts");
    expect(file?.changeKind).toBeUndefined();
    expect(file?.stagedChangeKind).toBeUndefined();
    expect(file?.unstagedChangeKind).toBeUndefined();
    expect(file?.originalPath).toBeUndefined();
  });

  it("carries the change kind and both sides of the index separately", () => {
    const parsed = decodeStatusLocalResult(
      statusLocalResult([
        {
          path: "src/staged-then-edited.ts",
          insertions: 2,
          deletions: 0,
          changeKind: "modified",
          stagedChangeKind: "modified",
          unstagedChangeKind: "modified",
        },
      ]),
    );

    const file = parsed.workingTree.files[0];
    // Staged-ness is the presence of the index-side kind, so a file that was
    // staged and then edited again reports both.
    expect(file?.stagedChangeKind).toBe("modified");
    expect(file?.unstagedChangeKind).toBe("modified");
  });

  it("carries where a rename came from", () => {
    const parsed = decodeStatusLocalResult(
      statusLocalResult([
        {
          path: "src/renamed-to.ts",
          insertions: 1,
          deletions: 0,
          changeKind: "renamed",
          stagedChangeKind: "renamed",
          originalPath: "src/renamed-from.ts",
        },
      ]),
    );

    const file = parsed.workingTree.files[0];
    expect(file?.changeKind).toBe("renamed");
    expect(file?.originalPath).toBe("src/renamed-from.ts");
  });

  it("distinguishes an untracked file from a scored one with no lines", () => {
    const parsed = decodeStatusLocalResult(
      statusLocalResult([
        {
          path: "src/untracked.ts",
          insertions: 0,
          deletions: 0,
          changeKind: "untracked",
          unstagedChangeKind: "untracked",
        },
        { path: "assets/icon.png", insertions: 0, deletions: 0, changeKind: "modified" },
      ]),
    );

    // Both are 0/0 to numstat; only the change kind tells them apart.
    expect(parsed.workingTree.files.map((file) => file.changeKind)).toEqual([
      "untracked",
      "modified",
    ]);
  });

  it("rejects a change kind git never reports", () => {
    expect(() =>
      decodeStatusLocalResult(
        statusLocalResult([
          { path: "src/a.ts", insertions: 0, deletions: 0, changeKind: "staged" },
        ]),
      ),
    ).toThrow();
  });
});

describe("GitRunStackedActionInput", () => {
  it("accepts explicit stacked actions and requires a client-provided actionId", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "create_pr",
    });

    expect(parsed.actionId).toBe("action-1");
    expect(parsed.action).toBe("create_pr");
  });
});

describe("GitRunStackedActionResult", () => {
  it("decodes a server-authored completion toast", () => {
    const parsed = decodeRunStackedActionResult({
      action: "commit_push",
      branch: {
        status: "created",
        name: "feature/server-owned-toast",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: move toast state into git manager",
      },
      push: {
        status: "pushed",
        branch: "feature/server-owned-toast",
        upstreamBranch: "origin/feature/server-owned-toast",
      },
      pr: {
        status: "skipped_not_requested",
      },
      toast: {
        title: "Pushed 89abcde to origin/feature/server-owned-toast",
        description: "feat: move toast state into git manager",
        cta: {
          kind: "run_action",
          label: "Create PR",
          action: {
            kind: "create_pr",
          },
        },
      },
    });

    expect(parsed.toast.cta.kind).toBe("run_action");
    if (parsed.toast.cta.kind === "run_action") {
      expect(parsed.toast.cta.action.kind).toBe("create_pr");
    }
  });
});
