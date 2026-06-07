import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_LOCAL_ORGANIZATION_ID,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorkspaceId,
} from "@t3tools/contracts";

import { resolveWorkspaceChatRouteRef } from "./workspaceChatRoutes";
import type { AppState, EnvironmentState } from "./store";
import { DEFAULT_INTERACTION_MODE } from "./types";
import type { SubChatShell, Workspace } from "./types";

const environmentId = EnvironmentId.make("env-local");
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const workspaceId = WorkspaceId.make("workspace-1");
const subChatId = ThreadId.make("sub-chat-1");
const now = "2026-06-07T00:00:00.000Z";

function emptyEnvironmentState(): EnvironmentState {
  return {
    organizationIds: [],
    organizationById: {},
    projectIdsByOrganizationId: {},
    projectIds: [],
    projectById: {},
    workspaceIdsByProjectId: {},
    workspaceById: {},
    subChatIdsByWorkspaceId: {},
    subChatShellById: {},
    workspaceActionIdsByWorkspaceId: {},
    workspaceActionById: {},
    threadIds: [],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
}

function makeState(): AppState {
  const workspace: Workspace = {
    id: workspaceId,
    organizationId: DEFAULT_LOCAL_ORGANIZATION_ID,
    projectId,
    environmentId,
    title: "main",
    cwd: "/repo",
    branch: null,
    worktreePath: null,
    baseBranch: null,
    mode: "local",
    status: "ready",
    defaultSubChatId: subChatId,
    browserPreviewUrl: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  const subChat: SubChatShell = {
    id: subChatId,
    environmentId,
    organizationId: DEFAULT_LOCAL_ORGANIZATION_ID,
    projectId,
    workspaceId,
    title: "Implement workspace routes",
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: now,
    archivedAt: null,
    updatedAt: now,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  const environmentState: EnvironmentState = {
    ...emptyEnvironmentState(),
    workspaceIdsByProjectId: { [projectId]: [workspaceId] },
    workspaceById: { [workspaceId]: workspace },
    subChatIdsByWorkspaceId: { [workspaceId]: [subChatId] },
    subChatShellById: { [subChatId]: subChat },
  };

  return {
    activeEnvironmentId: environmentId,
    environmentStateById: {
      [environmentId]: environmentState,
    },
  };
}

describe("resolveWorkspaceChatRouteRef", () => {
  it("resolves workspace/sub-chat params to the owning environment thread ref", () => {
    expect(
      resolveWorkspaceChatRouteRef(makeState(), {
        organizationId: DEFAULT_LOCAL_ORGANIZATION_ID,
        projectId,
        workspaceId,
        subChatId,
      }),
    ).toEqual({ environmentId, threadId: subChatId });
  });

  it("rejects params that do not match the workspace project", () => {
    expect(
      resolveWorkspaceChatRouteRef(makeState(), {
        projectId: otherProjectId,
        workspaceId,
        subChatId,
      }),
    ).toBeNull();
  });
});
