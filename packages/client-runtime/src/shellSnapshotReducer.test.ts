import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_LOCAL_ORGANIZATION_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceActionId,
  WorkspaceId,
} from "@t3tools/contracts";
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@t3tools/contracts";

import { applyShellStreamEvent } from "./shellSnapshotReducer.ts";

const baseSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 0,
  projects: [],
  threads: [],
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const stubProject = {
  id: ProjectId.make("project-1"),
  title: "Test Project",
  workspaceRoot: "/workspace/test",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
} as const;

const stubThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  session: null,
} as const;

const stubWorkspace = {
  id: WorkspaceId.make("project-1:primary"),
  organizationId: DEFAULT_LOCAL_ORGANIZATION_ID,
  projectId: ProjectId.make("project-1"),
  title: "main",
  cwd: "/workspace/test",
  branch: null,
  worktreePath: null,
  baseBranch: null,
  mode: "local" as const,
  status: "ready" as const,
  defaultSubChatId: ThreadId.make("thread-1"),
  browserPreviewUrl: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
} as const;

const stubSubChat = {
  ...stubThread,
  workspaceId: stubWorkspace.id,
  organizationId: DEFAULT_LOCAL_ORGANIZATION_ID,
} as const;

const stubWorkspaceAction = {
  id: WorkspaceActionId.make("action-1"),
  organizationId: DEFAULT_LOCAL_ORGANIZATION_ID,
  projectId: ProjectId.make("project-1"),
  workspaceId: stubWorkspace.id,
  subChatId: ThreadId.make("thread-1"),
  terminalId: null,
  kind: "script.run",
  title: "Run tests",
  status: "running" as const,
  source: "script" as const,
  createdAt: "2026-04-01T00:00:00.000Z",
  startedAt: "2026-04-01T00:00:00.000Z",
  completedAt: null,
  updatedAt: "2026-04-01T00:00:00.000Z",
} as const;

