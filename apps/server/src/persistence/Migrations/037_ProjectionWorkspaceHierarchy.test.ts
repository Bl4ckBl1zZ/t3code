import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_ProjectionWorkspaceHierarchy", (it) => {
  it.effect("backfills local organization, workspaces, and sub-chats from legacy projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          browser_preview_url,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/repo/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          'http://localhost:3000',
          '2026-06-01T00:00:00.000Z',
          '2026-06-01T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-main',
            'project-1',
            'Main Chat',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-06-01T00:00:02.000Z',
            '2026-06-01T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-worktree',
            'project-1',
            'Worktree Chat',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            'feature/workspaces',
            '/repo/project-1-worktrees/feature-workspaces',
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-06-01T00:00:04.000Z',
            '2026-06-01T00:00:05.000Z',
            NULL,
            NULL
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 37 });

      const organizations = yield* sql<{ readonly organizationId: string; readonly title: string }>`
        SELECT organization_id AS "organizationId", title
        FROM projection_organizations
      `;
      const workspaces = yield* sql<{
        readonly workspaceId: string;
        readonly title: string;
        readonly cwd: string;
        readonly defaultSubChatId: string | null;
        readonly mode: string;
      }>`
        SELECT
          workspace_id AS "workspaceId",
          title,
          cwd,
          default_sub_chat_id AS "defaultSubChatId",
          mode
        FROM projection_workspaces
        ORDER BY workspace_id
      `;
      const subChats = yield* sql<{
        readonly subChatId: string;
        readonly workspaceId: string;
        readonly role: string;
      }>`
        SELECT
          sub_chat_id AS "subChatId",
          workspace_id AS "workspaceId",
          role
        FROM projection_sub_chats
        ORDER BY sub_chat_id
      `;

      const worktreeWorkspaceId = `project-1:worktree:${Buffer.from(
        "/repo/project-1-worktrees/feature-workspaces",
      ).toString("base64url")}`;

      assert.deepStrictEqual(organizations, [{ organizationId: "local", title: "Local" }]);
      assert.deepStrictEqual(workspaces, [
        {
          workspaceId: "project-1:primary",
          title: "main",
          cwd: "/repo/project-1",
          defaultSubChatId: "thread-main",
          mode: "local",
        },
        {
          workspaceId: worktreeWorkspaceId,
          title: "feature/workspaces",
          cwd: "/repo/project-1-worktrees/feature-workspaces",
          defaultSubChatId: "thread-worktree",
          mode: "worktree",
        },
      ]);
      assert.deepStrictEqual(subChats, [
        {
          subChatId: "thread-main",
          workspaceId: "project-1:primary",
          role: "agent",
        },
        {
          subChatId: "thread-worktree",
          workspaceId: worktreeWorkspaceId,
          role: "agent",
        },
      ]);
    }),
  );
});
