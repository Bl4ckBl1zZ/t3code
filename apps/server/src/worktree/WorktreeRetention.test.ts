import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ServerSettings } from "@t3tools/contracts";
import {
  evaluateWorktreeRetentionCandidate,
  worktreeRetentionDeadlineMs,
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

describe("worktreeRetentionDeadlineMs", () => {
  const day = 86_400_000;

  it("dates the age rule from creation and the stale rule from last activity", () => {
    const createdAtMs = nowMs - 10 * day;
    const lastActivityAtMs = nowMs - 2 * day;

    expect(
      worktreeRetentionDeadlineMs({
        settings: decodeSettings({
          worktreeRetention: { mode: "delete", maxAge: 30 * day },
        }).worktreeRetention,
        candidate: { createdAtMs, lastActivityAtMs },
      }),
    ).toBe(createdAtMs + 30 * day);

    expect(
      worktreeRetentionDeadlineMs({
        settings: decodeSettings({
          worktreeRetention: { mode: "delete", staleAfter: 7 * day },
        }).worktreeRetention,
        candidate: { createdAtMs, lastActivityAtMs },
      }),
    ).toBe(lastActivityAtMs + 7 * day);
  });

  it("takes the earlier of the two rules when both are configured", () => {
    const createdAtMs = nowMs - 25 * day;
    const lastActivityAtMs = nowMs - 6 * day;

    expect(
      worktreeRetentionDeadlineMs({
        settings: decodeSettings({
          worktreeRetention: { mode: "delete", maxAge: 30 * day, staleAfter: 7 * day },
        }).worktreeRetention,
        candidate: { createdAtMs, lastActivityAtMs },
      }),
      // Stale at +1 day beats aged at +5 days.
    ).toBe(lastActivityAtMs + 7 * day);
  });

  // The deadline is what the loop sleeps on, so a rule the evaluator cannot act
  // on must not produce one — otherwise the scan wakes for a worktree it will
  // only ever skip.
  it("has no deadline for a rule whose timestamp is missing", () => {
    const settings = decodeSettings({
      worktreeRetention: { mode: "delete", maxAge: 30 * day, staleAfter: 7 * day },
    }).worktreeRetention;

    expect(
      worktreeRetentionDeadlineMs({
        settings,
        candidate: { createdAtMs: null, lastActivityAtMs: null },
      }),
    ).toBeNull();
    expect(
      worktreeRetentionDeadlineMs({
        settings,
        candidate: { createdAtMs: null, lastActivityAtMs: nowMs },
      }),
    ).toBe(nowMs + 7 * day);
  });

  it("has no deadline for the merge rule, which cannot be scheduled", () => {
    expect(
      worktreeRetentionDeadlineMs({
        settings: decodeSettings({
          worktreeRetention: { mode: "delete", deleteOnPullRequestMerge: true },
        }).worktreeRetention,
        candidate: { createdAtMs: nowMs - 40 * day, lastActivityAtMs: nowMs - 40 * day },
      }),
    ).toBeNull();
  });

  it("has no deadline while retention is off", () => {
    expect(
      worktreeRetentionDeadlineMs({
        settings: decodeSettings({
          worktreeRetention: { mode: "off", maxAge: 30 * day },
        }).worktreeRetention,
        candidate: { createdAtMs: nowMs - 40 * day, lastActivityAtMs: nowMs },
      }),
    ).toBeNull();
  });

  // The loop wakes at the deadline and expects the evaluator to act, so the two
  // have to agree on the boundary rather than land a millisecond apart.
  it("lands exactly where the evaluator starts reporting the candidate", () => {
    const settings = decodeSettings({
      worktreeRetention: { mode: "report", staleAfter: 7 * day },
    }).worktreeRetention;
    const candidate = safeCandidate({ createdAtMs: null, lastActivityAtMs: nowMs });
    const deadline = worktreeRetentionDeadlineMs({ settings, candidate });

    expect(deadline).not.toBeNull();
    expect(
      evaluateWorktreeRetentionCandidate({ nowMs: deadline! - 1, settings, candidate }).eligible,
    ).toBe(false);
    expect(
      evaluateWorktreeRetentionCandidate({ nowMs: deadline!, settings, candidate }).eligible,
    ).toBe(true);
  });
});
