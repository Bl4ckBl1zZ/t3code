import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import { makeThreadFixture } from "./test-fixtures";
import {
  formatOrphanedWorktreeRemovalMessage,
  formatWorktreePathForDisplay,
  getWorktreesOrphanedByDeletion,
  mergeWorktreeOwners,
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
  const one = ThreadId.make("thread-1");
  const two = ThreadId.make("thread-2");
  const three = ThreadId.make("thread-3");

  it("returns the worktree when the only thread linked to it is deleted", () => {
    const threads = [
      makeThread({ id: one, worktreePath: featureA }),
      makeThread({ id: two, worktreePath: featureB }),
      makeThread({ id: three }),
    ];

    expect(getWorktreesOrphanedByDeletion(threads, new Set([one, three]))).toEqual(
      new Map([[featureA, [one]]]),
    );
  });

  it("keeps a worktree another thread still links to", () => {
    const threads = [
      makeThread({ id: one, worktreePath: featureA }),
      makeThread({ id: two, worktreePath: featureA }),
    ];

    expect(getWorktreesOrphanedByDeletion(threads, new Set([one]))).toEqual(new Map());
  });

  it("orphans a shared worktree when every thread linked to it is deleted together", () => {
    const threads = [
      makeThread({ id: one, worktreePath: featureA }),
      makeThread({ id: two, worktreePath: `${featureA} ` }),
      makeThread({ id: three, worktreePath: featureB }),
    ];

    expect(getWorktreesOrphanedByDeletion(threads, new Set([one, two]))).toEqual(
      new Map([[featureA, [one, two]]]),
    );
  });
});

describe("formatOrphanedWorktreeRemovalMessage", () => {
  it("asks about a single thread's worktree", () => {
    expect(
      formatOrphanedWorktreeRemovalMessage({
        threadCount: 1,
        worktreePaths: ["/Users/julius/.t3/worktrees/t3code/t3code-4e609bb8"],
      }),
    ).toBe(
      "This thread is the only one linked to this worktree:\nt3code-4e609bb8\n\nDelete the worktree too?",
    );
  });

  it("asks once for a batch and caps the listed worktrees", () => {
    const worktreePaths = Array.from({ length: 7 }, (_, index) => `/tmp/worktrees/wt-${index}`);

    expect(formatOrphanedWorktreeRemovalMessage({ threadCount: 27, worktreePaths })).toBe(
      [
        "These threads are the only ones linked to 7 worktrees:",
        "wt-0",
        "wt-1",
        "wt-2",
        "wt-3",
        "wt-4",
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

describe("mergeWorktreeOwners", () => {
  const worktreePath = "/Users/julius/.t3/worktrees/t3code/t3code-4e609bb8";

  it("keeps an archived thread from being treated as gone", () => {
    const active = makeThread({ id: ThreadId.make("thread-active"), worktreePath });
    const archived = makeThread({ id: ThreadId.make("thread-archived"), worktreePath });

    // Without the archived thread the active delete looks like the last
    // reference and would take the worktree the archived thread still uses.
    expect(getWorktreesOrphanedByDeletion([active], new Set([active.id])).has(worktreePath)).toBe(
      true,
    );
    expect(
      getWorktreesOrphanedByDeletion(
        mergeWorktreeOwners([active], [archived]),
        new Set([active.id]),
      ).size,
    ).toBe(0);
  });

  it("still reports an orphan when the archived threads use other worktrees", () => {
    const active = makeThread({ id: ThreadId.make("thread-active"), worktreePath });
    const archived = makeThread({
      id: ThreadId.make("thread-archived"),
      worktreePath: "/Users/julius/.t3/worktrees/t3code/t3code-other",
    });

    expect(
      getWorktreesOrphanedByDeletion(
        mergeWorktreeOwners([active], [archived]),
        new Set([active.id]),
      ).has(worktreePath),
    ).toBe(true);
  });

  it("counts a thread present in both stores once", () => {
    const active = makeThread({ id: ThreadId.make("thread-1"), worktreePath });
    const staleArchivedCopy = makeThread({ id: ThreadId.make("thread-1"), worktreePath: null });

    const merged = mergeWorktreeOwners([active], [staleArchivedCopy]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.worktreePath).toBe(worktreePath);
    // The duplicate must not shadow the active copy and make it look shared.
    expect(getWorktreesOrphanedByDeletion(merged, new Set([active.id])).has(worktreePath)).toBe(
      true,
    );
  });
});
