import {
  ChatAttachment,
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  DEFAULT_LOCAL_ORGANIZATION_ID,
  OrganizationId,
  ProjectScript,
  SubChatId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationOrganizationShell,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationSubChatShell,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type OrchestrationWorkspaceActionShell,
  type OrchestrationWorkspaceShell,
  ModelSelection,
  ProjectId,
  ThreadId,
  WorkspaceActionId,
  WorkspaceActionSource,
  WorkspaceActionStatus,
  WorkspaceId,
  WorkspaceMode,
  WorkspaceStatus,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionFullThreadDiffContext,
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeShellSnapshot = Schema.decodeUnknownEffect(OrchestrationShellSnapshot);
const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
  }),
);
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});
const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});
const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const WorkspaceIdLookupInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
const ProjectionWorkspaceLookupRowSchema = Schema.Struct({
  workspaceId: WorkspaceId,
  organizationId: OrganizationId,
  projectId: ProjectId,
  title: Schema.String,
  cwd: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  baseBranch: Schema.NullOr(Schema.String),
  mode: WorkspaceMode,
  status: WorkspaceStatus,
  defaultSubChatId: Schema.NullOr(SubChatId),
  browserPreviewUrl: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
const ProjectionSubChatLookupRowSchema = Schema.Struct({
  subChatId: SubChatId,
  workspaceId: WorkspaceId,
  organizationId: OrganizationId,
  projectId: ProjectId,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
const ProjectionWorkspaceActionLookupRowSchema = Schema.Struct({
  actionId: WorkspaceActionId,
  workspaceId: WorkspaceId,
  organizationId: OrganizationId,
  projectId: ProjectId,
  subChatId: Schema.NullOr(SubChatId),
  terminalId: Schema.NullOr(Schema.String),
  kind: Schema.String,
  title: Schema.String,
  status: WorkspaceActionStatus,
  source: WorkspaceActionSource,
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;
const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});
const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});
const FullThreadDiffContextLookupInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
});
const ProjectionFullThreadDiffContextRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  latestCheckpointTurnCount: Schema.NullOr(NonNegativeInt),
  toCheckpointRef: Schema.NullOr(CheckpointRef),
});

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function mapLatestTurn(
  row: Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>,
): OrchestrationLatestTurn {
  return {
    turnId: row.turnId,
    state:
      row.state === "error"
        ? "error"
        : row.state === "interrupted"
          ? "interrupted"
          : row.state === "completed"
            ? "completed"
            : "running",
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    assistantMessageId: row.assistantMessageId,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
  };
}

