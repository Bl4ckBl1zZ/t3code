import { expect, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { OrchestratorProjectionError, OrchestratorV2 } from "./Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorktreeRegistry from "../worktree/WorktreeRegistry.ts";
import {
  existingThreadIdsForCommand,
  layer,
  ThreadManagementDurableRunProjectionError,
  ThreadManagementProjectThreadsListError,
  ThreadManagementProjectionLoadError,
  ThreadManagementRunNotFoundError,
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
  ThreadManagementThreadNotInterruptibleError,
  ThreadManagementThreadArchivedError,
  ThreadManagementNoSteerableRunError,
  ThreadManagementWorktreeReprovisionError,
  withCreationProvenance,
} from "./ThreadManagementService.ts";

it("stamps authoritative provenance on commands that create threads or messages", () => {
  const command: OrchestrationV2Command = {
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("command:thread-management:create"),
    threadId: ThreadId.make("thread:thread-management:create"),
    projectId: ProjectId.make("project:thread-management"),
    title: "Thread management",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  };

  expect(
    withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toMatchObject({
    createdBy: "user",
    creationSource: "web",
  });
});

it("leaves commands that do not create durable authored content unchanged", () => {
  const command: OrchestrationV2Command = {
    type: "run.interrupt",
    commandId: CommandId.make("command:thread-management:interrupt"),
    threadId: ThreadId.make("thread:thread-management:interrupt"),
    runId: RunId.make("run:thread-management:interrupt"),
  };

  expect(
    withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toBe(command);
});

it("identifies every existing thread that must be hydrated before dispatch", () => {
  const sourceThreadId = ThreadId.make("thread:thread-management:source");
  const targetThreadId = ThreadId.make("thread:thread-management:target");
  const parentThreadId = ThreadId.make("thread:thread-management:parent");

  expect(
    existingThreadIdsForCommand({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:create"),
      threadId: targetThreadId,
      projectId: ProjectId.make("project:thread-management"),
      title: "Created thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    }),
  ).toEqual([]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.archive",
      commandId: CommandId.make("command:thread-management:archive"),
      threadId: targetThreadId,
    }),
  ).toEqual([targetThreadId]);

  // Read-state commands skip transcript hydration entirely: they fire on
  // every activity bump while a thread is open and never touch messages.
  expect(
    existingThreadIdsForCommand({
      type: "thread.visit",
      commandId: CommandId.make("command:thread-management:visit"),
      threadId: targetThreadId,
      visitedAt: "2026-07-30T00:00:00.000Z",
    }),
  ).toEqual([]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.mark-unread",
      commandId: CommandId.make("command:thread-management:mark-unread"),
      threadId: targetThreadId,
    }),
  ).toEqual([]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.fork",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: {
        type: "run",
        runId: RunId.make("run:thread-management:source"),
      },
    }),
  ).toEqual([sourceThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.merge_back",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:merge"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: {
        type: "run",
        runId: RunId.make("run:thread-management:source"),
      },
    }),
  ).toEqual([sourceThreadId, targetThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "provider",
      commandId: CommandId.make("command:thread-management:delegate"),
      parentThreadId,
      parentRunId: RunId.make("run:thread-management:parent"),
      parentNodeId: NodeId.make("node:thread-management:parent"),
      task: "Inspect the migration",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
    }),
  ).toEqual([parentThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "delegated_task.wake-policy",
      commandId: CommandId.make("command:thread-management:wake-policy"),
      parentThreadId,
      taskId: NodeId.make("node:thread-management:delegated"),
      completionWake: "always",
    }),
  ).toEqual([parentThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.created.record",
      commandId: CommandId.make("command:thread-management:record"),
      parentThreadId,
      parentRunId: RunId.make("run:thread-management:parent"),
      parentNodeId: NodeId.make("node:thread-management:parent"),
      targetThreadId,
      targetRunId: null,
    }),
  ).toEqual([parentThreadId, targetThreadId]);
});

