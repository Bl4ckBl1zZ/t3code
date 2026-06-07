import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const LOCAL_ORGANIZATION_ID = "local";

interface ProjectRow {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly browserPreviewUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

interface ThreadRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly modelSelectionJson: string;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly latestTurnId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
}

interface WorkspaceBackfillRow {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly title: string;
  readonly cwd: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly mode: string;
  readonly defaultSubChatId: string | null;
  readonly browserPreviewUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

function legacyWorkspaceIdForThread(input: {
  readonly projectId: string;
  readonly worktreePath: string | null;
}): string {
  const workspaceKey =
    input.worktreePath === null || input.worktreePath.trim().length === 0
      ? "primary"
      : `worktree:${Buffer.from(input.worktreePath).toString("base64url")}`;
  return `${input.projectId}:${workspaceKey}`;
}

function maxIso(left: string, right: string): string {
  return left > right ? left : right;
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_organizations (
      organization_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspaces (
      workspace_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      base_branch TEXT,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      default_sub_chat_id TEXT,
      browser_preview_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_sub_chats (
      sub_chat_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      role TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      latest_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspace_actions (
      action_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      sub_chat_id TEXT,
      terminal_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspaces_project_status
    ON projection_workspaces(project_id, status, updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_sub_chats_workspace_updated
    ON projection_sub_chats(workspace_id, updated_at, sub_chat_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_actions_workspace_status
    ON projection_workspace_actions(workspace_id, status, updated_at)
  `;

  const projectRows = yield* sql<ProjectRow>`
    SELECT
      project_id AS "projectId",
      title,
      workspace_root AS "workspaceRoot",
      browser_preview_url AS "browserPreviewUrl",
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      deleted_at AS "deletedAt"
    FROM projection_projects
  `;
  const threadRows = yield* sql<ThreadRow>`
    SELECT
      thread_id AS "threadId",
      project_id AS "projectId",
      title,
      model_selection_json AS "modelSelectionJson",
      runtime_mode AS "runtimeMode",
      interaction_mode AS "interactionMode",
      branch,
      worktree_path AS "worktreePath",
      latest_turn_id AS "latestTurnId",
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      archived_at AS "archivedAt",
      deleted_at AS "deletedAt"
    FROM projection_threads
  `;

  const activeProjects = projectRows.filter((project) => project.deletedAt === null);
  const activeProjectById = new Map(activeProjects.map((project) => [project.projectId, project]));
  const organizationCreatedAt =
    activeProjects.map((project) => project.createdAt).toSorted()[0] ?? "1970-01-01T00:00:00.000Z";
  const organizationUpdatedAt =
    [
      ...activeProjects.map((project) => project.updatedAt),
      ...threadRows.map((thread) => thread.updatedAt),
    ]
      .toSorted()
      .at(-1) ?? organizationCreatedAt;

  yield* sql`
    INSERT INTO projection_organizations (
      organization_id,
      title,
      created_at,
      updated_at,
      archived_at,
      deleted_at
    )
    VALUES (
      ${LOCAL_ORGANIZATION_ID},
      'Local',
      ${organizationCreatedAt},
      ${organizationUpdatedAt},
      NULL,
      NULL
    )
    ON CONFLICT(organization_id) DO UPDATE SET
      title = excluded.title,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at
  `;

  const workspaces = new Map<string, WorkspaceBackfillRow>();

  for (const project of activeProjects) {
    const workspaceId = legacyWorkspaceIdForThread({
      projectId: project.projectId,
      worktreePath: null,
    });
    workspaces.set(workspaceId, {
      workspaceId,
      projectId: project.projectId,
      title: "main",
      cwd: project.workspaceRoot,
      branch: null,
      worktreePath: null,
      mode: "local",
      defaultSubChatId: null,
      browserPreviewUrl: project.browserPreviewUrl,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      archivedAt: null,
    });
  }

  // BACKWARD COMPATIBILITY: Existing thread rows become workspace-owned sub-chats
  // until first-class workspace/sub-chat commands replace the legacy projection.
  for (const thread of threadRows) {
    const project = activeProjectById.get(thread.projectId);
    if (!project || thread.deletedAt !== null) {
      continue;
    }
    const workspaceId = legacyWorkspaceIdForThread({
      projectId: thread.projectId,
      worktreePath: thread.worktreePath,
    });
    const existing = workspaces.get(workspaceId);
    const fallbackTitle =
      thread.worktreePath?.split(/[\\/]/u).at(-1) ??
      (thread.worktreePath === null ? "main" : "worktree");
    const workspace: WorkspaceBackfillRow = {
      workspaceId,
      projectId: thread.projectId,
      title: thread.worktreePath === null ? "main" : (thread.branch ?? fallbackTitle),
      cwd: thread.worktreePath ?? project.workspaceRoot,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      mode: thread.worktreePath === null ? "local" : "worktree",
      defaultSubChatId: thread.archivedAt === null ? thread.threadId : null,
      browserPreviewUrl: project.browserPreviewUrl,
      createdAt: thread.worktreePath === null ? project.createdAt : thread.createdAt,
      updatedAt: thread.updatedAt,
      archivedAt: thread.archivedAt,
    };
    workspaces.set(
      workspaceId,
      existing
        ? {
            ...existing,
            branch: existing.branch ?? workspace.branch,
            defaultSubChatId: existing.defaultSubChatId ?? workspace.defaultSubChatId,
            updatedAt: maxIso(existing.updatedAt, workspace.updatedAt),
            archivedAt:
              existing.archivedAt === null || workspace.archivedAt === null
                ? null
                : maxIso(existing.archivedAt, workspace.archivedAt),
          }
        : workspace,
    );
  }

  for (const workspace of workspaces.values()) {
    yield* sql`
      INSERT INTO projection_workspaces (
        workspace_id,
        organization_id,
        project_id,
        title,
        cwd,
        branch,
        worktree_path,
        base_branch,
        mode,
        status,
        default_sub_chat_id,
        browser_preview_url,
        created_at,
        updated_at,
        archived_at,
        deleted_at
      )
      VALUES (
        ${workspace.workspaceId},
        ${LOCAL_ORGANIZATION_ID},
        ${workspace.projectId},
        ${workspace.title},
        ${workspace.cwd},
        ${workspace.branch},
        ${workspace.worktreePath},
        NULL,
        ${workspace.mode},
        'ready',
        ${workspace.defaultSubChatId},
        ${workspace.browserPreviewUrl},
        ${workspace.createdAt},
        ${workspace.updatedAt},
        ${workspace.archivedAt},
        NULL
      )
      ON CONFLICT(workspace_id) DO UPDATE SET
        title = excluded.title,
        cwd = excluded.cwd,
        branch = excluded.branch,
        worktree_path = excluded.worktree_path,
        mode = excluded.mode,
        status = excluded.status,
        default_sub_chat_id = excluded.default_sub_chat_id,
        browser_preview_url = excluded.browser_preview_url,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at,
        deleted_at = excluded.deleted_at
    `;
  }

  for (const thread of threadRows) {
    if (thread.deletedAt !== null || !activeProjectById.has(thread.projectId)) {
      continue;
    }
    const workspaceId = legacyWorkspaceIdForThread({
      projectId: thread.projectId,
      worktreePath: thread.worktreePath,
    });
    yield* sql`
      INSERT INTO projection_sub_chats (
        sub_chat_id,
        workspace_id,
        organization_id,
        project_id,
        title,
        role,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        latest_turn_id,
        created_at,
        updated_at,
        archived_at,
        deleted_at
      )
      VALUES (
        ${thread.threadId},
        ${workspaceId},
        ${LOCAL_ORGANIZATION_ID},
        ${thread.projectId},
        ${thread.title},
        'agent',
        ${thread.modelSelectionJson},
        ${thread.runtimeMode},
        ${thread.interactionMode},
        ${thread.latestTurnId},
        ${thread.createdAt},
        ${thread.updatedAt},
        ${thread.archivedAt},
        NULL
      )
      ON CONFLICT(sub_chat_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        title = excluded.title,
        model_selection_json = excluded.model_selection_json,
        runtime_mode = excluded.runtime_mode,
        interaction_mode = excluded.interaction_mode,
        latest_turn_id = excluded.latest_turn_id,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at,
        deleted_at = excluded.deleted_at
    `;
  }
});
