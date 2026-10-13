import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import { makeThreadFixture } from "./test-fixtures";
import {
  formatOrphanedWorktreeRemovalMessage,
  formatWorktreePathForDisplay,
  getWorktreesOrphanedByDeletion,
} from "./worktreeCleanup";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("getWorktreesOrphanedByDeletion", () => {
  const featureA = "/tmp/repo/worktrees/feature-a";
  const featureB = "/tmp/repo/worktrees/feature-b";
  const threads = [
    makeThread({ id: ThreadId.make("thread-1"), worktreePath: featureA }),
    makeThread({ id: ThreadId.make("thread-2"), worktreePath: featureA }),
    makeThread({ id: ThreadId.make("thread-3"), worktreePath: featureB }),
    makeThread({ id: ThreadId.make("thread-4"), worktreePath: null }),
  ];
  const deleting = (...ids: string[]) => new Set(ids.map((id) => ThreadId.make(id)));

  it("keeps a worktree another thread still links to", () => {
    expect([...getWorktreesOrphanedByDeletion(threads, deleting("thread-1")).keys()]).toEqual([]);
  });

  it("orphans a shared worktree once every thread holding it is in the batch", () => {
    const orphaned = getWorktreesOrphanedByDeletion(
      threads,
      deleting("thread-1", "thread-2", "thread-3", "thread-4"),
    );
    expect([...orphaned]).toEqual([
      [featureA, [ThreadId.make("thread-1"), ThreadId.make("thread-2")]],
      [featureB, [ThreadId.make("thread-3")]],
    ]);
  });

  it("ignores deleted threads without a worktree and unknown ids", () => {
    expect([...getWorktreesOrphanedByDeletion(threads, deleting("thread-4", "missing"))]).toEqual(
      [],
    );
  });
});

describe("formatOrphanedWorktreeRemovalMessage", () => {
  it("asks about a single worktree in the singular", () => {
    expect(
      formatOrphanedWorktreeRemovalMessage({
        threadCount: 1,
        worktreePaths: ["/tmp/repo/worktrees/feature-a"],
      }),
    ).toBe(
      "This thread is the only one linked to this worktree:\nfeature-a\n\nDelete the worktree too?",
    );
  });

  it("lists at most five worktrees for a batch", () => {
    const worktreePaths = Array.from({ length: 7 }, (_, index) => `/tmp/wt/feature-${index}`);
    expect(formatOrphanedWorktreeRemovalMessage({ threadCount: 8, worktreePaths })).toBe(
      [
        "These threads are the only ones linked to 7 worktrees:",
        "feature-0",
        "feature-1",
        "feature-2",
        "feature-3",
        "feature-4",
        "and 2 more",
        "",
        "Delete the worktrees too?",
      ].join("\n"),
    );
  });
});

describe("formatWorktreePathForDisplay", () => {
  it("shows only the last path segment for unix-like paths", () => {
    const result = formatWorktreePathForDisplay(
      "/Users/julius/.t3/worktrees/t3code-mvp/t3code-4e609bb8",
    );
    expect(result).toBe("t3code-4e609bb8");
  });

  it("normalizes windows separators before selecting the final segment", () => {
    const result = formatWorktreePathForDisplay(
      "C:\\Users\\julius\\.t3\\worktrees\\t3code-mvp\\t3code-4e609bb8",
    );
    expect(result).toBe("t3code-4e609bb8");
  });

  it("uses the final segment even when outside ~/.t3/worktrees", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree");
    expect(result).toBe("my-worktree");
  });

  it("ignores trailing slashes", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree/");
    expect(result).toBe("my-worktree");
  });
});
