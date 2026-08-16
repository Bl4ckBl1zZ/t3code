import {
  CommandId,
  ProjectId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { OrchestratorV2DispatchResult } from "./Orchestrator.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorktreeInventoryService from "../worktree/WorktreeInventoryService.ts";
import * as WorktreeOperationCoordinator from "../worktree/WorktreeOperationCoordinator.ts";
import * as WorktreeProvisioningService from "../worktree/WorktreeProvisioningService.ts";
import * as WorktreeRegistry from "../worktree/WorktreeRegistry.ts";

export class ThreadManagementWorktreeReprovisionError extends Schema.TaggedErrorClass<ThreadManagementWorktreeReprovisionError>()(
  "ThreadManagementWorktreeReprovisionError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
    branch: Schema.NullOr(Schema.String),
    reason: Schema.Literals([
      "missing-branch",
      "worktree-service-unavailable",
      "branch-unavailable",
      "removal-in-progress",
      "project-not-found",
      "project-read-failed",
      "create-failed",
      "register-failed",
      "metadata-failed",
      "registry-read-failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unable to restore the purged worktree for thread ${this.threadId} (${this.reason}).`;
  }
}

export interface ThreadWorktreeServiceDependencies<ThreadError, DispatchError> {
  readonly getProjectThread: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<OrchestrationV2ThreadProjection, ThreadError>;
  readonly dispatch: (
    command: OrchestrationV2Command,
  ) => Effect.Effect<OrchestratorV2DispatchResult, DispatchError>;
  readonly gitWorkflow: Option.Option<GitWorkflowService.GitWorkflowService["Service"]>;
  readonly projectService: Option.Option<ProjectService.ProjectService["Service"]>;
  readonly worktreeInventory: Option.Option<
    WorktreeInventoryService.WorktreeInventoryService["Service"]
  >;
  readonly worktreeProvisioning: Option.Option<
    WorktreeProvisioningService.WorktreeProvisioningService["Service"]
  >;
  readonly worktreeCoordinator: Option.Option<
    WorktreeOperationCoordinator.WorktreeOperationCoordinator["Service"]
  >;
  readonly worktreeRegistry: Option.Option<WorktreeRegistry.WorktreeRegistry["Service"]>;
}

export interface ThreadWorktreeServiceShape<ThreadError> {
  readonly ensureWorktreeForThread: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<
    OrchestrationV2ThreadProjection,
    ThreadError | ThreadManagementWorktreeReprovisionError
  >;
  readonly withEnsuredWorktreeForThread: <A, E>(
    input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
    },
    use: (projection: OrchestrationV2ThreadProjection) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ThreadError | ThreadManagementWorktreeReprovisionError>;
}

export const makeThreadWorktreeService = <ThreadError, DispatchError>(
  dependencies: ThreadWorktreeServiceDependencies<ThreadError, DispatchError>,
): ThreadWorktreeServiceShape<ThreadError> => {
  const {
    dispatch,
    getProjectThread,
    gitWorkflow,
    projectService,
    worktreeCoordinator,
    worktreeInventory,
    worktreeProvisioning,
    worktreeRegistry,
  } = dependencies;

  const withThreadRepositoryLock = <A, E>(
    input: { readonly projectId: ProjectId; readonly threadId: ThreadId },
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Option.isNone(worktreeCoordinator) || Option.isNone(projectService)
      ? effect
      : projectService.value.getById(input.projectId).pipe(
          Effect.catchCause(() => Effect.succeed(null)),
          Effect.flatMap((projectOption) =>
            projectOption === null || Option.isNone(projectOption)
              ? effect
              : worktreeCoordinator.value.withRepositoryLock(
                  projectOption.value.workspaceRoot,
                  effect,
                ),
          ),
        );

  const ensureWorktreeForThreadUnlocked = Effect.fn(
    "ThreadWorktreeService.ensureWorktreeForThreadUnlocked",
  )(function* (input: { readonly projectId: ProjectId; readonly threadId: ThreadId }) {
    const target = yield* getProjectThread(input);
    const branch = target.thread.branch;
    const reprovisionError = (
      reason: ThreadManagementWorktreeReprovisionError["reason"],
      cause?: unknown,
    ) =>
      new ThreadManagementWorktreeReprovisionError({
        projectId: input.projectId,
        threadId: input.threadId,
        branch,
        reason,
        ...(cause === undefined ? {} : { cause }),
      });

    // Archived threads cannot use a new workspace. Returning the projection
    // lets callers reject the operation without creating an unreachable branch.
    if (target.thread.archivedAt !== null) return target;

    const isPurged = target.thread.worktreeStatus === "purged";
    const activeRemovalClaim = isPurged
      ? yield* (
          Option.isSome(worktreeInventory)
            ? worktreeInventory.value.listAll()
            : Option.isSome(worktreeRegistry)
              ? worktreeRegistry.value.listAll()
              : Effect.succeed([] as ReadonlyArray<WorktreeRegistry.WorktreeRegistryEntry>)
        ).pipe(
          Effect.map((entries) => {
            const claimed = entries.find(
              (entry) =>
                entry.threadId === String(input.threadId) &&
                entry.state === "present" &&
                entry.removalClaimedAtMs !== null,
            );
            return claimed === undefined ? Option.none() : Option.some(claimed);
          }),
          Effect.mapError((cause) => reprovisionError("registry-read-failed", cause)),
        )
      : Option.none();
    if (Option.isSome(activeRemovalClaim)) {
      return yield* reprovisionError("removal-in-progress");
    }
    const registryEntry =
      isPurged || target.thread.worktreePath === null
        ? Option.none<WorktreeRegistry.WorktreeRegistryEntry>()
        : yield* (
            Option.isSome(worktreeInventory)
              ? worktreeInventory.value.getRemovedForThreadPath({
                  threadId: String(input.threadId),
                  worktreePath: target.thread.worktreePath,
                })
              : Option.isSome(worktreeRegistry)
                ? worktreeRegistry.value.getRemovedForThreadPath({
                    threadId: String(input.threadId),
                    worktreePath: target.thread.worktreePath,
                  })
                : Effect.succeed(Option.none())
          ).pipe(Effect.mapError((cause) => reprovisionError("registry-read-failed", cause)));
    if (
      !isPurged &&
      Option.isSome(registryEntry) &&
      registryEntry.value.removalClaimedAtMs !== null
    ) {
      return yield* reprovisionError("removal-in-progress");
    }
    const registryRemoved = Option.isSome(registryEntry) && registryEntry.value.state === "removed";
    if (!isPurged && !registryRemoved) return target;

    if (branch === null) return yield* reprovisionError("missing-branch");
    if (Option.isNone(gitWorkflow) || Option.isNone(projectService)) {
      return yield* reprovisionError("worktree-service-unavailable");
    }

    if ((isPurged || registryRemoved) && target.thread.worktreePath !== null) {
      yield* dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(
          `worktree-recovery:purge:${String(input.threadId)}:${encodeURIComponent(target.thread.worktreePath)}`,
        ),
        threadId: input.threadId,
        branch,
        worktreePath: null,
        worktreeStatus: "purged",
        expectedWorktreePath: target.thread.worktreePath,
      }).pipe(Effect.mapError((cause) => reprovisionError("metadata-failed", cause)));
    }

    const projectOption = yield* projectService.value
      .getById(input.projectId)
      .pipe(Effect.mapError((cause) => reprovisionError("project-read-failed", cause)));
    if (Option.isNone(projectOption)) return yield* reprovisionError("project-not-found");

    const project = projectOption.value;
    const listLocalBranchNames = gitWorkflow.value.listLocalBranchNames;
    if (typeof listLocalBranchNames === "function") {
      const branchNames = yield* listLocalBranchNames(project.workspaceRoot).pipe(
        Effect.mapError((cause) => reprovisionError("branch-unavailable", cause)),
      );
      if (!branchNames.includes(branch)) return yield* reprovisionError("branch-unavailable");
    }

    const provisioned = Option.isSome(worktreeProvisioning)
      ? yield* worktreeProvisioning.value
          .createWithinRepositoryLock(
            {
              git: { cwd: project.workspaceRoot, refName: branch, path: null },
              projectId: String(input.projectId),
              threadId: String(input.threadId),
              ownership: "t3-created",
            },
            {
              create: () =>
                gitWorkflow.value.createWorktree({
                  cwd: project.workspaceRoot,
                  refName: branch,
                  path: null,
                }),
              remove: (path) =>
                gitWorkflow.value.removeWorktree({
                  cwd: project.workspaceRoot,
                  path,
                }),
            },
          )
          .pipe(Effect.mapError((cause) => reprovisionError("create-failed", cause)))
      : yield* Effect.gen(function* () {
          let createdPath: string | null = null;
          const created = yield* gitWorkflow.value
            .createWorktree({ cwd: project.workspaceRoot, refName: branch, path: null })
            .pipe(Effect.mapError((cause) => reprovisionError("create-failed", cause)));
          createdPath = created.worktree.path;
          const observedAtMs = yield* Clock.currentTimeMillis;
          let register: Effect.Effect<void, WorktreeRegistry.WorktreeRegistryError> = Effect.void;
          if (Option.isSome(worktreeInventory)) {
            register = worktreeInventory.value
              .register({
                repositoryRoot: project.workspaceRoot,
                worktreePath: created.worktree.path,
                projectId: String(input.projectId),
                threadId: String(input.threadId),
                branch: created.worktree.refName,
                ownership: "t3-created",
                createdAtMs: observedAtMs,
                discoveredAtMs: observedAtMs,
                lastActivityAtMs: observedAtMs,
                observedAtMs,
              })
              .pipe(Effect.asVoid);
          } else if (Option.isSome(worktreeRegistry)) {
            register = worktreeRegistry.value
              .register({
                repositoryRoot: project.workspaceRoot,
                worktreePath: created.worktree.path,
                projectId: String(input.projectId),
                threadId: String(input.threadId),
                branch: created.worktree.refName,
                ownership: "t3-created",
                createdAtMs: observedAtMs,
                discoveredAtMs: observedAtMs,
                lastActivityAtMs: observedAtMs,
                observedAtMs,
              })
              .pipe(Effect.asVoid);
          }
          yield* register.pipe(
            Effect.mapError((cause) => reprovisionError("create-failed", cause)),
            Effect.onError(() =>
              createdPath === null
                ? Effect.void
                : gitWorkflow.value
                    .removeWorktree({ cwd: project.workspaceRoot, path: createdPath })
                    .pipe(Effect.ignore),
            ),
          );
          return { worktree: created.worktree } as const;
        });
    const worktreePath = provisioned.worktree.path;
    const createdBranch = provisioned.worktree.refName;
    const now = yield* Clock.currentTimeMillis;

    const metadataResult = yield* Effect.result(
      dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`worktree-reprovision:${String(input.threadId)}:${now}`),
        threadId: input.threadId,
        branch: createdBranch,
        worktreePath,
        worktreeStatus: "present",
        expectedWorktreePath: null,
      }),
    );
    if (Result.isFailure(metadataResult)) {
      const refreshedResult = yield* Effect.result(getProjectThread(input));
      if (
        Result.isSuccess(refreshedResult) &&
        refreshedResult.success.thread.worktreeStatus === "present" &&
        refreshedResult.success.thread.worktreePath === worktreePath
      ) {
        return refreshedResult.success;
      }
      if (Option.isSome(worktreeProvisioning)) {
        yield* worktreeProvisioning.value.rollbackWithinRepositoryLock(
          {
            cwd: project.workspaceRoot,
            worktreePath,
            reason: "reprovision_metadata_failed",
          },
          {
            remove: (path) =>
              gitWorkflow.value.removeWorktree({
                cwd: project.workspaceRoot,
                path,
              }),
          },
        );
      } else {
        const removed = yield* Effect.result(
          gitWorkflow.value.removeWorktree({
            cwd: project.workspaceRoot,
            path: worktreePath,
          }),
        );
        if (Result.isSuccess(removed) && Option.isSome(worktreeRegistry)) {
          yield* worktreeRegistry.value
            .markRemoved({
              repositoryRoot: project.workspaceRoot,
              worktreePath,
              removedAtMs: yield* Clock.currentTimeMillis,
              reason: "reprovision_metadata_failed",
            })
            .pipe(Effect.ignore);
        }
      }
      return yield* reprovisionError("metadata-failed", metadataResult.failure);
    }

    return yield* getProjectThread(input);
  });

  const ensureWorktreeForThread: ThreadWorktreeServiceShape<ThreadError>["ensureWorktreeForThread"] =
    (input) => withThreadRepositoryLock(input, ensureWorktreeForThreadUnlocked(input));

  const withEnsuredWorktreeForThread: ThreadWorktreeServiceShape<ThreadError>["withEnsuredWorktreeForThread"] =
    (input, use) =>
      withThreadRepositoryLock(
        input,
        ensureWorktreeForThreadUnlocked(input).pipe(Effect.flatMap(use)),
      );

  return { ensureWorktreeForThread, withEnsuredWorktreeForThread };
};
