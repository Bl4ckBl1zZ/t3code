import { describe, expect, it, vi } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { ProjectId, ServerSettings, ThreadId, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as WorktreeRegistry from "./WorktreeRegistry.ts";
import {
  WorktreeRetentionService,
  layer as worktreeRetentionLayer,
  nextWakeDelayMs,
} from "./WorktreeRetentionService.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const repositoryRoot = "/repo";
const worktreePath = "/server/worktrees/feature";
const projectId = ProjectId.make("project:retention");
const threadId = ThreadId.make("thread:retention");

const project: Project = {
  id: projectId,
  title: "Retention project",
  workspaceRoot: repositoryRoot,
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const entry: WorktreeRegistry.WorktreeRegistryEntry = {
  repositoryRoot,
  worktreePath,
  projectId: String(projectId),
  threadId: String(threadId),
  branch: "feature/retention",
  ownership: "t3-created",
  createdAtMs: -1,
  discoveredAtMs: 0,
  lastActivityAtMs: -1,
  state: "present",
  lastReason: null,
  updatedAtMs: 1,
  generation: 1,
  removalClaimedAtMs: null,
};

const makeHarness = (input: {
  readonly settings: ReturnType<typeof decodeSettings>;
  readonly entry?: WorktreeRegistry.WorktreeRegistryEntry;
  readonly dirty?: boolean;
  readonly active?: boolean;
  readonly scheduledRun?: boolean;
  readonly missingRef?: boolean;
  /**
   * Whether the worktree directory is still on disk. Consulted only when the
   * entry is absent from the ref map, which is exactly where reconciliation
   * decides whether to mark a row removed. Defaults to gone, matching the case
   * the ref map is usually right about.
   */
  readonly worktreeOnDisk?: boolean;
  readonly statFails?: boolean;
  readonly pullRequestState?: "merged" | "open" | "error";
  readonly dispatchFailure?: boolean;
}) => {
  const currentEntry = input.entry ?? entry;
  const register = vi.fn((_: WorktreeRegistry.WorktreeRegistration) =>
    Effect.succeed(currentEntry),
  );
  const get = vi.fn((_: WorktreeRegistry.WorktreeRegistryLookup) =>
    Effect.succeed(Option.some(currentEntry)),
  );
  const listAll = vi.fn(() => Effect.succeed([currentEntry]));
  const markRemoved = vi.fn((_: WorktreeRegistry.WorktreeRemoval) => Effect.void);
  const releaseRemovalClaim = vi.fn((_: WorktreeRegistry.WorktreeRemovalClaimRelease) =>
    Effect.succeed(true),
  );
  const removeWorktree = vi.fn((_: { readonly cwd: string; readonly path: string }) => Effect.void);
  const dispatch = vi.fn((_: unknown) =>
    input.dispatchFailure
      ? Effect.die("metadata unavailable")
      : Effect.succeed({ sequence: 2, storedEvents: [] }),
  );
  const findFreshPullRequestState = vi.fn(
    (): Effect.Effect<"merged" | "not_merged", never> =>
      input.pullRequestState === "error"
        ? Effect.die("provider unavailable")
        : Effect.succeed(
            input.pullRequestState === "merged" ? ("merged" as const) : ("not_merged" as const),
          ),
  );

  const layer = worktreeRetentionLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed(input.settings),
        }),
        Layer.mock(WorktreeRegistry.WorktreeRegistry)({
          register,
          get,
          listAll,
          markRemoved,
          releaseRemovalClaim,
        }),
        Layer.mock(ProjectService.ProjectService)({
          snapshot: Effect.succeed({
            projects: [project],
            updatedAt: "2026-08-16T00:00:00.000Z",
          }),
        }),
        Layer.mock(ThreadManagementService)({
          getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] } as never),
          getThreadProjection: () =>
            Effect.succeed({
              thread: { worktreePath },
              runs: input.active ? [{ status: "running" }] : [],
              providerSessions: [],
              runtimeRequests: [],
            } as never),
          dispatch,
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          listRefs: () =>
            Effect.succeed({
              refs: input.missingRef
                ? []
                : [
                    {
                      name: currentEntry.branch ?? "feature/retention",
                      current: false,
                      isDefault: false,
                      worktreePath,
                    },
                  ],
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 1,
            }),
          localStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: false,
              refName: currentEntry.branch,
              hasWorkingTreeChanges: input.dirty ?? false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
              branchDiff: null,
            }),
          removeWorktree,
        }),
        Layer.mock(GitManager.GitManager)({ findFreshPullRequestState }),
        Layer.mock(TerminalManager.TerminalManager)({
          hasActiveSessionForThread: () => Effect.succeed(false),
        }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () =>
            Effect.succeed({
              tasks: input.scheduledRun ? [{ lastRunStatus: "running", threadId }] : [],
            } as never),
        }),
        Layer.succeed(ServerConfig.ServerConfig, {
          worktreesDir: "/server/worktrees",
        } as ServerConfig.ServerConfig["Service"]),
        NodeServices.layer,
        Layer.succeed(FileSystem.FileSystem, {
          realPath: (value: string) => Effect.succeed(value),
          exists: (_: string) =>
            input.statFails
              ? Effect.die("filesystem unavailable")
              : Effect.succeed(input.worktreeOnDisk ?? false),
        } as unknown as FileSystem.FileSystem),
      ),
    ),
  );

  return {
    layer,
    register,
    get,
    markRemoved,
    releaseRemovalClaim,
    removeWorktree,
    dispatch,
    findFreshPullRequestState,
  };
};