it("derives thread management messages from structural error attributes", () => {
  const projectId = ProjectId.make("project:thread-management:errors");
  const threadId = ThreadId.make("thread:thread-management:errors");
  const runId = RunId.make("run:thread-management:errors");
  const messageId = MessageId.make("message:thread-management:errors");
  const infrastructureCause = new Error("private sqlite detail");

  const threadNotFound = new ThreadManagementThreadNotFoundError({
    projectId,
    threadId,
  });
  expect(threadNotFound).toMatchObject({ projectId, threadId });
  expect(threadNotFound.message).toBe(`Thread ${threadId} was not found in project ${projectId}.`);

  const runNotFound = new ThreadManagementRunNotFoundError({ threadId, runId });
  expect(runNotFound).toMatchObject({ threadId, runId });
  expect(runNotFound.message).toBe(`Run ${runId} does not belong to thread ${threadId}.`);

  const archived = new ThreadManagementThreadArchivedError({
    threadId,
  });
  expect(archived).toMatchObject({ threadId });
  expect(archived.message).toBe(`Thread ${threadId} is archived and cannot receive messages.`);

  const notSteerable = new ThreadManagementNoSteerableRunError({
    threadId,
    mode: "restart",
  });
  expect(notSteerable).toMatchObject({
    threadId,
    mode: "restart",
  });
  expect(notSteerable.message).toBe(
    `Thread ${threadId} has no running turn that can be restarted.`,
  );

  const notInterruptible = new ThreadManagementThreadNotInterruptibleError({
    threadId,
    runId,
  });
  expect(notInterruptible).toMatchObject({ threadId, runId });
  expect(notInterruptible.message).toBe(`Run ${runId} is not currently interruptible.`);

  const listFailure = new ThreadManagementProjectThreadsListError({
    projectId,
    cause: infrastructureCause,
  });
  expect(listFailure).toMatchObject({ projectId, cause: infrastructureCause });
  expect(listFailure.message).toBe(`Unable to list threads in project ${projectId}.`);
  expect(listFailure.message).not.toContain(infrastructureCause.message);

  const durableProjectionFailure = new ThreadManagementDurableRunProjectionError({
    threadId,
    messageId,
  });
  expect(durableProjectionFailure).toMatchObject({ threadId, messageId });
  expect(durableProjectionFailure.message).toBe(
    `Message ${messageId} was accepted on thread ${threadId} without a durable run projection.`,
  );
});

it.effect("classifies projection infrastructure failures separately from a missing thread", () => {
  const projectId = ProjectId.make("project:thread-management:projection-failure");
  const threadId = ThreadId.make("thread:thread-management:projection-failure");
  const infrastructureCause = new Error("sqlite read failed");
  const projectionError = new OrchestratorProjectionError({
    threadId,
    cause: infrastructureCause,
  });
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mock(OrchestratorV2)({
        getThreadProjection: () => Effect.fail(projectionError),
      }),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementProjectionLoadError);
    expect(error).toMatchObject({
      projectId,
      threadId,
      cause: projectionError,
    });
    expect(error.message).toBe(`Unable to load thread ${threadId} in project ${projectId}.`);
  }).pipe(Effect.provide(testLayer));
});

it.effect("uses thread-not-found only after a projection loads outside the project", () => {
  const projectId = ProjectId.make("project:thread-management:requested");
  const otherProjectId = ProjectId.make("project:thread-management:other");
  const threadId = ThreadId.make("thread:thread-management:wrong-project");
  const projection = {
    thread: {
      id: threadId,
      projectId: otherProjectId,
      deletedAt: null,
    },
  } as OrchestrationV2ThreadProjection;
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mock(OrchestratorV2)({
        getThreadProjection: () => Effect.succeed(projection),
      }),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementThreadNotFoundError);
    expect(error).toMatchObject({ projectId, threadId });
    expect("cause" in error).toBe(false);
  }).pipe(Effect.provide(testLayer));
});

