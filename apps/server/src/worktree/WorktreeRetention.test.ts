import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ServerSettings } from "@t3tools/contracts";
import {
  evaluateWorktreeRetentionCandidate,
  type WorktreeRetentionCandidate,
} from "./WorktreeRetention.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const nowMs = Date.parse("2026-08-16T00:00:00.000Z");

const safeCandidate = (
  overrides: Partial<WorktreeRetentionCandidate> = {},
): WorktreeRetentionCandidate => ({
  worktreePath: "/server/worktrees/feature",
  createdAtMs: nowMs - 31 * 86_400_000,
  lastActivityAtMs: nowMs - 8 * 86_400_000,
  pullRequestState: "not_merged",
  safety: {
    managed: true,
    pathWithinManagedRoot: true,
    gitWorktreePresent: true,
    projectRoot: false,
    gitClean: true,
    inUse: false,
    sharedOwner: false,
  },
  ...overrides,
});

describe("evaluateWorktreeRetentionCandidate", () => {
  it("reports a clean managed worktree that exceeds the age threshold", () => {
    const result = evaluateWorktreeRetentionCandidate({
      nowMs,
      settings: decodeSettings({
        worktreeRetention: {
          mode: "report",
          maxAge: 30 * 86_400_000,
        },
      }).worktreeRetention,
      candidate: safeCandidate(),
    });

    expect(result).toEqual({
      eligible: true,
      action: "report",
      matchedRules: ["maxAge"],
    });
  });

  it("deletes a clean managed worktree that has gone stale", () => {
    const result = evaluateWorktreeRetentionCandidate({
      nowMs,
      settings: decodeSettings({
        worktreeRetention: {
          mode: "delete",
          staleAfter: 7 * 86_400_000,
        },
      }).worktreeRetention,
      candidate: safeCandidate({
        createdAtMs: nowMs - 2 * 86_400_000,
        lastActivityAtMs: nowMs - 8 * 86_400_000,
      }),
    });

    expect(result).toEqual({
      eligible: true,
      action: "delete",
      matchedRules: ["staleAfter"],
    });
  });

  it("allows deletion when a fresh PR result confirms the merge", () => {
    const result = evaluateWorktreeRetentionCandidate({
      nowMs,
      settings: decodeSettings({
        worktreeRetention: {
          mode: "delete",
          deleteOnPullRequestMerge: true,
        },
      }).worktreeRetention,
      candidate: safeCandidate({
        createdAtMs: nowMs - 1 * 86_400_000,
        lastActivityAtMs: nowMs - 1 * 86_400_000,
        pullRequestState: "merged",
      }),
    });

    expect(result).toEqual({
      eligible: true,
      action: "delete",
      matchedRules: ["pullRequestMerged"],
    });
  });

  it("blocks deletion of a dirty worktree even when a rule matches", () => {
    const result = evaluateWorktreeRetentionCandidate({
      nowMs,
      settings: decodeSettings({
        worktreeRetention: {
          mode: "delete",
          maxAge: 30 * 86_400_000,
        },
      }).worktreeRetention,
      candidate: safeCandidate({
        safety: {
          ...safeCandidate().safety,
          gitClean: false,
        },
      }),
    });

    expect(result).toEqual({
      eligible: false,
      reasons: ["dirty_worktree"],
    });
  });

  it("fails closed when a merge-only candidate has an unknown PR state", () => {
    const result = evaluateWorktreeRetentionCandidate({
      nowMs,
      settings: decodeSettings({
        worktreeRetention: {
          mode: "delete",
          deleteOnPullRequestMerge: true,
        },
      }).worktreeRetention,
      candidate: safeCandidate({
        pullRequestState: "unknown",
        createdAtMs: nowMs - 1 * 86_400_000,
        lastActivityAtMs: nowMs - 1 * 86_400_000,
      }),
    });

    expect(result).toEqual({
      eligible: false,
      reasons: ["pr_unknown"],
    });
  });

  it("fails closed when a safety check is unknown", () => {
    const result = evaluateWorktreeRetentionCandidate({
      nowMs,
      settings: decodeSettings({
        worktreeRetention: {
          mode: "delete",
          maxAge: 30 * 86_400_000,
        },
      }).worktreeRetention,
      candidate: safeCandidate({
        safety: {
          ...safeCandidate().safety,
          inUse: "unknown",
        },
      }),
    });

    expect(result).toEqual({
      eligible: false,
      reasons: ["active_use_unknown"],
    });
  });

  it("does not adopt legacy-discovered or unmanaged ownership", () => {
    const result = evaluateWorktreeRetentionCandidate({
      nowMs,
      settings: decodeSettings({
        worktreeRetention: {
          mode: "delete",
          staleAfter: 1 * 86_400_000,
        },
      }).worktreeRetention,
      candidate: safeCandidate({
        safety: {
          ...safeCandidate().safety,
          managed: false,
        },
      }),
    });

    expect(result).toEqual({
      eligible: false,
      reasons: ["unmanaged"],
    });
  });

  it("does not produce a deletion action when retention is disabled", () => {
    const result = evaluateWorktreeRetentionCandidate({
      nowMs,
      settings: decodeSettings({}).worktreeRetention,
      candidate: safeCandidate(),
    });

    expect(result).toEqual({
      eligible: false,
      reasons: ["retention_disabled"],
    });
  });
});