const runScan = (layer: Layer.Layer<WorktreeRetentionService>) =>
  Effect.gen(function* () {
    const service = yield* WorktreeRetentionService;
    return yield* service.scanOnce;
  }).pipe(Effect.provide(layer));

describe("WorktreeRetentionService", () => {
  it.effect("reports eligible worktrees without mutating Git or thread state", () => {
    const harness = makeHarness({
      settings: decodeSettings({
        worktreeRetention: { mode: "report", maxAge: 1 },
      }),
    });

    return Effect.gen(function* () {
      const report = yield* runScan(harness.layer);

      expect(report.reported).toEqual([{ path: worktreePath, matchedRules: ["maxAge"] }]);
      expect(report.deleted).toEqual([]);
      expect(harness.removeWorktree).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("deletes with the safe Git operation and records a purged thread", () => {
    const harness = makeHarness({
      settings: decodeSettings({
        worktreeRetention: { mode: "delete", maxAge: 1 },
      }),
    });

    return Effect.gen(function* () {
      const report = yield* runScan(harness.layer);

      expect(report.deleted).toEqual([{ path: worktreePath, matchedRules: ["maxAge"] }]);
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: repositoryRoot,
        path: worktreePath,
      });
      expect(harness.removeWorktree.mock.calls[0]?.[0]).not.toHaveProperty("force");
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.metadata.update",
          threadId,
          worktreePath: null,
          worktreeStatus: "purged",
          expectedWorktreePath: worktreePath,
        }),
      );
      // The purge must not carry a branch. The reducer applies whatever is sent,
      // and the registry's copy is a snapshot: writing back a renamed or null
      // branch strands the thread on `branch-unavailable` with no way back.
      expect(harness.dispatch.mock.calls[0]?.[0]).not.toHaveProperty("branch");
      expect(harness.markRemoved).toHaveBeenCalled();
    });
  });

  it.effect("queries fresh pull-request state before deleting a merged worktree", () => {
    const harness = makeHarness({
      settings: decodeSettings({
        worktreeRetention: { mode: "delete", deleteOnPullRequestMerge: true },
      }),
      pullRequestState: "merged",
    });

    return Effect.gen(function* () {
      const report = yield* runScan(harness.layer);

      expect(harness.findFreshPullRequestState).toHaveBeenCalledWith({
        cwd: repositoryRoot,
        branch: entry.branch,
      });
      expect(report.deleted).toEqual([{ path: worktreePath, matchedRules: ["pullRequestMerged"] }]);
    });
  });

  it.effect("retains registry evidence when the purge metadata event cannot be written", () => {
    const harness = makeHarness({
      settings: decodeSettings({
        worktreeRetention: { mode: "delete", maxAge: 1 },
      }),
      dispatchFailure: true,
    });

    return Effect.gen(function* () {
      const report = yield* runScan(harness.layer);

      expect(report.deleted).toEqual([{ path: worktreePath, matchedRules: ["maxAge"] }]);
      expect(harness.markRemoved).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryRoot,
          worktreePath,
          reason: "maxAge,thread_metadata_update_failed",
        }),
      );
    });
  });

  it.effect("fails closed for dirty, active, and unknown PR candidates", () => {
    const dirty = makeHarness({
      settings: decodeSettings({
        worktreeRetention: { mode: "delete", maxAge: 1 },
      }),
      dirty: true,
    });
    const active = makeHarness({
      settings: decodeSettings({
        worktreeRetention: { mode: "delete", maxAge: 1 },
      }),
      active: true,
    });
    const unknownPr = makeHarness({
      settings: decodeSettings({
        worktreeRetention: { mode: "delete", deleteOnPullRequestMerge: true },
      }),
      pullRequestState: "error",
    });

    return Effect.gen(function* () {
      const [dirtyReport, activeReport, unknownPrReport] = yield* Effect.all([
        runScan(dirty.layer),
        runScan(active.layer),
        runScan(unknownPr.layer),
      ]);

      expect(dirtyReport.deleted).toEqual([]);
      expect(activeReport.deleted).toEqual([]);
      expect(unknownPrReport.deleted).toEqual([]);
      expect(dirty.removeWorktree).not.toHaveBeenCalled();
      expect(active.removeWorktree).not.toHaveBeenCalled();
      expect(unknownPr.removeWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("does not purge a worktree owned by a running scheduled task", () => {
    const harness = makeHarness({
      settings: decodeSettings({
        worktreeRetention: { mode: "delete", maxAge: 1 },
      }),
      scheduledRun: true,
    });

    return Effect.gen(function* () {
      const report = yield* runScan(harness.layer);

      expect(report.deleted).toEqual([]);
      expect(report.skipped).toEqual([{ path: worktreePath, reasons: ["active_use"] }]);
      expect(harness.removeWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("reconciles an interrupted removal even when retention is off", () => {
    const harness = makeHarness({
      settings: decodeSettings({}),
      entry: { ...entry, removalClaimedAtMs: 1 },
      missingRef: true,
    });

    return Effect.gen(function* () {
      const report = yield* runScan(harness.layer);

      expect(report).toEqual({
        mode: "off",
        scanned: 0,
        reported: [],
        deleted: [],
        skipped: [],
      });
      expect(harness.markRemoved).toHaveBeenCalledWith({
        repositoryRoot,
        worktreePath,
        removedAtMs: expect.any(Number),
        reason: "reconcile_missing_ref",
        generation: entry.generation,
      });
      expect(harness.removeWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("does not clear an active removal claim while reconciling a present ref", () => {
    const harness = makeHarness({
      settings: decodeSettings({}),
      entry: { ...entry, removalClaimedAtMs: Number.MAX_SAFE_INTEGER },
    });

    return Effect.gen(function* () {
      const report = yield* runScan(harness.layer);

      expect(report).toEqual({
        mode: "off",
        scanned: 0,
        reported: [],
        deleted: [],
        skipped: [],
      });
      expect(harness.register).not.toHaveBeenCalled();
    });
  });
});

describe("nextWakeDelayMs", () => {
  const day = 86_400_000;
  const hour = 3_600_000;
  const scanNowMs = Date.parse("2026-08-16T00:00:00.000Z");
  const deleteAfter = (staleAfterMs: number, scanIntervalMs = 24 * hour) =>
    decodeSettings({
      worktreeRetention: {
        mode: "delete",
        staleAfter: staleAfterMs,
        scanInterval: scanIntervalMs,
      },
    }).worktreeRetention;

  const present = (lastActivityAtMs: number, overrides: Partial<typeof entry> = {}) => ({
    ...entry,
    createdAtMs: null,
    lastActivityAtMs,
    ...overrides,
  });

  it("falls back to the scan interval when nothing has a deadline", () => {
    expect(
      nextWakeDelayMs({
        entries: [present(scanNowMs, { lastActivityAtMs: null })],
        settings: deleteAfter(7 * day),
        nowMs: scanNowMs,
      }),
    ).toBe(24 * hour);
  });

  it("sleeps until the earliest worktree that is actually due", () => {
    expect(
      nextWakeDelayMs({
        entries: [
          present(scanNowMs - 7 * day + 6 * hour),
          present(scanNowMs - 7 * day + 2 * hour),
          present(scanNowMs - 7 * day + 9 * hour),
        ],
        settings: deleteAfter(7 * day),
        nowMs: scanNowMs,
      }),
    ).toBe(2 * hour);
  });

  // The anti-spin property. A worktree past its deadline that the scan just
  // declined to delete — dirty tree, live terminal — must not drag the next wake
  // down to the floor forever; it waits for the interval like anything else.
  it("ignores entries already past their deadline", () => {
    expect(
      nextWakeDelayMs({
        entries: [present(scanNowMs - 30 * day), present(scanNowMs - 7 * day)],
        settings: deleteAfter(7 * day),
        nowMs: scanNowMs,
      }),
    ).toBe(24 * hour);
  });

  it("ignores entries that are no longer present", () => {
    expect(
      nextWakeDelayMs({
        entries: [
          present(scanNowMs - 7 * day + 2 * hour, { state: "removed" }),
          present(scanNowMs - 7 * day + 6 * hour),
        ],
        settings: deleteAfter(7 * day),
        nowMs: scanNowMs,
      }),
    ).toBe(6 * hour);
  });

  it("never wakes more often than the floor or later than the interval", () => {
    expect(
      nextWakeDelayMs({
        entries: [present(scanNowMs - 7 * day + 1_000)],
        settings: deleteAfter(7 * day),
        nowMs: scanNowMs,
      }),
    ).toBe(30_000);

    expect(
      nextWakeDelayMs({
        entries: [present(scanNowMs)],
        settings: deleteAfter(7 * day, 6 * hour),
        nowMs: scanNowMs,
      }),
    ).toBe(6 * hour);
  });
});

describe("WorktreeRetentionService reconciliation", () => {
  // `git worktree list` names a worktree only while a local branch is checked
  // out in it, so an interactive rebase, a bisect, or a restore that detaches
  // HEAD drops a live worktree out of the ref map. Marking that row removed
  // makes the next message purge the thread's binding and provision a
  // replacement, abandoning the rebase and every gitignored file with it.
  it.effect(
    "keeps a registry row for a worktree that is missing from the ref map but on disk",
    () => {
      const harness = makeHarness({
        settings: decodeSettings({}),
        missingRef: true,
        worktreeOnDisk: true,
      });

      return Effect.gen(function* () {
        yield* runScan(harness.layer);
        expect(harness.markRemoved).not.toHaveBeenCalled();
      });
    },
  );

  it.effect("still marks a row removed once the directory is really gone", () => {
    const harness = makeHarness({
      settings: decodeSettings({}),
      missingRef: true,
      worktreeOnDisk: false,
    });

    return Effect.gen(function* () {
      yield* runScan(harness.layer);
      expect(harness.markRemoved).toHaveBeenCalledWith({
        repositoryRoot,
        worktreePath,
        removedAtMs: expect.any(Number),
        reason: "reconcile_missing_ref",
        generation: entry.generation,
      });
    });
  });

  // Fail closed, like every other unknown in this feature.
  it.effect("keeps a registry row when the filesystem will not answer", () => {
    const harness = makeHarness({
      settings: decodeSettings({}),
      missingRef: true,
      statFails: true,
    });

    return Effect.gen(function* () {
      yield* runScan(harness.layer);
      expect(harness.markRemoved).not.toHaveBeenCalled();
    });
  });
});