it.effect("reprovisions a purged worktree before a follow-up send", () => {
  let worktreePath: string | null = null;
  let worktreeStatus: "purged" | "present" = "purged";
  const makeProjection = (): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: ThreadId.make("thread:reprovision"),
        projectId: ProjectId.make("project:reprovision"),
        branch: "feature/reprovision",
        worktreePath,
        worktreeStatus,
        deletedAt: null,
        archivedAt: null,
      },
    }) as unknown as OrchestrationV2ThreadProjection;
  const dispatch = vi.fn((command: OrchestrationV2Command) => {
    if (command.type === "thread.metadata.update") {
      worktreePath = command.worktreePath ?? null;
      worktreeStatus = command.worktreeStatus === "present" ? "present" : "purged";
    }
    return Effect.succeed({ sequence: 2, storedEvents: [] });
  });
  const createWorktree = vi.fn(() =>
    Effect.succeed({
      worktree: { path: "/server/worktrees/reprovision", refName: "feature/reprovision" },
    }),
  );
  const registration = vi.fn((input: WorktreeRegistry.WorktreeRegistration) =>
    Effect.succeed({
      repositoryRoot: input.repositoryRoot,
      worktreePath: input.worktreePath,
      projectId: input.projectId,
      threadId: input.threadId,
      branch: input.branch,
      ownership: input.ownership,
      createdAtMs: input.createdAtMs,
      discoveredAtMs: input.discoveredAtMs,
      lastActivityAtMs: input.lastActivityAtMs,
      state: "present",
      lastReason: null,
      updatedAtMs: input.observedAtMs,
      generation: 1,
      removalClaimedAtMs: null,
    } satisfies WorktreeRegistry.WorktreeRegistryEntry),
  );
  const reprovisionLayer = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestratorV2)({
          getThreadProjection: () => Effect.succeed(makeProjection()),
          dispatch,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({
                id: ProjectId.make("project:reprovision"),
                workspaceRoot: "/repo",
              } as never),
            ),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          listLocalBranchNames: () => Effect.succeed(["feature/reprovision"]),
          createWorktree,
          removeWorktree: () => Effect.void,
        }),
        Layer.mock(WorktreeRegistry.WorktreeRegistry)({
          listAll: () => Effect.succeed([]),
          register: registration,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService;
    const projection = yield* service.ensureWorktreeForThread({
      projectId: ProjectId.make("project:reprovision"),
      threadId: ThreadId.make("thread:reprovision"),
    });

    expect(createWorktree).toHaveBeenCalledWith({
      cwd: "/repo",
      refName: "feature/reprovision",
      path: null,
    });
    expect(registration).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: "/server/worktrees/reprovision",
        ownership: "t3-created",
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.metadata.update",
        worktreePath: "/server/worktrees/reprovision",
        worktreeStatus: "present",
        expectedWorktreePath: null,
      }),
    );
    expect(projection.thread.worktreePath).toBe("/server/worktrees/reprovision");
  }).pipe(Effect.provide(reprovisionLayer));
});

it.effect("recovers when the registry records a removed path before its purge event lands", () => {
  let worktreePath: string | null = "/server/worktrees/removed-before-event";
  let worktreeStatus: "present" | "purged" = "present";
  const makeProjection = (): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: ThreadId.make("thread:registry-recovery"),
        projectId: ProjectId.make("project:registry-recovery"),
        branch: "feature/registry-recovery",
        worktreePath,
        worktreeStatus,
        deletedAt: null,
        archivedAt: null,
      },
    }) as unknown as OrchestrationV2ThreadProjection;
  const dispatch = vi.fn((command: OrchestrationV2Command) => {
    if (command.type === "thread.metadata.update") {
      worktreePath = command.worktreePath ?? null;
      worktreeStatus = command.worktreeStatus === "present" ? "present" : "purged";
    }
    return Effect.succeed({ sequence: 3, storedEvents: [] });
  });
  const registration = vi.fn((input: WorktreeRegistry.WorktreeRegistration) =>
    Effect.succeed({
      repositoryRoot: input.repositoryRoot,
      worktreePath: input.worktreePath,
      projectId: input.projectId,
      threadId: input.threadId,
      branch: input.branch,
      ownership: input.ownership,
      createdAtMs: input.createdAtMs,
      discoveredAtMs: input.discoveredAtMs,
      lastActivityAtMs: input.lastActivityAtMs,
      state: "present",
      lastReason: null,
      updatedAtMs: input.observedAtMs,
      generation: 1,
      removalClaimedAtMs: null,
    } satisfies WorktreeRegistry.WorktreeRegistryEntry),
  );
  const reprovisionLayer = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestratorV2)({
          getThreadProjection: () => Effect.succeed(makeProjection()),
          dispatch,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({
                id: ProjectId.make("project:registry-recovery"),
                workspaceRoot: "/repo",
              } as never),
            ),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          listLocalBranchNames: () => Effect.succeed(["feature/registry-recovery"]),
          createWorktree: () =>
            Effect.succeed({
              worktree: {
                path: "/server/worktrees/registry-recovery",
                refName: "feature/registry-recovery",
              },
            }),
          removeWorktree: () => Effect.void,
        }),
        Layer.mock(WorktreeRegistry.WorktreeRegistry)({
          getRemovedForThreadPath: () =>
            Effect.succeed(
              Option.some({
                repositoryRoot: "/repo",
                worktreePath: "/server/worktrees/removed-before-event",
                projectId: "project:registry-recovery",
                threadId: "thread:registry-recovery",
                branch: "feature/registry-recovery",
                ownership: "t3-created",
                createdAtMs: 1_000,
                discoveredAtMs: 1_000,
                lastActivityAtMs: 1_000,
                state: "removed",
                lastReason: "retention",
                updatedAtMs: 2_000,
                generation: 1,
                removalClaimedAtMs: null,
              } satisfies WorktreeRegistry.WorktreeRegistryEntry),
            ),
          register: registration,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService;
    const projection = yield* service.ensureWorktreeForThread({
      projectId: ProjectId.make("project:registry-recovery"),
      threadId: ThreadId.make("thread:registry-recovery"),
    });

    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "thread.metadata.update",
        worktreePath: null,
        worktreeStatus: "purged",
        expectedWorktreePath: "/server/worktrees/removed-before-event",
      }),
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "thread.metadata.update",
        worktreePath: "/server/worktrees/registry-recovery",
        worktreeStatus: "present",
        expectedWorktreePath: null,
      }),
    );
    expect(projection.thread.worktreePath).toBe("/server/worktrees/registry-recovery");
  }).pipe(Effect.provide(reprovisionLayer));
});

