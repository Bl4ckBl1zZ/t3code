import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type Project,
  type VcsRef,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as WorktreeInventoryService from "./WorktreeInventoryService.ts";
import * as WorktreeOperationCoordinator from "./WorktreeOperationCoordinator.ts";
import { purgeWorktree } from "./WorktreeRetentionExecutor.ts";
import {
  evaluateWorktreeRetentionCandidate,
  worktreeRetentionDeadlineMs,
  type WorktreeRetentionCandidate,
  type WorktreeRetentionEvaluation,
  type WorktreeRetentionPullRequestState,
  type WorktreeRetentionRule,
  type WorktreeRetentionSafetyState,
} from "./WorktreeRetention.ts";
import * as WorktreeRegistry from "./WorktreeRegistry.ts";

/**
 * Floor on how often the loop may wake. Deletion is a housekeeping action
 * measured in hours, so a few seconds of lateness is invisible, while the floor
 * keeps a cluster of near-simultaneous deadlines to one scan every half minute
 * instead of a spin.
 */
const MIN_WAKE_MS = 30_000;

/**
 * How long to sleep before the next scan: until the earliest worktree that is
 * actually due, rather than a fixed cadence that deletes everything on the same
 * tick.
 *
 * Only deadlines still ahead of us count. An entry already past its due time
 * that the scan just declined to delete — a dirty worktree, a live terminal —
 * would otherwise drag every wake down to the floor and spin on a worktree it is
 * never going to touch; those wait for the interval like anything else whose
 * state is unresolved.
 *
 * The interval stays the upper bound because two things cannot be scheduled:
 * `deleteOnPullRequestMerge` has no knowable due time, and reconciliation has to
 * sweep for worktrees that changed outside T3 regardless. It also bounds how long
 * a shortened threshold waits to take effect, which is what the interval already
 * did before deadlines existed.
 */
export const nextWakeDelayMs = (input: {
  readonly entries: ReadonlyArray<WorktreeRegistry.WorktreeRegistryEntry>;
  readonly settings: typeof DEFAULT_SERVER_SETTINGS.worktreeRetention;
  readonly nowMs: number;
}): number => {
  const intervalMs = Duration.toMillis(input.settings.scanInterval);
  let earliestMs: number | null = null;
  for (const entry of input.entries) {
    if (entry.state !== "present") continue;
    const dueAtMs = worktreeRetentionDeadlineMs({ settings: input.settings, candidate: entry });
    if (dueAtMs === null || dueAtMs <= input.nowMs) continue;
    if (earliestMs === null || dueAtMs < earliestMs) earliestMs = dueAtMs;
  }
  if (earliestMs === null) return intervalMs;
  return Math.min(Math.max(earliestMs - input.nowMs, MIN_WAKE_MS), intervalMs);
};

export interface WorktreeRetentionReportItem {
  readonly path: string;
  readonly matchedRules: ReadonlyArray<WorktreeRetentionRule>;
}

export interface WorktreeRetentionSkippedItem {
  readonly path: string;
  readonly reasons: ReadonlyArray<string>;
}

export interface WorktreeRetentionScanReport {
  readonly mode: "off" | "report" | "delete";
  readonly scanned: number;
  readonly reported: ReadonlyArray<WorktreeRetentionReportItem>;
  readonly deleted: ReadonlyArray<WorktreeRetentionReportItem>;
  readonly skipped: ReadonlyArray<WorktreeRetentionSkippedItem>;
}

interface ShellOwner {
  readonly threadId: string;
  readonly projectId: string;
  readonly updatedAtMs: number;
  readonly backgroundProcessCount: number;
}

interface OwnerContext {
  readonly available: boolean;
  readonly ownersByPath: ReadonlyMap<string, ReadonlyArray<ShellOwner>>;
  readonly unresolvedPaths: ReadonlySet<string>;
  readonly scheduledTaskThreadIds: ReadonlySet<string> | null;
  readonly hasUnboundScheduledRun: boolean;
}

interface RepositoryRefs {
  readonly isRepo: boolean;
  readonly refs: ReadonlyArray<VcsRef>;
}

interface ProjectRoots {
  readonly paths: ReadonlySet<string>;
  readonly hasUnknownPath: boolean;
  readonly projects: ReadonlyArray<Project>;
}