function mapSessionRow(
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>,
): OrchestrationSession {
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    runtimeMode: row.runtimeMode,
    activeTurnId: row.activeTurnId,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function mapProjectShellRow(
  row: Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>,
  repositoryIdentity: OrchestrationProject["repositoryIdentity"],
): OrchestrationProjectShell {
  return {
    id: row.projectId,
    organizationId: DEFAULT_LOCAL_ORGANIZATION_ID,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: row.defaultModelSelection,
    scripts: row.scripts,
    browserPreviewUrl: row.browserPreviewUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function legacyWorkspaceIdForThread(input: {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}): WorkspaceId {
  const workspaceKey =
    input.worktreePath === null || input.worktreePath.trim().length === 0
      ? "primary"
      : `worktree:${Buffer.from(input.worktreePath).toString("base64url")}`;
  return WorkspaceId.make(`${input.projectId}:${workspaceKey}`);
}

function legacyWorkspaceIdForProject(projectId: ProjectId): WorkspaceId {
  return legacyWorkspaceIdForThread({ projectId, worktreePath: null });
}

function buildLegacyWorkspaceShells(input: {
  readonly projectRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>>;
  readonly threadRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>>;
  readonly includeArchivedThreads?: boolean;
}): OrchestrationWorkspaceShell[] {
  const projectById = new Map(input.projectRows.map((project) => [project.projectId, project]));
  const workspacesById = new Map<WorkspaceId, OrchestrationWorkspaceShell>();

  for (const project of input.projectRows) {
    if (project.deletedAt !== null) {
      continue;
    }
    const workspaceId = legacyWorkspaceIdForProject(project.projectId);
    workspacesById.set(workspaceId, {
      id: workspaceId,
      organizationId: DEFAULT_LOCAL_ORGANIZATION_ID,
      projectId: project.projectId,
      title: "main",
      cwd: project.workspaceRoot,
      branch: null,
      worktreePath: null,
      baseBranch: null,
      mode: "local",
      status: "ready",
      defaultSubChatId: null,
      browserPreviewUrl: project.browserPreviewUrl,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      archivedAt: null,
    });
  }

  for (const thread of input.threadRows) {
    if (
      thread.deletedAt !== null ||
      (thread.archivedAt !== null && input.includeArchivedThreads !== true)
    ) {
      continue;
    }
    const project = projectById.get(thread.projectId);
    if (!project || project.deletedAt !== null) {
      continue;
    }

    const workspaceId = legacyWorkspaceIdForThread({
      projectId: thread.projectId,
      worktreePath: thread.worktreePath,
    });
    const existing = workspacesById.get(workspaceId);
    const cwd = thread.worktreePath ?? project.workspaceRoot;
    const title = thread.worktreePath
      ? (thread.branch ?? thread.worktreePath.split(/[\\/]/u).at(-1) ?? "worktree")
      : "main";

    if (!existing) {
      workspacesById.set(workspaceId, {
        id: workspaceId,
        organizationId: DEFAULT_LOCAL_ORGANIZATION_ID,
        projectId: thread.projectId,
        title,
        cwd,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        baseBranch: null,
        mode: thread.worktreePath ? "worktree" : "local",
        status: "ready",
        defaultSubChatId: thread.threadId,
        browserPreviewUrl: project.browserPreviewUrl,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        archivedAt: null,
      });
      continue;
    }

    workspacesById.set(workspaceId, {
      ...existing,
      defaultSubChatId: existing.defaultSubChatId ?? thread.threadId,
      branch: existing.branch ?? thread.branch,
      updatedAt: existing.updatedAt > thread.updatedAt ? existing.updatedAt : thread.updatedAt,
    });
  }

  return [...workspacesById.values()].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

function mapWorkspaceRow(
  row: Schema.Schema.Type<typeof ProjectionWorkspaceLookupRowSchema>,
): OrchestrationWorkspaceShell {
  return {
    id: row.workspaceId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    title: row.title,
    cwd: row.cwd,
    branch: row.branch,
    worktreePath: row.worktreePath,
    baseBranch: row.baseBranch,
    mode: row.mode,
    status: row.status,
    defaultSubChatId: row.defaultSubChatId,
    browserPreviewUrl: row.browserPreviewUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  };
}

function mapWorkspaceActionRow(
  row: Schema.Schema.Type<typeof ProjectionWorkspaceActionLookupRowSchema>,
): OrchestrationWorkspaceActionShell {
  return {
    id: row.actionId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    subChatId: row.subChatId,
    terminalId: row.terminalId,
    kind: row.kind,
    title: row.title,
    status: row.status,
    source: row.source,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
  };
}

function mergeWorkspaceShells(input: {
  readonly concreteRows: ReadonlyArray<
    Schema.Schema.Type<typeof ProjectionWorkspaceLookupRowSchema>
  >;
  readonly legacyWorkspaces: ReadonlyArray<OrchestrationWorkspaceShell>;
  readonly includeArchived?: boolean;
}): OrchestrationWorkspaceShell[] {
  const byId = new Map<WorkspaceId, OrchestrationWorkspaceShell>();
  for (const workspace of input.legacyWorkspaces) {
    byId.set(workspace.id, workspace);
  }
  for (const row of input.concreteRows) {
    if (row.deletedAt !== null) {
      continue;
    }
    if (row.archivedAt !== null && input.includeArchived !== true) {
      continue;
    }
    byId.set(row.workspaceId, mapWorkspaceRow(row));
  }
  return [...byId.values()].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

function buildWorkspaceIdByThread(input: {
  readonly threadRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>>;
  readonly subChatRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionSubChatLookupRowSchema>>;
}): Map<ThreadId, WorkspaceId> {
  const byThread = new Map<ThreadId, WorkspaceId>();
  for (const row of input.subChatRows) {
    if (row.deletedAt === null) {
      byThread.set(ThreadId.make(row.subChatId), row.workspaceId);
    }
  }
  for (const row of input.threadRows) {
    if (!byThread.has(row.threadId)) {
      byThread.set(
        row.threadId,
        legacyWorkspaceIdForThread({
          projectId: row.projectId,
          worktreePath: row.worktreePath,
        }),
      );
    }
  }
  return byThread;
}

function workspaceIdForThreadRow(
  row: Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>,
  workspaceIdByThread: ReadonlyMap<ThreadId, WorkspaceId>,
): WorkspaceId {
  return (
    workspaceIdByThread.get(row.threadId) ??
    legacyWorkspaceIdForThread({
      projectId: row.projectId,
      worktreePath: row.worktreePath,
    })
  );
}

function buildLegacyOrganizationShell(input: {
  readonly projectRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>>;
  readonly updatedAt: string;
}): OrchestrationOrganizationShell {
  const createdAt =
    input.projectRows
      .filter((project) => project.deletedAt === null)
      .map((project) => project.createdAt)
      .toSorted()[0] ?? input.updatedAt;
  return {
    id: DEFAULT_LOCAL_ORGANIZATION_ID,
    title: "Local",
    createdAt,
    updatedAt: input.updatedAt,
  };
}

function mapProposedPlanRow(
  row: Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>,
): OrchestrationProposedPlan {
  return {
    id: row.planId,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.implementedAt,
    implementationThreadId: row.implementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
  const repositoryIdentityResolutionConcurrency = 4;
  const resolveRepositoryIdentitiesForProjects = Effect.fn(
    "ProjectionSnapshotQuery.resolveRepositoryIdentitiesForProjects",
  )(function* (
    projectRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>>,
    options?: {
      readonly includeDeleted?: boolean;
    },
  ) {
    const filteredProjectRows =
      options?.includeDeleted === true
        ? projectRows
        : projectRows.filter((row) => row.deletedAt === null);
    const uniqueWorkspaceRoots = [...new Set(filteredProjectRows.map((row) => row.workspaceRoot))];
    const repositoryIdentityByWorkspaceRoot = new Map(
      yield* Effect.forEach(
        uniqueWorkspaceRoots,
        (workspaceRoot) =>
          repositoryIdentityResolver
            .resolve(workspaceRoot)
            .pipe(Effect.map((identity) => [workspaceRoot, identity] as const)),
        { concurrency: repositoryIdentityResolutionConcurrency },
      ),
    );

    return new Map(
      filteredProjectRows.map((row) => [
        row.projectId,
        repositoryIdentityByWorkspaceRoot.get(row.workspaceRoot) ?? null,
      ]),
    );
  });

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          browser_preview_url AS "browserPreviewUrl",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          COALESCE(tab_group_id, thread_id) AS "tabGroupId",
          COALESCE(tab_type, 'chat') AS "tabType",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listWorkspaceRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkspaceLookupRowSchema,
    execute: () =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          organization_id AS "organizationId",
          project_id AS "projectId",
          title,
          cwd,
          branch,
          worktree_path AS "worktreePath",
          base_branch AS "baseBranch",
          mode,
          status,
          default_sub_chat_id AS "defaultSubChatId",
          browser_preview_url AS "browserPreviewUrl",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_workspaces
        ORDER BY created_at ASC, workspace_id ASC
      `,
  });

  const listActiveWorkspaceRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkspaceLookupRowSchema,
    execute: () =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          organization_id AS "organizationId",
          project_id AS "projectId",
          title,
          cwd,
          branch,
          worktree_path AS "worktreePath",
          base_branch AS "baseBranch",
          mode,
          status,
          default_sub_chat_id AS "defaultSubChatId",
          browser_preview_url AS "browserPreviewUrl",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_workspaces
        WHERE deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY created_at ASC, workspace_id ASC
      `,
  });

  const listArchivedWorkspaceRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkspaceLookupRowSchema,
    execute: () =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          organization_id AS "organizationId",
          project_id AS "projectId",
          title,
          cwd,
          branch,
          worktree_path AS "worktreePath",
          base_branch AS "baseBranch",
          mode,
          status,
          default_sub_chat_id AS "defaultSubChatId",
          browser_preview_url AS "browserPreviewUrl",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_workspaces
        WHERE deleted_at IS NULL
          AND archived_at IS NOT NULL
        ORDER BY archived_at DESC, workspace_id ASC
      `,
  });

  const listSubChatRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionSubChatLookupRowSchema,
    execute: () =>
      sql`
        SELECT
          sub_chat_id AS "subChatId",
          workspace_id AS "workspaceId",
          organization_id AS "organizationId",
          project_id AS "projectId",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_sub_chats
        ORDER BY updated_at DESC, sub_chat_id ASC
      `,
  });

  const listActiveSubChatRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionSubChatLookupRowSchema,
    execute: () =>
      sql`
        SELECT
          sub_chat_id AS "subChatId",
          workspace_id AS "workspaceId",
          organization_id AS "organizationId",
          project_id AS "projectId",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_sub_chats
        WHERE deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY updated_at DESC, sub_chat_id ASC
      `,
  });

  const listArchivedSubChatRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionSubChatLookupRowSchema,
    execute: () =>
      sql`
        SELECT
          sub_chat_id AS "subChatId",
          workspace_id AS "workspaceId",
          organization_id AS "organizationId",
          project_id AS "projectId",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_sub_chats
        WHERE deleted_at IS NULL
          AND archived_at IS NOT NULL
        ORDER BY archived_at DESC, sub_chat_id ASC
      `,
  });

  const listWorkspaceActionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkspaceActionLookupRowSchema,
    execute: () =>
      sql`
        SELECT
          action_id AS "actionId",
          workspace_id AS "workspaceId",
          organization_id AS "organizationId",
          project_id AS "projectId",
          sub_chat_id AS "subChatId",
          terminal_id AS "terminalId",
          kind,
          title,
          status,
          source,
          created_at AS "createdAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          updated_at AS "updatedAt"
        FROM projection_workspace_actions
        ORDER BY updated_at DESC, action_id ASC
      `,
  });

  const listActiveWorkspaceActionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkspaceActionLookupRowSchema,
    execute: () =>
      sql`
        SELECT
          actions.action_id AS "actionId",
          actions.workspace_id AS "workspaceId",
          actions.organization_id AS "organizationId",
          actions.project_id AS "projectId",
          actions.sub_chat_id AS "subChatId",
          actions.terminal_id AS "terminalId",
          actions.kind,
          actions.title,
          actions.status,
          actions.source,
          actions.created_at AS "createdAt",
          actions.started_at AS "startedAt",
          actions.completed_at AS "completedAt",
          actions.updated_at AS "updatedAt"
        FROM projection_workspace_actions AS actions
        INNER JOIN projection_workspaces AS workspaces
          ON workspaces.workspace_id = actions.workspace_id
        WHERE workspaces.deleted_at IS NULL
          AND workspaces.archived_at IS NULL
        ORDER BY actions.updated_at DESC, actions.action_id ASC
      `,
  });

  const listArchivedWorkspaceActionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkspaceActionLookupRowSchema,
    execute: () =>
      sql`
        SELECT
          actions.action_id AS "actionId",
          actions.workspace_id AS "workspaceId",
          actions.organization_id AS "organizationId",
          actions.project_id AS "projectId",
          actions.sub_chat_id AS "subChatId",
          actions.terminal_id AS "terminalId",
          actions.kind,
          actions.title,
          actions.status,
          actions.source,
          actions.created_at AS "createdAt",
          actions.started_at AS "startedAt",
          actions.completed_at AS "completedAt",
          actions.updated_at AS "updatedAt"
        FROM projection_workspace_actions AS actions
        INNER JOIN projection_workspaces AS workspaces
          ON workspaces.workspace_id = actions.workspace_id
        WHERE workspaces.deleted_at IS NULL
          AND workspaces.archived_at IS NOT NULL
        ORDER BY actions.updated_at DESC, actions.action_id ASC
      `,
  });

  const listActiveThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          COALESCE(tab_group_id, thread_id) AS "tabGroupId",
          COALESCE(tab_type, 'chat') AS "tabType",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY project_id ASC, created_at ASC, thread_id ASC
      `,
  });

  const listArchivedThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          COALESCE(tab_group_id, thread_id) AS "tabGroupId",
          COALESCE(tab_type, 'chat') AS "tabType",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NOT NULL
        ORDER BY project_id ASC, archived_at DESC, thread_id DESC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        ORDER BY
          thread_id ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listActiveThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listArchivedThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          baseline_checkpoint_ref AS "baselineCheckpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listActiveLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listArchivedLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          browser_preview_url AS "browserPreviewUrl",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getActiveProjectRowById = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          browser_preview_url AS "browserPreviewUrl",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const getWorkspaceRowById = SqlSchema.findOneOption({
    Request: WorkspaceIdLookupInput,
    Result: ProjectionWorkspaceLookupRowSchema,
    execute: ({ workspaceId }) =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          organization_id AS "organizationId",
          project_id AS "projectId",
          title,
          cwd,
          branch,
          worktree_path AS "worktreePath",
          base_branch AS "baseBranch",
          mode,
          status,
          default_sub_chat_id AS "defaultSubChatId",
          browser_preview_url AS "browserPreviewUrl",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_workspaces
        WHERE workspace_id = ${workspaceId}
        LIMIT 1
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getActiveThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          COALESCE(tab_group_id, thread_id) AS "tabGroupId",
          COALESCE(tab_type, 'chat') AS "tabType",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        LIMIT 1
      `,
  });

  const getThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          COALESCE(tab_group_id, thread_id) AS "tabGroupId",
          COALESCE(tab_type, 'chat') AS "tabType",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        LIMIT 1
      `,
  });

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          baseline_checkpoint_ref AS "baselineCheckpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const getFullThreadDiffContextRow = SqlSchema.findOneOption({
    Request: FullThreadDiffContextLookupInput,
    Result: ProjectionFullThreadDiffContextRowSchema,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath",
          (
            SELECT MAX(turns.checkpoint_turn_count)
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count IS NOT NULL
          ) AS "latestCheckpointTurnCount",
          (
            SELECT turns.checkpoint_ref
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count = ${checkpointTurnCount}
            LIMIT 1
          ) AS "toCheckpointRef"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listWorkspaceRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listWorkspaces:query",
                "ProjectionSnapshotQuery.getSnapshot:listWorkspaces:decodeRows",
              ),
            ),
          ),
          listSubChatRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listSubChats:query",
                "ProjectionSnapshotQuery.getSnapshot:listSubChats:decodeRows",
              ),
            ),
          ),
          listWorkspaceActionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listWorkspaceActions:query",
                "ProjectionSnapshotQuery.getSnapshot:listWorkspaceActions:decodeRows",
              ),
            ),
          ),
          listThreadMessageRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadActivityRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listCheckpointRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            workspaceRows,
            subChatRows,
            workspaceActionRows,
            messageRows,
            proposedPlanRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
              const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
              const sessionsByThread = new Map<string, OrchestrationSession>();
              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

              let updatedAt: string | null = null;

              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of workspaceRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of subChatRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of workspaceActionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of messageRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadMessages = messagesByThread.get(row.threadId) ?? [];
                threadMessages.push({
                  id: row.messageId,
                  role: row.role,
                  text: row.text,
                  ...(row.attachments !== null ? { attachments: row.attachments } : {}),
                  turnId: row.turnId,
                  streaming: row.isStreaming === 1,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                messagesByThread.set(row.threadId, threadMessages);
              }

              for (const row of proposedPlanRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push({
                  id: row.planId,
                  turnId: row.turnId,
                  planMarkdown: row.planMarkdown,
                  implementedAt: row.implementedAt,
                  implementationThreadId: row.implementationThreadId,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (const row of activityRows) {
                updatedAt = maxIso(updatedAt, row.createdAt);
                const threadActivities = activitiesByThread.get(row.threadId) ?? [];
                threadActivities.push({
                  id: row.activityId,
                  tone: row.tone,
                  kind: row.kind,
                  summary: row.summary,
                  payload: row.payload,
                  turnId: row.turnId,
                  ...(row.sequence !== null ? { sequence: row.sequence } : {}),
                  createdAt: row.createdAt,
                });
                activitiesByThread.set(row.threadId, threadActivities);
              }

              for (const row of checkpointRows) {
                updatedAt = maxIso(updatedAt, row.completedAt);
                const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
                threadCheckpoints.push({
                  turnId: row.turnId,
                  checkpointTurnCount: row.checkpointTurnCount,
                  checkpointRef: row.checkpointRef,
                  baselineCheckpointRef: row.baselineCheckpointRef,
                  status: row.status,
                  files: row.files,
                  assistantMessageId: row.assistantMessageId,
                  completedAt: row.completedAt,
                });
                checkpointsByThread.set(row.threadId, threadCheckpoints);
              }

              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
                if (latestTurnByThread.has(row.threadId)) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, {
                  turnId: row.turnId,
                  state:
                    row.state === "error"
                      ? "error"
                      : row.state === "interrupted"
                        ? "interrupted"
                        : row.state === "completed"
                          ? "completed"
                          : "running",
                  requestedAt: row.requestedAt,
                  startedAt: row.startedAt,
                  completedAt: row.completedAt,
                  assistantMessageId: row.assistantMessageId,
                  ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
                    ? {
                        sourceProposedPlan: {
                          threadId: row.sourceProposedPlanThreadId,
                          planId: row.sourceProposedPlanId,
                        },
                      }
                    : {}),
                });
              }

              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                sessionsByThread.set(row.threadId, {
                  threadId: row.threadId,
                  status: row.status,
                  providerName: row.providerName,
                  ...(row.providerInstanceId !== null
                    ? { providerInstanceId: row.providerInstanceId }
                    : {}),
                  runtimeMode: row.runtimeMode,
                  activeTurnId: row.activeTurnId,
                  lastError: row.lastError,
                  updatedAt: row.updatedAt,
                });
              }

              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows,
                { includeDeleted: true },
              );

              const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
                id: row.projectId,
                organizationId: DEFAULT_LOCAL_ORGANIZATION_ID,
                title: row.title,
                workspaceRoot: row.workspaceRoot,
                repositoryIdentity: repositoryIdentities.get(row.projectId) ?? null,
                defaultModelSelection: row.defaultModelSelection,
                scripts: row.scripts,
                browserPreviewUrl: row.browserPreviewUrl,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                deletedAt: row.deletedAt,
              }));

              const workspaceIdByThread = buildWorkspaceIdByThread({ threadRows, subChatRows });
              const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) => ({
                id: row.threadId,
                projectId: row.projectId,
                workspaceId: workspaceIdForThreadRow(row, workspaceIdByThread),
                tabGroupId: row.tabGroupId,
                tabType: row.tabType,
                title: row.title,
                modelSelection: row.modelSelection,
                runtimeMode: row.runtimeMode,
                interactionMode: row.interactionMode,
                branch: row.branch,
                worktreePath: row.worktreePath,
                latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                archivedAt: row.archivedAt,
                deletedAt: row.deletedAt,
                messages: messagesByThread.get(row.threadId) ?? [],
                proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                activities: activitiesByThread.get(row.threadId) ?? [],
                checkpoints: checkpointsByThread.get(row.threadId) ?? [],
                session: sessionsByThread.get(row.threadId) ?? null,
              }));
              const workspaces = mergeWorkspaceShells({
                concreteRows: workspaceRows,
                legacyWorkspaces: buildLegacyWorkspaceShells({
                  projectRows,
                  threadRows,
                  includeArchivedThreads: true,
                }),
                includeArchived: true,
              });

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                organizations: [
                  buildLegacyOrganizationShell({
                    projectRows,
                    updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
                  }),
                ],
                projects,
                workspaces,
                workspaceActions: workspaceActionRows.map(mapWorkspaceActionRow),
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              };

              return yield* decodeReadModel(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getCommandReadModel: ProjectionSnapshotQueryShape["getCommandReadModel"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjects:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreads:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeRows",
              ),
            ),
          ),
          listWorkspaceRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listWorkspaces:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listWorkspaces:decodeRows",
              ),
            ),
          ),
          listSubChatRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listSubChats:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listSubChats:decodeRows",
              ),
            ),
          ),
          listWorkspaceActionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listWorkspaceActions:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listWorkspaceActions:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            workspaceRows,
            subChatRows,
            workspaceActionRows,
            proposedPlanRows,
            sessionRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.sync(() => {
              let updatedAt: string | null = null;
              const projects: OrchestrationProject[] = [];
              const threads: OrchestrationThread[] = [];

              for (let index = 0; index < projectRows.length; index += 1) {
                const row = projectRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
                projects.push({
                  id: row.projectId,
                  organizationId: DEFAULT_LOCAL_ORGANIZATION_ID,
                  title: row.title,
                  workspaceRoot: row.workspaceRoot,
                  defaultModelSelection: row.defaultModelSelection,
                  scripts: row.scripts,
                  browserPreviewUrl: row.browserPreviewUrl,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  deletedAt: row.deletedAt,
                });
              }
              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < workspaceRows.length; index += 1) {
                const row = workspaceRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < subChatRows.length; index += 1) {
                const row = subChatRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < workspaceActionRows.length; index += 1) {
                const row = workspaceActionRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (let index = 0; index < stateRows.length; index += 1) {
                const row = stateRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, mapLatestTurn(row));
              }
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const sessionByThread = new Map<string, OrchestrationSession>();

              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                sessionByThread.set(row.threadId, mapSessionRow(row));
              }

              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push(mapProposedPlanRow(row));
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              const workspaceIdByThread = buildWorkspaceIdByThread({ threadRows, subChatRows });

              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                threads.push({
                  id: row.threadId,
                  projectId: row.projectId,
                  workspaceId: workspaceIdForThreadRow(row, workspaceIdByThread),
                  tabGroupId: row.tabGroupId,
                  tabType: row.tabType,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  deletedAt: row.deletedAt,
                  messages: [],
                  proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                  activities: [],
                  checkpoints: [],
                  session: sessionByThread.get(row.threadId) ?? null,
                });
              }

              return {
                snapshotSequence: computeSnapshotSequence(stateRows),
                organizations: [
                  buildLegacyOrganizationShell({
                    projectRows,
                    updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
                  }),
                ],
                projects,
                workspaces: mergeWorkspaceShells({
                  concreteRows: workspaceRows,
                  legacyWorkspaces: buildLegacyWorkspaceShells({
                    projectRows,
                    threadRows,
                    includeArchivedThreads: true,
                  }),
                  includeArchived: true,
                }),
                workspaceActions: workspaceActionRows.map(mapWorkspaceActionRow),
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              } satisfies OrchestrationReadModel;
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getCommandReadModel:query")(error);
        }),
      );

  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listActiveThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listActiveWorkspaceRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listWorkspaces:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listWorkspaces:decodeRows",
              ),
            ),
          ),
          listActiveSubChatRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listSubChats:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listSubChats:decodeRows",
              ),
            ),
          ),
          listActiveWorkspaceActionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listWorkspaceActions:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listWorkspaceActions:decodeRows",
              ),
            ),
          ),
          listActiveThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listActiveLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            workspaceRows,
            subChatRows,
            workspaceActionRows,
            sessionRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              let updatedAt: string | null = null;
              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of workspaceRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of subChatRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of workspaceActionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const repositoryIdentities =
                yield* resolveRepositoryIdentitiesForProjects(projectRows);
              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              );
              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              );
              const workspaces = mergeWorkspaceShells({
                concreteRows: workspaceRows,
                legacyWorkspaces: buildLegacyWorkspaceShells({ projectRows, threadRows }),
              });
              const workspaceById = new Map(
                workspaces.map((workspace) => [workspace.id, workspace]),
              );
              const subChatById = new Map(subChatRows.map((row) => [row.subChatId, row] as const));
              const workspaceIdByThread = buildWorkspaceIdByThread({ threadRows, subChatRows });

              const projects = Arr.filterMap(projectRows, (row) =>
                row.deletedAt === null
                  ? Result.succeed(
                      mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                    )
                  : Result.failVoid,
              );
              const threads = Arr.filterMap(threadRows, (row) =>
                row.deletedAt === null
                  ? Result.succeed({
                      id: row.threadId,
                      projectId: row.projectId,
                      workspaceId: workspaceIdForThreadRow(row, workspaceIdByThread),
                      tabGroupId: row.tabGroupId,
                      tabType: row.tabType,
                      title: row.title,
                      modelSelection: row.modelSelection,
                      runtimeMode: row.runtimeMode,
                      interactionMode: row.interactionMode,
                      branch: row.branch,
                      worktreePath: row.worktreePath,
                      latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                      createdAt: row.createdAt,
                      updatedAt: row.updatedAt,
                      archivedAt: row.archivedAt,
                      session: sessionByThread.get(row.threadId) ?? null,
                      latestUserMessageAt: row.latestUserMessageAt,
                      hasPendingApprovals: row.pendingApprovalCount > 0,
                      hasPendingUserInput: row.pendingUserInputCount > 0,
                      hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                    } satisfies OrchestrationThreadShell)
                  : Result.failVoid,
              );
              const subChats = Arr.filterMap(threads, (thread) => {
                if (!thread.workspaceId) {
                  return Result.failVoid;
                }
                const workspace = workspaceById.get(thread.workspaceId);
                if (!workspace) {
                  return Result.failVoid;
                }
                const subChat = subChatById.get(SubChatId.make(thread.id));
                return Result.succeed({
                  ...thread,
                  id: thread.id,
                  organizationId: subChat?.organizationId ?? workspace.organizationId,
                  workspaceId: workspace.id,
                } satisfies OrchestrationSubChatShell);
              });

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                organizations: [
                  buildLegacyOrganizationShell({
                    projectRows,
                    updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
                  }),
                ],
                projects,
                workspaces,
                subChats,
                workspaceActions: workspaceActionRows.map(mapWorkspaceActionRow),
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              };

              return yield* decodeShellSnapshot(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:decodeShellSnapshot",
                  ),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
      );

  const getArchivedShellSnapshot: ProjectionSnapshotQueryShape["getArchivedShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listArchivedThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listArchivedWorkspaceRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listWorkspaces:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listWorkspaces:decodeRows",
              ),
            ),
          ),
          listArchivedSubChatRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listSubChats:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listSubChats:decodeRows",
              ),
            ),
          ),
          listArchivedWorkspaceActionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listWorkspaceActions:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listWorkspaceActions:decodeRows",
              ),
            ),
          ),
          listArchivedThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listArchivedLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            workspaceRows,
            subChatRows,
            workspaceActionRows,
            sessionRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              let updatedAt: string | null = null;
              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of workspaceRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of subChatRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of workspaceActionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const activeProjectIds = new Set(threadRows.map((row) => row.projectId));
              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows.filter((row) => activeProjectIds.has(row.projectId)),
              );
              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              );
              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              );
              const workspaces = mergeWorkspaceShells({
                concreteRows: workspaceRows,
                legacyWorkspaces: buildLegacyWorkspaceShells({
                  projectRows,
                  threadRows,
                  includeArchivedThreads: true,
                }),
                includeArchived: true,
              });
              const workspaceById = new Map(
                workspaces.map((workspace) => [workspace.id, workspace]),
              );
              const subChatById = new Map(subChatRows.map((row) => [row.subChatId, row] as const));
              const workspaceIdByThread = buildWorkspaceIdByThread({ threadRows, subChatRows });

              const projects = Arr.filterMap(projectRows, (row) =>
                row.deletedAt === null && activeProjectIds.has(row.projectId)
                  ? Result.succeed(
                      mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                    )
                  : Result.failVoid,
              );
              const threads = threadRows.map(
                (row): OrchestrationThreadShell => ({
                  id: row.threadId,
                  projectId: row.projectId,
                  workspaceId: workspaceIdForThreadRow(row, workspaceIdByThread),
                  tabGroupId: row.tabGroupId,
                  tabType: row.tabType,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  session: sessionByThread.get(row.threadId) ?? null,
                  latestUserMessageAt: row.latestUserMessageAt,
                  hasPendingApprovals: row.pendingApprovalCount > 0,
                  hasPendingUserInput: row.pendingUserInputCount > 0,
                  hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                }),
              );
              const subChats = Arr.filterMap(threads, (thread) => {
                if (!thread.workspaceId) {
                  return Result.failVoid;
                }
                const workspace = workspaceById.get(thread.workspaceId);
                if (!workspace) {
                  return Result.failVoid;
                }
                const subChat = subChatById.get(SubChatId.make(thread.id));
                return Result.succeed({
                  ...thread,
                  id: thread.id,
                  organizationId: subChat?.organizationId ?? workspace.organizationId,
                  workspaceId: workspace.id,
                } satisfies OrchestrationSubChatShell);
              });

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                organizations: [
                  buildLegacyOrganizationShell({
                    projectRows,
                    updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
                  }),
                ],
                projects,
                workspaces,
                subChats,
                workspaceActions: workspaceActionRows.map(mapWorkspaceActionRow),
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              };

              return yield* decodeShellSnapshot(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    "ProjectionSnapshotQuery.getArchivedShellSnapshot:decodeShellSnapshot",
                  ),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getArchivedShellSnapshot:query")(
            error,
          );
        }),
      );

  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:decodeRows",
        ),
      ),
      Effect.map((stateRows) => ({
        snapshotSequence: computeSnapshotSequence(stateRows),
      })),
    );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          Option.isNone(option)
            ? Effect.succeed(Option.none<OrchestrationProject>())
            : repositoryIdentityResolver.resolve(option.value.workspaceRoot).pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some({
                    id: option.value.projectId,
                    title: option.value.title,
                    workspaceRoot: option.value.workspaceRoot,
                    repositoryIdentity,
                    defaultModelSelection: option.value.defaultModelSelection,
                    scripts: option.value.scripts,
                    browserPreviewUrl: option.value.browserPreviewUrl,
                    createdAt: option.value.createdAt,
                    updatedAt: option.value.updatedAt,
                    deletedAt: option.value.deletedAt,
                  } satisfies OrchestrationProject),
                ),
              ),
        ),
      );

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getActiveProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        Option.isNone(option)
          ? Effect.succeed(Option.none<OrchestrationProjectShell>())
          : repositoryIdentityResolver
              .resolve(option.value.workspaceRoot)
              .pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some(mapProjectShellRow(option.value, repositoryIdentity)),
                ),
              ),
      ),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* listCheckpointRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
          ),
        ),
      );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map(
          (row): OrchestrationCheckpointSummary => ({
            turnId: row.turnId,
            checkpointTurnCount: row.checkpointTurnCount,
            checkpointRef: row.checkpointRef,
            baselineCheckpointRef: row.baselineCheckpointRef,
            status: row.status,
            files: row.files,
            assistantMessageId: row.assistantMessageId,
            completedAt: row.completedAt,
          }),
        ),
      });
    });

  const getFullThreadDiffContext: NonNullable<
    ProjectionSnapshotQueryShape["getFullThreadDiffContext"]
  > = (threadId, toTurnCount) =>
    Effect.gen(function* () {
      const row = yield* getFullThreadDiffContextRow({
        threadId,
        checkpointTurnCount: toTurnCount,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFullThreadDiffContext:query",
            "ProjectionSnapshotQuery.getFullThreadDiffContext:decodeRow",
          ),
        ),
      );
      if (Option.isNone(row)) {
        return Option.none<ProjectionFullThreadDiffContext>();
      }

      return Option.some({
        threadId: row.value.threadId,
        projectId: row.value.projectId,
        workspaceRoot: row.value.workspaceRoot,
        worktreePath: row.value.worktreePath,
        latestCheckpointTurnCount: row.value.latestCheckpointTurnCount ?? 0,
        toCheckpointRef: row.value.toCheckpointRef,
      });
    });

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (
    threadId,
    options,
  ) =>
    Effect.gen(function* () {
      const readThreadRow =
        options?.includeArchived === true ? getThreadRowById : getActiveThreadRowById;
      const [threadRow, latestTurnRow, sessionRow] = yield* Effect.all([
        readThreadRow({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
              "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
              "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThreadShell>();
      }

      return Option.some({
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceId: legacyWorkspaceIdForThread({
          projectId: threadRow.value.projectId,
          worktreePath: threadRow.value.worktreePath,
        }),
        tabGroupId: threadRow.value.tabGroupId,
        tabType: threadRow.value.tabType,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
        latestUserMessageAt: threadRow.value.latestUserMessageAt,
        hasPendingApprovals: threadRow.value.pendingApprovalCount > 0,
        hasPendingUserInput: threadRow.value.pendingUserInputCount > 0,
        hasActionableProposedPlan: threadRow.value.hasActionableProposedPlan > 0,
      } satisfies OrchestrationThreadShell);
    });

  const getWorkspaceShellById: ProjectionSnapshotQueryShape["getWorkspaceShellById"] = (
    workspaceId,
    options,
  ) =>
    Effect.gen(function* () {
      const workspaceRow = yield* getWorkspaceRowById({ workspaceId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getWorkspaceShellById:getWorkspace:query",
            "ProjectionSnapshotQuery.getWorkspaceShellById:getWorkspace:decodeRow",
          ),
        ),
      );
      if (Option.isSome(workspaceRow)) {
        if (
          workspaceRow.value.deletedAt !== null ||
          (workspaceRow.value.archivedAt !== null && options?.includeArchived !== true)
        ) {
          return Option.none<OrchestrationWorkspaceShell>();
        }
        return Option.some({
          id: workspaceRow.value.workspaceId,
          organizationId: workspaceRow.value.organizationId,
          projectId: workspaceRow.value.projectId,
          title: workspaceRow.value.title,
          cwd: workspaceRow.value.cwd,
          branch: workspaceRow.value.branch,
          worktreePath: workspaceRow.value.worktreePath,
          baseBranch: workspaceRow.value.baseBranch,
          mode: workspaceRow.value.mode,
          status: workspaceRow.value.status,
          defaultSubChatId: workspaceRow.value.defaultSubChatId,
          browserPreviewUrl: workspaceRow.value.browserPreviewUrl,
          createdAt: workspaceRow.value.createdAt,
          updatedAt: workspaceRow.value.updatedAt,
          archivedAt: workspaceRow.value.archivedAt,
        } satisfies OrchestrationWorkspaceShell);
      }

      const [projectRows, threadRows] = yield* Effect.all([
        listProjectRows(undefined).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getWorkspaceShellById:listProjects:query",
              "ProjectionSnapshotQuery.getWorkspaceShellById:listProjects:decodeRows",
            ),
          ),
        ),
        listThreadRows(undefined).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getWorkspaceShellById:listThreads:query",
              "ProjectionSnapshotQuery.getWorkspaceShellById:listThreads:decodeRows",
            ),
          ),
        ),
      ]);
      const legacyWorkspace =
        buildLegacyWorkspaceShells({
          projectRows,
          threadRows,
          includeArchivedThreads: options?.includeArchived === true,
        }).find((workspace) => workspace.id === workspaceId) ?? null;
      return legacyWorkspace === null
        ? Option.none<OrchestrationWorkspaceShell>()
        : Option.some(legacyWorkspace);
    });

  const getWorkspaceShellByThreadId: ProjectionSnapshotQueryShape["getWorkspaceShellByThreadId"] = (
    threadId,
    options,
  ) =>
    Effect.gen(function* () {
      const readThreadRow =
        options?.includeArchived === true ? getThreadRowById : getActiveThreadRowById;
      const threadRow = yield* readThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getWorkspaceShellByThreadId:getThread:query",
            "ProjectionSnapshotQuery.getWorkspaceShellByThreadId:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationWorkspaceShell>();
      }

      const projectRow = yield* getActiveProjectRowById({
        projectId: threadRow.value.projectId,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getWorkspaceShellByThreadId:getProject:query",
            "ProjectionSnapshotQuery.getWorkspaceShellByThreadId:getProject:decodeRow",
          ),
        ),
      );
      if (Option.isNone(projectRow)) {
        return Option.none<OrchestrationWorkspaceShell>();
      }

      const [workspace] = buildLegacyWorkspaceShells({
        projectRows: [projectRow.value],
        threadRows: [threadRow.value],
        includeArchivedThreads: options?.includeArchived === true,
      });
      return workspace ? Option.some(workspace) : Option.none<OrchestrationWorkspaceShell>();
    });

  const getSubChatShellById: ProjectionSnapshotQueryShape["getSubChatShellById"] = (
    threadId,
    options,
  ) =>
    Effect.gen(function* () {
      const threadShell = yield* getThreadShellById(threadId, options);
      if (Option.isNone(threadShell) || threadShell.value.workspaceId === undefined) {
        return Option.none<OrchestrationSubChatShell>();
      }

      return Option.some({
        ...threadShell.value,
        id: threadShell.value.id,
        organizationId: DEFAULT_LOCAL_ORGANIZATION_ID,
        workspaceId: threadShell.value.workspaceId,
      } satisfies OrchestrationSubChatShell);
    });

  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    Effect.gen(function* () {
      const [
        threadRow,
        messageRows,
        proposedPlanRows,
        activityRows,
        checkpointRows,
        latestTurnRow,
        sessionRow,
      ] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeRow",
            ),
          ),
        ),
        listThreadMessageRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:decodeRows",
            ),
          ),
        ),
        listThreadProposedPlanRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:decodeRows",
            ),
          ),
        ),
        listThreadActivityRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:decodeRows",
            ),
          ),
        ),
        listCheckpointRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:decodeRows",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThread>();
      }

      const thread = {
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceId: legacyWorkspaceIdForThread({
          projectId: threadRow.value.projectId,
          worktreePath: threadRow.value.worktreePath,
        }),
        tabGroupId: threadRow.value.tabGroupId,
        tabType: threadRow.value.tabType,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        deletedAt: null,
        messages: messageRows.map((row) => {
          const message = {
            id: row.messageId,
            role: row.role,
            text: row.text,
            turnId: row.turnId,
            streaming: row.isStreaming === 1,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
          if (row.attachments !== null) {
            return Object.assign(message, { attachments: row.attachments });
          }
          return message;
        }),
        proposedPlans: proposedPlanRows.map(mapProposedPlanRow),
        activities: activityRows.map((row) => {
          const activity = {
            id: row.activityId,
            tone: row.tone,
            kind: row.kind,
            summary: row.summary,
            payload: row.payload,
            turnId: row.turnId,
            createdAt: row.createdAt,
          };
          if (row.sequence !== null) {
            return Object.assign(activity, { sequence: row.sequence });
          }
          return activity;
        }),
        checkpoints: checkpointRows.map((row) => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          baselineCheckpointRef: row.baselineCheckpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
        })),
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
      };

      return Option.some(
        yield* decodeThread(thread).pipe(
          Effect.mapError(
            toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadDetailById:decodeThread"),
          ),
        ),
      );
    });

  return {
    getCommandReadModel,
    getSnapshot,
    getShellSnapshot,
    getArchivedShellSnapshot,
    getSnapshotSequence,
    getCounts,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    getFullThreadDiffContext,
    getThreadShellById,
    getWorkspaceShellById,
    getWorkspaceShellByThreadId,
    getSubChatShellById,
    getThreadDetailById,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