it.effect("reprovisions when the worktree directory vanished behind the registry", () => {
  let worktreePath: string | null = "/server/worktrees/deleted-by-hand";
  let worktreeStatus: "present" | "purged" = "present";
  const makeProjection = (): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: ThreadId.make("thread:missing-on-disk"),
        projectId: ProjectId.make("project:missing-on-disk"),
        branch: "feature/missing-on-disk",
        worktreePath,
        worktreeStatus,
        deletedAt: null,
        archivedAt: null,
      },
    }) as unknown as OrchestrationV2ThreadProjection;
  const dispatch = vi.fn((command: OrchestrationV2Command) => {
    if (command.type === "thread.metadata.update") {
      worktreePath = command.worktreePath ?? null;
      worktreeStatus = command.worktreeStatus === "present" ? "present" : "purged";
    }
    return Effect.succeed({ sequence: 4, storedEvents: [] });
  });
  const pruneWorktrees = vi.fn(() => Effect.void);
  const createWorktree = vi.fn(() =>
    Effect.succeed({
      worktree: {
        path: "/server/worktrees/missing-on-disk",
        refName: "feature/missing-on-disk",
      },
    }),
  );
  const reprovisionLayer = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestratorV2)({
          getThreadProjection: () => Effect.succeed(makeProjection()),
          dispatch,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({
                id: ProjectId.make("project:missing-on-disk"),
                workspaceRoot: "/repo",
              } as never),
            ),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          listLocalBranchNames: () => Effect.succeed(["feature/missing-on-disk"]),
          pruneWorktrees,
          createWorktree,
          removeWorktree: () => Effect.void,
        }),
        // The registry still says "present": only the filesystem knows.
        Layer.mock(WorktreeRegistry.WorktreeRegistry)({
          getRemovedForThreadPath: () => Effect.succeed(Option.none()),
          register: () => Effect.succeed(undefined as never),
        }),
        // layerNoop rather than Layer.mock: FileSystem carries required members
        // (its brand, `sink`) that a partial mock cannot satisfy, and the noop
        // layer fills every method this test never calls.
        FileSystem.layerNoop({
          exists: () => Effect.succeed(false),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService;
    const projection = yield* service.ensureWorktreeForThread({
      projectId: ProjectId.make("project:missing-on-disk"),
      threadId: ThreadId.make("thread:missing-on-disk"),
    });

    expect(pruneWorktrees).toHaveBeenCalledWith({ cwd: "/repo" });
    expect(createWorktree).toHaveBeenCalledWith({
      cwd: "/repo",
      refName: "feature/missing-on-disk",
      path: null,
    });
    expect(projection.thread.worktreePath).toBe("/server/worktrees/missing-on-disk");
  }).pipe(Effect.provide(reprovisionLayer));
});

it.effect("reports branch-unavailable when recovery cannot recreate the deleted branch", () => {
  const projectId = ProjectId.make("project:missing-branch");
  const threadId = ThreadId.make("thread:missing-branch");
  const projection = {
    thread: {
      id: threadId,
      projectId,
      branch: "feature/deleted-branch",
      worktreePath: "/server/worktrees/deleted-branch",
      worktreeStatus: "purged",
      deletedAt: null,
      archivedAt: null,
    },
  } as unknown as OrchestrationV2ThreadProjection;
  const createWorktree = vi.fn(() =>
    Effect.succeed({
      worktree: { path: "/server/worktrees/should-not-exist", refName: "feature/deleted-branch" },
    }),
  );
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestratorV2)({
          getThreadProjection: () => Effect.succeed(projection),
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/repo" } as never)),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          listLocalBranchNames: () => Effect.succeed([]),
          createWorktree,
        }),
        Layer.mock(WorktreeRegistry.WorktreeRegistry)({
          getRemovedForThreadPath: () => Effect.succeed(Option.none()),
          listAll: () => Effect.succeed([]),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService;
    const error = yield* Effect.flip(service.ensureWorktreeForThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementWorktreeReprovisionError);
    expect(error).toMatchObject({ reason: "branch-unavailable", threadId });
    expect(createWorktree).not.toHaveBeenCalled();
  }).pipe(Effect.provide(testLayer));
});