const emptyReport = (mode: WorktreeRetentionScanReport["mode"]): WorktreeRetentionScanReport => ({
  mode,
  scanned: 0,
  reported: [],
  deleted: [],
  skipped: [],
});

const isActiveRunStatus = (status: string): boolean =>
  status === "preparing" ||
  status === "queued" ||
  status === "starting" ||
  status === "running" ||
  status === "waiting";

const isLiveProviderSessionStatus = (status: string): boolean =>
  status !== "stopped" && status !== "error";

const addOwner = (
  ownersByPath: Map<string, Array<ShellOwner>>,
  path: string,
  owner: ShellOwner,
) => {
  const owners = ownersByPath.get(path) ?? [];
  if (!owners.some((candidate) => candidate.threadId === owner.threadId)) {
    owners.push(owner);
  }
  ownersByPath.set(path, owners);
};

export class WorktreeRetentionService extends Context.Service<
  WorktreeRetentionService,
  {
    readonly scanOnce: Effect.Effect<WorktreeRetentionScanReport>;
    readonly start: Effect.Effect<void>;
  }
>()("t3/worktree/WorktreeRetentionService") {}

const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* WorktreeRegistry.WorktreeRegistry;
  const inventory = yield* Effect.serviceOption(WorktreeInventoryService.WorktreeInventoryService);
  const coordinator = yield* Effect.serviceOption(
    WorktreeOperationCoordinator.WorktreeOperationCoordinator,
  );
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const gitManager = yield* Effect.serviceOption(GitManager.GitManager);
  const terminalManager = yield* TerminalManager.TerminalManager;
  const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const readSettings = serverSettings.getSettings.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("worktree retention could not read settings; using safe defaults", {
        cause,
      }).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
    ),
  );

  // realPath is intentionally required for the boundary check. A lexical path
  // alone cannot distinguish a worktree that escapes through a symlink.
  const canonicalPath = (value: string) =>
    fileSystem.realPath(path.resolve(value)).pipe(
      Effect.map((resolved) => path.normalize(resolved)),
      Effect.catchCause(() => Effect.succeed<string | null>(null)),
    );

  /**
   * Whether the worktree directory is still on disk, or "unknown" when the
   * filesystem would not say.
   *
   * The authority on whether a worktree is gone. A ref map is not: `git worktree
   * list` names a worktree only while a local branch is checked out in it, so a
   * rebase, a bisect, or a restore that detaches HEAD drops a perfectly live
   * worktree out of it — and a `git worktree list` that fails drops all of them
   * at once.
   */
  const worktreeDirectoryPresent = (value: string): Effect.Effect<boolean | "unknown"> =>
    fileSystem
      .exists(path.resolve(value))
      .pipe(Effect.catchCause(() => Effect.succeed<boolean | "unknown">("unknown")));

  const listRegistryEntries = () =>
    Option.isSome(inventory) ? inventory.value.listAll() : registry.listAll();
  const getRegistryEntry = (input: WorktreeRegistry.WorktreeRegistryLookup) =>
    Option.isSome(inventory) ? inventory.value.get(input) : registry.get(input);
  const registerRegistryEntry = (input: WorktreeRegistry.WorktreeRegistration) =>
    Option.isSome(inventory) ? inventory.value.register(input) : registry.register(input);
  const markRegistryEntryRemoved = (input: WorktreeRegistry.WorktreeRemoval) =>
    Option.isSome(inventory) ? inventory.value.markRemoved(input) : registry.markRemoved(input);
  const releaseRegistryRemovalClaim = (input: WorktreeRegistry.WorktreeRemovalClaimRelease) =>
    Option.isSome(inventory) ? inventory.value.releaseRemovalClaim(input) : Effect.void;

  const REMOVAL_CLAIM_LEASE_MS = 15 * 60_000;

  const pathWithin = (
    root: string | null,
    candidate: string | null,
  ): WorktreeRetentionSafetyState => {
    if (root === null || candidate === null) return "unknown";
    const relative = path.relative(root, candidate);
    return relative === "" ||
      relative === "." ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
      ? false
      : true;
  };

  const readOwnerContext = Effect.fn("WorktreeRetention.readOwnerContext")(function* () {
    const snapshot = yield* threads.getShellSnapshot().pipe(
      Effect.map(Option.some),
      Effect.catchCause(() => Effect.succeed(Option.none())),
    );
    if (Option.isNone(snapshot)) {
      return {
        available: false,
        ownersByPath: new Map<string, Array<ShellOwner>>(),
        unresolvedPaths: new Set<string>(),
        scheduledTaskThreadIds: null,
        hasUnboundScheduledRun: true,
      } satisfies OwnerContext;
    }

    const ownersByPath = new Map<string, Array<ShellOwner>>();
    const unresolvedPaths = new Set<string>();
    const scheduledTaskResult = yield* Effect.result(scheduledTasks.list());
    const scheduledTaskThreadIds = Result.isSuccess(scheduledTaskResult)
      ? new Set(
          scheduledTaskResult.success.tasks
            .filter((task) => task.lastRunStatus === "running" && task.threadId !== null)
            .map((task) => String(task.threadId)),
        )
      : null;
    const hasUnboundScheduledRun =
      Result.isSuccess(scheduledTaskResult) &&
      scheduledTaskResult.success.tasks.some(
        (task) => task.lastRunStatus === "running" && task.threadId === null,
      );
    const shells = [...snapshot.value.threads, ...snapshot.value.archivedThreads];
    for (const shell of shells) {
      if (shell.worktreePath === null) continue;
      const normalized = path.normalize(path.resolve(shell.worktreePath));
      const canonical = yield* canonicalPath(shell.worktreePath);
      if (canonical === null) {
        unresolvedPaths.add(normalized);
        continue;
      }
      addOwner(ownersByPath, canonical, {
        threadId: String(shell.id),
        projectId: String(shell.projectId),
        updatedAtMs: DateTime.toEpochMillis(shell.updatedAt),
        backgroundProcessCount: shell.backgroundProcessCount ?? 0,
      });
    }

    return {
      available: true,
      ownersByPath,
      unresolvedPaths,
      scheduledTaskThreadIds,
      hasUnboundScheduledRun,
    } satisfies OwnerContext;
  });

  const readProjectRoots = Effect.fn("WorktreeRetention.readProjectRoots")(function* () {
    const snapshot = yield* projects.snapshot;
    const paths = new Set<string>();
    let hasUnknownPath = false;
    for (const project of snapshot.projects) {
      const canonical = yield* canonicalPath(project.workspaceRoot);
      if (canonical === null) {
        hasUnknownPath = true;
      } else {
        paths.add(canonical);
      }
    }
    return { paths, hasUnknownPath, projects: snapshot.projects } satisfies ProjectRoots;
  });

  const listRepositoryRefs = Effect.fn("WorktreeRetention.listRepositoryRefs")(function* (
    repositoryRoot: string,
  ) {
    const refs: Array<VcsRef> = [];
    const seenCursors = new Set<number>();
    let cursor: number | undefined;
    while (true) {
      const result = yield* gitWorkflow.listRefs({
        cwd: repositoryRoot,
        refKind: "local",
        refresh: true,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!result.isRepo) return { isRepo: false, refs: [] } satisfies RepositoryRefs;
      refs.push(...result.refs);
      if (result.nextCursor === null) {
        return { isRepo: true, refs } satisfies RepositoryRefs;
      }
      if (seenCursors.has(result.nextCursor)) {
        return yield* Effect.die(new Error("VCS ref pagination repeated a cursor."));
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
  });

  const reconcileRefs = Effect.fn("WorktreeRetention.reconcileRefs")(function* (input: {
    readonly repositoryRoot: string;
    readonly repositoryRefs: RepositoryRefs;
    readonly projectId: string | null;
    readonly ownerContext: OwnerContext;
    readonly nowMs: number;
  }) {
    if (!input.repositoryRefs.isRepo) return;
    const repositoryCanonical = yield* canonicalPath(input.repositoryRoot);
    for (const ref of input.repositoryRefs.refs) {
      if (ref.worktreePath === null) continue;
      const worktreeCanonical = yield* canonicalPath(ref.worktreePath);
      if (worktreeCanonical === null || worktreeCanonical === repositoryCanonical) continue;

      const existing = yield* getRegistryEntry({
        repositoryRoot: input.repositoryRoot,
        worktreePath: ref.worktreePath,
      }).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (value) => value,
          }),
        ),
        Effect.catchCause(() =>
          Effect.succeed<WorktreeRegistry.WorktreeRegistryEntry | null>(null),
        ),
      );
      if (existing !== null && existing.removalClaimedAtMs !== null) {
        const claimAgeMs = input.nowMs - existing.removalClaimedAtMs;
        if (claimAgeMs <= REMOVAL_CLAIM_LEASE_MS) continue;

        const released = yield* Effect.result(
          releaseRegistryRemovalClaim({
            repositoryRoot: existing.repositoryRoot,
            worktreePath: existing.worktreePath,
            generation: existing.generation,
            observedAtMs: input.nowMs,
            reason: "reconcile_stale_claim",
          }),
        );
        if (Result.isFailure(released)) {
          yield* Effect.logWarning("worktree retention could not release a stale removal claim", {
            repositoryRoot: existing.repositoryRoot,
            worktreePath: existing.worktreePath,
            cause: released.failure,
          });
          continue;
        }
      }
      const owner = input.ownerContext.ownersByPath.get(worktreeCanonical)?.[0];
      yield* registerRegistryEntry({
        repositoryRoot: input.repositoryRoot,
        worktreePath: ref.worktreePath,
        projectId: owner?.projectId ?? input.projectId ?? existing?.projectId ?? null,
        threadId: owner?.threadId ?? existing?.threadId ?? null,
        branch: ref.name,
        ownership: existing?.ownership ?? "legacy-discovered",
        // Legacy discovery has no trustworthy creation timestamp. Existing
        // rows retain their original value through this upsert.
        createdAtMs: existing?.createdAtMs ?? null,
        discoveredAtMs: existing?.discoveredAtMs ?? input.nowMs,
        lastActivityAtMs: owner?.updatedAtMs ?? existing?.lastActivityAtMs ?? null,
        observedAtMs: input.nowMs,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("worktree retention could not reconcile a worktree", {
            repositoryRoot: input.repositoryRoot,
            worktreePath: ref.worktreePath,
            cause,
          }),
        ),
      );
    }

    const referencedPaths = new Set<string>();
    for (const ref of input.repositoryRefs.refs) {
      if (ref.worktreePath === null) continue;
      referencedPaths.add(path.normalize(path.resolve(ref.worktreePath)));
      const canonical = yield* canonicalPath(ref.worktreePath);
      if (canonical !== null) referencedPaths.add(canonical);
    }
    const existingEntries = yield* listRegistryEntries().pipe(
      Effect.catchCause(() =>
        Effect.succeed<ReadonlyArray<WorktreeRegistry.WorktreeRegistryEntry>>([]),
      ),
    );
    const repositoryKey = path.normalize(path.resolve(input.repositoryRoot));
    for (const entry of existingEntries) {
      if (
        entry.state !== "present" ||
        path.normalize(path.resolve(entry.repositoryRoot)) !== repositoryKey
      ) {
        continue;
      }
      const entryCanonical = yield* canonicalPath(entry.worktreePath);
      const entryKey = entryCanonical ?? path.normalize(path.resolve(entry.worktreePath));
      // Missing from the ref map is a hint, never the verdict: marking a live
      // worktree `removed` makes the next message on its thread purge the
      // binding and provision a replacement, abandoning an in-progress rebase
      // and every uncommitted and gitignored file in it. Only a filesystem that
      // positively reports the directory gone may do that.
      const presence = referencedPaths.has(entryKey)
        ? (true as const)
        : yield* worktreeDirectoryPresent(entry.worktreePath);
      if (presence === false) {
        yield* markRegistryEntryRemoved({
          repositoryRoot: entry.repositoryRoot,
          worktreePath: entry.worktreePath,
          removedAtMs: input.nowMs,
          reason: "reconcile_missing_ref",
          generation: entry.generation,
        }).pipe(Effect.ignoreCause({ log: true }));
        continue;
      }
      if (presence === "unknown") {
        yield* Effect.logWarning(
          "worktree retention kept a registry row: filesystem state unknown",
          { repositoryRoot: entry.repositoryRoot, worktreePath: entry.worktreePath },
        );
      }
      // Runs for every surviving row, not only the referenced ones. A worktree
      // that is alive but absent from the ref map can still be holding a claim
      // from an interrupted delete, and that claim blocks recovery until it is
      // released.
      if (
        entry.removalClaimedAtMs !== null &&
        input.nowMs - entry.removalClaimedAtMs > REMOVAL_CLAIM_LEASE_MS
      ) {
        yield* releaseRegistryRemovalClaim({
          repositoryRoot: entry.repositoryRoot,
          worktreePath: entry.worktreePath,
          generation: entry.generation,
          observedAtMs: input.nowMs,
          reason: "reconcile_stale_claim",
        }).pipe(Effect.ignoreCause({ log: true }));
      }
    }
  });

  const readInUseState = Effect.fn("WorktreeRetention.readInUseState")(function* (input: {
    readonly entry: WorktreeRegistry.WorktreeRegistryEntry;
    readonly canonicalWorktreePath: string | null;
    readonly ownerContext: OwnerContext;
  }) {
    if (!input.ownerContext.available || input.canonicalWorktreePath === null) {
      return {
        inUse: "unknown" as const,
        sharedOwner: "unknown" as const,
      };
    }

    if (
      input.ownerContext.scheduledTaskThreadIds === null ||
      input.ownerContext.hasUnboundScheduledRun
    ) {
      return {
        inUse: "unknown" as const,
        sharedOwner: "unknown" as const,
      };
    }

    const normalized = path.normalize(path.resolve(input.entry.worktreePath));
    if (input.ownerContext.unresolvedPaths.has(normalized)) {
      return {
        inUse: "unknown" as const,
        sharedOwner: "unknown" as const,
      };
    }

    const owners = input.ownerContext.ownersByPath.get(input.canonicalWorktreePath) ?? [];
    const ownerIds = new Set(owners.map((owner) => owner.threadId));
    if (input.entry.threadId !== null) ownerIds.add(input.entry.threadId);

    if (ownerIds.size > 1) {
      return {
        inUse: true,
        sharedOwner: true,
      } satisfies Pick<WorktreeRetentionCandidate["safety"], "inUse" | "sharedOwner">;
    }

    let inUse = owners.some((owner) => owner.backgroundProcessCount > 0);
    for (const ownerId of ownerIds) {
      const projection = yield* threads
        .getThreadProjection(ThreadId.make(ownerId))
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (projection === null) {
        return {
          inUse: "unknown" as const,
          sharedOwner: false,
        };
      }
      inUse ||= projection.runs.some((run) => isActiveRunStatus(run.status));
      inUse ||= projection.providerSessions.some((session) =>
        isLiveProviderSessionStatus(session.status),
      );
      inUse ||= projection.runtimeRequests.some((request) => request.status === "pending");
      inUse ||= input.ownerContext.scheduledTaskThreadIds.has(ownerId);

      const terminalActive = yield* terminalManager
        .hasActiveSessionForThread(ownerId)
        .pipe(Effect.catchCause(() => Effect.succeed<boolean | null>(null)));
      if (terminalActive === null) {
        return {
          inUse: "unknown" as const,
          sharedOwner: false,
        };
      }
      inUse ||= terminalActive;
    }

    return {
      inUse,
      sharedOwner: false,
    } satisfies Pick<WorktreeRetentionCandidate["safety"], "inUse" | "sharedOwner">;
  });

  const readGitWorktreeState = Effect.fn("WorktreeRetention.readGitWorktreeState")(
    function* (input: {
      readonly entry: WorktreeRegistry.WorktreeRegistryEntry;
      readonly canonicalWorktreePath: string | null;
      readonly repositoryRefs: RepositoryRefs | null;
    }): Effect.fn.Return<WorktreeRetentionSafetyState, never> {
      if (input.repositoryRefs === null || input.canonicalWorktreePath === null) return "unknown";
      if (!input.repositoryRefs.isRepo) return false;

      let unknownRefPath = false;
      for (const ref of input.repositoryRefs.refs) {
        if (ref.worktreePath === null) continue;
        const canonical = yield* canonicalPath(ref.worktreePath);
        if (canonical === null) {
          unknownRefPath = true;
        } else if (canonical === input.canonicalWorktreePath) {
          return true;
        }
      }
      return unknownRefPath ? "unknown" : false;
    },
  );

  const readCandidate = Effect.fn("WorktreeRetention.readCandidate")(function* (input: {
    readonly entry: WorktreeRegistry.WorktreeRegistryEntry;
    readonly repositoryRefs: RepositoryRefs | null;
    readonly ownerContext: OwnerContext;
    readonly projectRoots: ProjectRoots;
  }) {
    const canonicalWorktreePath = yield* canonicalPath(input.entry.worktreePath);
    const managedRoot = yield* canonicalPath(serverConfig.worktreesDir);
    const localStatus = yield* gitWorkflow
      .localStatus({ cwd: input.entry.worktreePath })
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    const inUse = yield* readInUseState({
      entry: input.entry,
      canonicalWorktreePath,
      ownerContext: input.ownerContext,
    });
    const projectRoot =
      canonicalWorktreePath === null || input.projectRoots.hasUnknownPath
        ? ("unknown" as const)
        : input.projectRoots.paths.has(canonicalWorktreePath);

    return {
      worktreePath: input.entry.worktreePath,
      createdAtMs: input.entry.createdAtMs,
      lastActivityAtMs: input.entry.lastActivityAtMs,
      // PR state is deliberately unknown until local safety and threshold
      // checks make the provider lookup necessary.
      pullRequestState: "unknown" as const,
      safety: {
        managed: input.entry.ownership === "t3-created",
        pathWithinManagedRoot: pathWithin(managedRoot, canonicalWorktreePath),
        gitWorktreePresent: yield* readGitWorktreeState({
          entry: input.entry,
          canonicalWorktreePath,
          repositoryRefs: input.repositoryRefs,
        }),
        projectRoot,
        gitClean:
          localStatus === null
            ? ("unknown" as const)
            : localStatus.isRepo
              ? !localStatus.hasWorkingTreeChanges
              : false,
        inUse: inUse.inUse,
        sharedOwner: inUse.sharedOwner,
      },
    } satisfies WorktreeRetentionCandidate;
  });

  const readPullRequestState = (entry: WorktreeRegistry.WorktreeRegistryEntry) =>
    entry.branch === null
      ? Effect.succeed<WorktreeRetentionPullRequestState>("unknown")
      : Option.isSome(gitManager)
        ? gitManager.value
            .findFreshPullRequestState({ cwd: entry.repositoryRoot, branch: entry.branch })
            .pipe(
              Effect.map((state) => state satisfies WorktreeRetentionPullRequestState),
              Effect.catchCause(() => Effect.succeed<WorktreeRetentionPullRequestState>("unknown")),
            )
        : Effect.succeed<WorktreeRetentionPullRequestState>("unknown");

  const evaluateEntry = Effect.fn("WorktreeRetention.evaluateEntry")(function* (input: {
    readonly entry: WorktreeRegistry.WorktreeRegistryEntry;
    readonly settings: typeof DEFAULT_SERVER_SETTINGS.worktreeRetention;
    readonly nowMs: number;
    readonly repositoryRefs: RepositoryRefs | null;
    readonly ownerContext: OwnerContext;
    readonly projectRoots: ProjectRoots;
  }): Effect.fn.Return<
    {
      readonly evaluation: WorktreeRetentionEvaluation;
      readonly candidate: WorktreeRetentionCandidate;
    },
    never
  > {
    let candidate: WorktreeRetentionCandidate = yield* readCandidate(input);
    let evaluation = evaluateWorktreeRetentionCandidate({
      nowMs: input.nowMs,
      settings: input.settings,
      candidate,
    });
    if (!evaluation.eligible && evaluation.reasons.includes("pr_unknown")) {
      candidate = {
        ...candidate,
        pullRequestState: yield* readPullRequestState(input.entry),
      };
      evaluation = evaluateWorktreeRetentionCandidate({
        nowMs: input.nowMs,
        settings: input.settings,
        candidate,
      });
    }
    return { candidate, evaluation };
  });

  const dispatchPurged = (entry: WorktreeRegistry.WorktreeRegistryEntry, nowMs: number) =>
    entry.threadId === null
      ? Effect.succeed(true)
      : threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(
              `worktree-retention:purge:${encodeURIComponent(entry.repositoryRoot)}:${encodeURIComponent(entry.worktreePath)}:${nowMs}`,
            ),
            threadId: ThreadId.make(entry.threadId),
            // No `branch` on purpose. The reducer applies whatever is sent, and
            // the registry's copy is a snapshot from the last reconcile: a
            // branch renamed since then would be written back stale, and a null
            // would clear the thread's branch outright. Either one makes the
            // recovery this purge exists to enable fail `branch-unavailable`
            // forever. Purging is about the worktree; the branch is not ours.
            worktreePath: null,
            worktreeStatus: "purged",
            expectedWorktreePath: entry.worktreePath,
          })
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "worktree retention removed a worktree but could not update its thread",
                {
                  worktreePath: entry.worktreePath,
                  threadId: entry.threadId,
                  cause,
                },
              ).pipe(Effect.as(false)),
            ),
          );

  const scanOnce = Effect.gen(function* () {
    const settings = yield* readSettings;
    const mode = settings.worktreeRetention.mode;

    const nowMs = yield* Clock.currentTimeMillis;
    const storedEntries = yield* listRegistryEntries().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("worktree retention could not read its registry", { cause }).pipe(
          Effect.as<ReadonlyArray<WorktreeRegistry.WorktreeRegistryEntry> | null>(null),
        ),
      ),
    );
    if (storedEntries === null) {
      return {
        ...emptyReport(mode),
        skipped: [{ path: "<registry>", reasons: ["registry_unavailable"] }],
      } satisfies WorktreeRetentionScanReport;
    }

    const projectSnapshot = yield* readProjectRoots().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("worktree retention could not read projects", { cause }).pipe(
          Effect.as<ProjectRoots | null>(null),
        ),
      ),
    );
    if (projectSnapshot === null) {
      return {
        ...emptyReport(mode),
        skipped: [{ path: "<projects>", reasons: ["projects_unavailable"] }],
      } satisfies WorktreeRetentionScanReport;
    }

    const ownerContext = yield* readOwnerContext();
    const projectIdByRepository = new Map<string, string>();
    for (const project of projectSnapshot.projects) {
      projectIdByRepository.set(project.workspaceRoot, String(project.id));
    }

    const repositoryRoots = new Set([
      ...projectSnapshot.projects.map((project) => project.workspaceRoot),
      ...storedEntries.map((storedEntry) => storedEntry.repositoryRoot),
    ]);
    const refsByRepository = new Map<string, RepositoryRefs | null>();
    for (const repositoryRoot of repositoryRoots) {
      refsByRepository.set(
        repositoryRoot,
        yield* listRepositoryRefs(repositoryRoot).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("worktree retention could not inspect repository refs", {
              repositoryRoot,
              cause,
            }).pipe(Effect.as<RepositoryRefs | null>(null)),
          ),
        ),
      );
    }

    for (const [repositoryRoot, repositoryRefs] of refsByRepository) {
      if (repositoryRefs === null) continue;
      yield* reconcileRefs({
        repositoryRoot,
        repositoryRefs,
        projectId: projectIdByRepository.get(repositoryRoot) ?? null,
        ownerContext,
        nowMs,
      });
    }

    // Reconciliation is needed even when policy evaluation is disabled: an
    // interrupted delete must not leave recovery blocked forever.
    if (mode === "off") return emptyReport(mode);

    const entries = yield* listRegistryEntries().pipe(
      Effect.catchCause(() => Effect.succeed(storedEntries)),
    );
    const reported: Array<WorktreeRetentionReportItem> = [];
    const deleted: Array<WorktreeRetentionReportItem> = [];
    const skipped: Array<WorktreeRetentionSkippedItem> = [];

    for (const entry of entries.filter((candidate) => candidate.state === "present")) {
      const evaluated = yield* evaluateEntry({
        entry,
        settings: settings.worktreeRetention,
        nowMs,
        repositoryRefs: refsByRepository.get(entry.repositoryRoot) ?? null,
        ownerContext,
        projectRoots: projectSnapshot,
      });
      if (!evaluated.evaluation.eligible) {
        skipped.push({ path: entry.worktreePath, reasons: evaluated.evaluation.reasons });
        continue;
      }

      if (mode === "report") {
        reported.push({
          path: entry.worktreePath,
          matchedRules: evaluated.evaluation.matchedRules,
        });
        continue;
      }

      const purge = Effect.gen(function* () {
        // A scan can take long enough for a terminal, run, or PR to change. Run
        // all safety checks again immediately before claiming the path.
        const rechecked = yield* evaluateEntry({
          entry,
          settings: settings.worktreeRetention,
          nowMs: yield* Clock.currentTimeMillis,
          repositoryRefs: yield* listRepositoryRefs(entry.repositoryRoot).pipe(
            Effect.catchCause(() => Effect.succeed<RepositoryRefs | null>(null)),
          ),
          ownerContext: yield* readOwnerContext(),
          projectRoots: yield* readProjectRoots().pipe(
            Effect.catchCause(() => Effect.succeed(projectSnapshot)),
          ),
        });
        if (!rechecked.evaluation.eligible) {
          return {
            status: "skipped" as const,
            reasons: rechecked.evaluation.reasons,
          };
        }
        return yield* purgeWorktree({
          entry,
          matchedRules: rechecked.evaluation.matchedRules,
          operations: {
            claimRemoval: Option.isSome(inventory) ? inventory.value.claimRemoval : null,
            releaseRemovalClaim: Option.isSome(inventory)
              ? inventory.value.releaseRemovalClaim
              : null,
            finalizeRemoval: Option.isSome(inventory) ? inventory.value.finalizeRemoval : null,
            markRemoved: markRegistryEntryRemoved,
            removeWorktree: () =>
              gitWorkflow.removeWorktree({ cwd: entry.repositoryRoot, path: entry.worktreePath }),
            dispatchPurged: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((purgeAtMs) => dispatchPurged(entry, purgeAtMs)),
              ),
            nowMs: Clock.currentTimeMillis,
          },
        });
      });
      const pathLockedPurge = Option.isSome(coordinator)
        ? coordinator.value.withPathLock(entry.repositoryRoot, entry.worktreePath, purge)
        : purge;
      const outcome = yield* Option.isSome(coordinator)
        ? coordinator.value.withRepositoryLock(entry.repositoryRoot, pathLockedPurge)
        : pathLockedPurge;
      if (outcome.status === "skipped") {
        skipped.push({ path: entry.worktreePath, reasons: outcome.reasons });
        continue;
      }
      if (outcome.registryFailure !== null) {
        skipped.push({ path: entry.worktreePath, reasons: [outcome.registryFailure] });
      }
      deleted.push({
        path: entry.worktreePath,
        matchedRules: outcome.matchedRules,
      });
    }

    return {
      mode,
      scanned: entries.filter((candidate) => candidate.state === "present").length,
      reported,
      deleted,
      skipped,
    } satisfies WorktreeRetentionScanReport;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("worktree retention scan failed closed", { cause }).pipe(
        Effect.as({
          ...emptyReport("off"),
          skipped: [{ path: "<scan>", reasons: ["scan_failed"] }],
        } satisfies WorktreeRetentionScanReport),
      ),
    ),
  );

  const start = Effect.forever(
    Effect.gen(function* () {
      const report = yield* scanOnce;
      if (report.reported.length > 0 || report.deleted.length > 0 || report.skipped.length > 0) {
        yield* Effect.logInfo("worktree retention scan completed", report);
      }
      // Read after the scan, not before: the scan is what moved the registry,
      // and the sleep is sized from where it left things.
      const settings = yield* readSettings;
      const entries = yield* listRegistryEntries().pipe(
        Effect.catchCause(() =>
          Effect.succeed<ReadonlyArray<WorktreeRegistry.WorktreeRegistryEntry>>([]),
        ),
      );
      const delayMs = nextWakeDelayMs({
        entries,
        settings: settings.worktreeRetention,
        nowMs: yield* Clock.currentTimeMillis,
      });
      yield* Effect.sleep(Duration.millis(delayMs));
    }),
  ).pipe(Effect.asVoid);

  return WorktreeRetentionService.of({ scanOnce, start });
});

export const layer: Layer.Layer<
  WorktreeRetentionService,
  never,
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | WorktreeRegistry.WorktreeRegistry
  | ProjectService.ProjectService
  | ThreadManagementService
  | GitWorkflowService.GitWorkflowService
  | ScheduledTasks.ScheduledTaskService
  | TerminalManager.TerminalManager
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effect(WorktreeRetentionService, make);