describe("applyShellStreamEvent", () => {
  describe("project-upserted", () => {
    it("adds a new project", () => {
      const event: OrchestrationShellStreamEvent = {
        kind: "project-upserted",
        sequence: 1,
        project: stubProject,
      };

      const next = applyShellStreamEvent(baseSnapshot, event);

      expect(next.projects).toHaveLength(1);
      expect(next.projects[0]?.id).toBe("project-1");
      expect(next.snapshotSequence).toBe(1);
    });

    it("updates an existing project", () => {
      const snapshotWithProject: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        projects: [stubProject],
      };

      const updatedProject = { ...stubProject, title: "Updated Title" };
      const event: OrchestrationShellStreamEvent = {
        kind: "project-upserted",
        sequence: 2,
        project: updatedProject,
      };

      const next = applyShellStreamEvent(snapshotWithProject, event);

      expect(next.projects).toHaveLength(1);
      expect(next.projects[0]?.title).toBe("Updated Title");
      expect(next.snapshotSequence).toBe(2);
    });
  });

  describe("project-removed", () => {
    it("removes a project by id", () => {
      const snapshotWithProject: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        projects: [stubProject],
      };

      const event: OrchestrationShellStreamEvent = {
        kind: "project-removed",
        sequence: 3,
        projectId: ProjectId.make("project-1"),
      };

      const next = applyShellStreamEvent(snapshotWithProject, event);

      expect(next.projects).toHaveLength(0);
      expect(next.snapshotSequence).toBe(3);
    });
  });

  describe("workspace-upserted", () => {
    it("adds and updates a workspace", () => {
      const added = applyShellStreamEvent(baseSnapshot, {
        kind: "workspace-upserted",
        sequence: 4,
        workspace: stubWorkspace,
      });
      const updated = applyShellStreamEvent(added, {
        kind: "workspace-upserted",
        sequence: 5,
        workspace: { ...stubWorkspace, title: "feature/sidebar" },
      });

      expect(added.workspaces).toHaveLength(1);
      expect(updated.workspaces).toHaveLength(1);
      expect(updated.workspaces?.[0]?.title).toBe("feature/sidebar");
      expect(updated.snapshotSequence).toBe(5);
    });
  });

  describe("workspace-removed", () => {
    it("removes a workspace by id", () => {
      const next = applyShellStreamEvent(
        { ...baseSnapshot, workspaces: [stubWorkspace] },
        {
          kind: "workspace-removed",
          sequence: 6,
          workspaceId: stubWorkspace.id,
        },
      );

      expect(next.workspaces).toHaveLength(0);
      expect(next.snapshotSequence).toBe(6);
    });
  });

  describe("workspace-action-upserted", () => {
    it("adds and updates a workspace action", () => {
      const added = applyShellStreamEvent(baseSnapshot, {
        kind: "workspace-action-upserted",
        sequence: 7,
        action: stubWorkspaceAction,
      });
      const updated = applyShellStreamEvent(added, {
        kind: "workspace-action-upserted",
        sequence: 8,
        action: { ...stubWorkspaceAction, status: "completed" },
      });

      expect(added.workspaceActions).toHaveLength(1);
      expect(updated.workspaceActions).toHaveLength(1);
      expect(updated.workspaceActions?.[0]?.status).toBe("completed");
    });
  });

  describe("workspace-action-removed", () => {
    it("removes a workspace action by id", () => {
      const next = applyShellStreamEvent(
        { ...baseSnapshot, workspaceActions: [stubWorkspaceAction] },
        {
          kind: "workspace-action-removed",
          sequence: 9,
          actionId: stubWorkspaceAction.id,
        },
      );

      expect(next.workspaceActions).toHaveLength(0);
      expect(next.snapshotSequence).toBe(9);
    });
  });

  describe("thread-upserted", () => {
    it("adds a new thread", () => {
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 4,
        thread: stubThread,
      };

      const next = applyShellStreamEvent(baseSnapshot, event);

      expect(next.threads).toHaveLength(1);
      expect(next.threads[0]?.id).toBe("thread-1");
      expect(next.snapshotSequence).toBe(4);
    });

    it("updates an existing thread", () => {
      const snapshotWithThread: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        threads: [stubThread],
      };

      const updatedThread = { ...stubThread, title: "Updated Thread" };
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 5,
        thread: updatedThread,
      };

      const next = applyShellStreamEvent(snapshotWithThread, event);

      expect(next.threads).toHaveLength(1);
      expect(next.threads[0]?.title).toBe("Updated Thread");
    });
  });

  describe("sub-chat-upserted", () => {
    it("adds and updates a sub-chat", () => {
      const added = applyShellStreamEvent(baseSnapshot, {
        kind: "sub-chat-upserted",
        sequence: 10,
        subChat: stubSubChat,
      });
      const updated = applyShellStreamEvent(added, {
        kind: "sub-chat-upserted",
        sequence: 11,
        subChat: { ...stubSubChat, title: "Review implementation" },
      });

      expect(added.subChats).toHaveLength(1);
      expect(updated.subChats).toHaveLength(1);
      expect(updated.subChats?.[0]?.title).toBe("Review implementation");
    });
  });

  describe("sub-chat-removed", () => {
    it("removes a sub-chat by id", () => {
      const next = applyShellStreamEvent(
        { ...baseSnapshot, subChats: [stubSubChat] },
        {
          kind: "sub-chat-removed",
          sequence: 12,
          subChatId: stubSubChat.id,
        },
      );

      expect(next.subChats).toHaveLength(0);
      expect(next.snapshotSequence).toBe(12);
    });
  });

  describe("thread-removed", () => {
    it("removes a thread by id", () => {
      const snapshotWithThread: OrchestrationShellSnapshot = {
        ...baseSnapshot,
        threads: [stubThread],
      };

      const event: OrchestrationShellStreamEvent = {
        kind: "thread-removed",
        sequence: 6,
        threadId: ThreadId.make("thread-1"),
      };

      const next = applyShellStreamEvent(snapshotWithThread, event);

      expect(next.threads).toHaveLength(0);
      expect(next.snapshotSequence).toBe(6);
    });
  });

  it("returns original snapshot for unrecognized event kinds", () => {
    const unknownEvent = { kind: "unknown-future-event", sequence: 99 } as any;
    const next = applyShellStreamEvent(baseSnapshot, unknownEvent);
    expect(next).toBe(baseSnapshot);
  });
});