it.effect("does not reprovision while the registry removal claim is active", () => {
  const projectId = ProjectId.make("project:removal-in-progress");
  const threadId = ThreadId.make("thread:removal-in-progress");
  const projection = {
    thread: {
      id: threadId,
      projectId,
      branch: "feature/removal-in-progress",
      worktreePath: "/server/worktrees/removal-in-progress",
      worktreeStatus: "present",
      deletedAt: null,
      archivedAt: null,
    },
  } as unknown as OrchestrationV2ThreadProjection;
  const createWorktree = vi.fn(() =>
    Effect.succeed({
      worktree: {
        path: "/server/worktrees/replacement",
        refName: "feature/removal-in-progress",
      },
    }),
  );
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestratorV2)({
          getThreadProjection: () => Effect.succeed(projection),
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/repo" } as never)),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          listLocalBranchNames: () => Effect.succeed(["feature/removal-in-progress"]),
          createWorktree,
        }),
        Layer.mock(WorktreeRegistry.WorktreeRegistry)({
          getRemovedForThreadPath: () =>
            Effect.succeed(
              Option.some({
                repositoryRoot: "/repo",
                worktreePath: "/server/worktrees/removal-in-progress",
                projectId: String(projectId),
                threadId: String(threadId),
                branch: "feature/removal-in-progress",
                ownership: "t3-created",
                createdAtMs: 1_000,
                discoveredAtMs: 1_000,
                lastActivityAtMs: 1_000,
                state: "present",
                lastReason: "maxAge",
                updatedAtMs: 2_000,
                generation: 1,
                removalClaimedAtMs: 2_000,
              } satisfies WorktreeRegistry.WorktreeRegistryEntry),
            ),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService;
    const error = yield* Effect.flip(service.ensureWorktreeForThread({ projectId, threadId }));

    expect(error).toMatchObject({ reason: "removal-in-progress", threadId });
    expect(createWorktree).not.toHaveBeenCalled();
  }).pipe(Effect.provide(testLayer));
});

it.effect("does not reprovision a purged thread while its removal claim is active", () => {
  const projectId = ProjectId.make("project:purged-removal-in-progress");
  const threadId = ThreadId.make("thread:purged-removal-in-progress");
  const projection = {
    thread: {
      id: threadId,
      projectId,
      branch: "feature/purged-removal-in-progress",
      worktreePath: null,
      worktreeStatus: "purged",
      deletedAt: null,
      archivedAt: null,
    },
  } as unknown as OrchestrationV2ThreadProjection;
  const createWorktree = vi.fn(() =>
    Effect.succeed({
      worktree: {
        path: "/server/worktrees/purged-replacement",
        refName: "feature/purged-removal-in-progress",
      },
    }),
  );
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestratorV2)({
          getThreadProjection: () => Effect.succeed(projection),
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/repo" } as never)),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          listLocalBranchNames: () => Effect.succeed(["feature/purged-removal-in-progress"]),
          createWorktree,
        }),
        Layer.mock(WorktreeRegistry.WorktreeRegistry)({
          listAll: () =>
            Effect.succeed([
              {
                repositoryRoot: "/repo",
                worktreePath: "/server/worktrees/purged-removal-in-progress",
                projectId: String(projectId),
                threadId: String(threadId),
                branch: "feature/purged-removal-in-progress",
                ownership: "t3-created",
                createdAtMs: 1_000,
                discoveredAtMs: 1_000,
                lastActivityAtMs: 1_000,
                state: "present",
                lastReason: "maxAge",
                updatedAtMs: 2_000,
                generation: 1,
                removalClaimedAtMs: 2_000,
              } satisfies WorktreeRegistry.WorktreeRegistryEntry,
            ]),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService;
    const error = yield* Effect.flip(service.ensureWorktreeForThread({ projectId, threadId }));

    expect(error).toMatchObject({ reason: "removal-in-progress", threadId });
    expect(createWorktree).not.toHaveBeenCalled();
  }).pipe(Effect.provide(testLayer));
});
