import type {
  EnvironmentId,
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationOrganizationShell,
  OrchestrationProposedPlan,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  OrchestrationSession,
  OrchestrationSessionStatus,
  OrchestrationSubChatShell,
  OrchestrationThread,
  OrchestrationThreadShell,
  OrchestrationThreadActivity,
  OrchestrationWorkspaceActionShell,
  OrchestrationWorkspaceShell,
  OrganizationId,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  WorkspaceActionId,
  WorkspaceId,
} from "@t3tools/contracts";
import {
  DEFAULT_LOCAL_ORGANIZATION_ID as DEFAULT_LOCAL_ORGANIZATION_ID_VALUE,
  isProviderDriverKind,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type { ThreadId, TurnId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { resolveModelSlugForProvider } from "@t3tools/shared/model";
import { create } from "zustand";
import {
  type ChatMessage,
  type Organization,
  type Project,
  type ProposedPlan,
  type SidebarThreadSummary,
  type SubChatShell,
  type Thread,
  type ThreadSession,
  type ThreadShell,
  type ThreadTurnState,
  type TurnDiffSummary,
  type Workspace,
  type WorkspaceAction,
} from "./types";
import { resolveEnvironmentHttpUrl } from "./environments/runtime";
import { sanitizeThreadErrorMessage } from "./rpc/transportError";
import { getThreadFromEnvironmentState } from "./threadDerivation";
const isProviderDriverKindValue = Schema.is(ProviderDriverKind);

export interface EnvironmentState {
  organizationIds: OrganizationId[];
  organizationById: Record<OrganizationId, Organization>;
  projectIdsByOrganizationId: Record<OrganizationId, ProjectId[]>;

  projectIds: ProjectId[];
  projectById: Record<ProjectId, Project>;
  workspaceIdsByProjectId: Record<ProjectId, WorkspaceId[]>;
  workspaceById: Record<WorkspaceId, Workspace>;
  subChatIdsByWorkspaceId: Record<WorkspaceId, ThreadId[]>;
  subChatShellById: Record<ThreadId, SubChatShell>;
  workspaceActionIdsByWorkspaceId: Record<WorkspaceId, WorkspaceActionId[]>;
  workspaceActionById: Record<WorkspaceActionId, WorkspaceAction>;

  // TODO(CLIENT-RUNTIME MIGRATION - DO NOT EXPAND THIS WEB-ONLY COPY):
  // Web still stores shell snapshots and thread details in this denormalized
  // Zustand shape. Mobile uses createShellSnapshotManager and
  // createThreadDetailManager from @t3tools/client-runtime. New shared behavior
  // belongs in those managers/reducers, with a web adapter layered on top.
  //
  // ---------------------------------------------------------------------------
  // Thread bookkeeping — written by BOTH shell stream and detail stream.
  // Both streams ensure the thread is registered here; the bookkeeping is
  // additive (append-only IDs) so concurrent writes are safe.
  // ---------------------------------------------------------------------------
  threadIds: ThreadId[];
  threadIdsByProjectId: Record<ProjectId, ThreadId[]>;

  // ---------------------------------------------------------------------------
  // Thread shell / session / turn — written by BOTH shell stream and detail
  // stream.  The shell stream is the *authoritative* source (server pre-
  // computes these from the projection pipeline), but the detail stream also
  // writes them so the active thread has up-to-date state even if the shell
  // event hasn't arrived yet.  Structural equality checks in both write
  // functions prevent unnecessary React re-renders when both streams deliver
  // equivalent data.
  // ---------------------------------------------------------------------------
  threadShellById: Record<ThreadId, ThreadShell>;
  threadSessionById: Record<ThreadId, ThreadSession | null>;
  threadTurnStateById: Record<ThreadId, ThreadTurnState>;

  // ---------------------------------------------------------------------------
  // Thread detail content — written ONLY by the detail stream
  // (writeThreadState / syncServerThreadDetail).  The shell stream never
  // touches these.
  // ---------------------------------------------------------------------------
  messageIdsByThreadId: Record<ThreadId, MessageId[]>;
  messageByThreadId: Record<ThreadId, Record<MessageId, ChatMessage>>;
  activityIdsByThreadId: Record<ThreadId, string[]>;
  activityByThreadId: Record<ThreadId, Record<string, OrchestrationThreadActivity>>;
  proposedPlanIdsByThreadId: Record<ThreadId, string[]>;
  proposedPlanByThreadId: Record<ThreadId, Record<string, ProposedPlan>>;
  turnDiffIdsByThreadId: Record<ThreadId, TurnId[]>;
  turnDiffSummaryByThreadId: Record<ThreadId, Record<TurnId, TurnDiffSummary>>;

  // ---------------------------------------------------------------------------
  // Sidebar summary — written ONLY by the shell stream
  // (writeThreadShellState / mapThreadShell).  Pre-computed server-side with
  // fields like latestUserMessageAt, hasPendingApprovals, etc.  The detail
  // stream must NOT write here; the shell stream is the single source of
  // truth for sidebar data.
  // ---------------------------------------------------------------------------
  sidebarThreadSummaryById: Record<ThreadId, SidebarThreadSummary>;

  bootstrapComplete: boolean;
}

export interface AppState {
  activeEnvironmentId: EnvironmentId | null;
  environmentStateById: Record<string, EnvironmentState>;
}

const initialEnvironmentState: EnvironmentState = {
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
  bootstrapComplete: false,
};

const initialState: AppState = {
  activeEnvironmentId: null,
  environmentStateById: {},
};

const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;
const MAX_THREAD_PROPOSED_PLANS = 200;
const MAX_THREAD_ACTIVITIES = 500;
const EMPTY_THREAD_IDS: ThreadId[] = [];
const EMPTY_WORKSPACE_IDS: WorkspaceId[] = [];

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Accepts the open `instanceId` string carried on `ModelSelection`; malformed
// values pass through unchanged, while valid slugs use any registered alias
// table for model normalization.
function normalizeModelSelection<T extends { instanceId: string; model: string }>(selection: T): T {
  if (!isProviderDriverKind(selection.instanceId)) {
    return selection;
  }
  return {
    ...selection,
    model: resolveModelSlugForProvider(selection.instanceId, selection.model),
  };
}

function mapProjectScripts(scripts: ReadonlyArray<Project["scripts"][number]>): Project["scripts"] {
  return scripts.map((script) => ({ ...script }));
}

function mapSession(session: OrchestrationSession): ThreadSession {
  return {
    provider: toLegacyProvider(session.providerName),
    providerInstanceId: session.providerInstanceId ?? undefined,
    status: toLegacySessionStatus(session.status),
    orchestrationStatus: session.status,
    activeTurnId: session.activeTurnId ?? undefined,
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    ...(session.lastError ? { lastError: session.lastError } : {}),
  };
}

function mapMessage(environmentId: EnvironmentId, message: OrchestrationMessage): ChatMessage {
  const attachments = message.attachments?.map((attachment) => ({
    type: "image" as const,
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: resolveEnvironmentHttpUrl({
      environmentId,
      pathname: attachmentPreviewRoutePath(attachment.id),
    }),
  }));

  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId,
    createdAt: message.createdAt,
    streaming: message.streaming,
    ...(message.streaming ? {} : { completedAt: message.updatedAt }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

function mapProposedPlan(proposedPlan: OrchestrationProposedPlan): ProposedPlan {
  return {
    id: proposedPlan.id,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
  };
}

function mapTurnDiffSummary(checkpoint: OrchestrationCheckpointSummary): TurnDiffSummary {
  return {
    turnId: checkpoint.turnId,
    completedAt: checkpoint.completedAt,
    status: checkpoint.status,
    assistantMessageId: checkpoint.assistantMessageId ?? undefined,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
    checkpointRef: checkpoint.checkpointRef,
    files: checkpoint.files.map((file) => ({ ...file })),
  };
}

function mapProject(
  project:
    | OrchestrationReadModel["projects"][number]
    | OrchestrationShellSnapshot["projects"][number],
  environmentId: EnvironmentId,
): Project {
  return {
    id: project.id,
    ...(project.organizationId !== undefined ? { organizationId: project.organizationId } : {}),
    environmentId,
    name: project.title,
    cwd: project.workspaceRoot,
    repositoryIdentity: project.repositoryIdentity ?? null,
    defaultModelSelection: project.defaultModelSelection
      ? normalizeModelSelection(project.defaultModelSelection)
      : null,
    browserPreviewUrl: project.browserPreviewUrl ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    scripts: mapProjectScripts(project.scripts),
  };
}

function mapOrganization(
  organization: OrchestrationOrganizationShell,
  environmentId: EnvironmentId,
): Organization {
  return {
    id: organization.id,
    environmentId,
    name: organization.title,
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
  };
}

function mapWorkspace(
  workspace: OrchestrationWorkspaceShell,
  environmentId: EnvironmentId,
): Workspace {
  return {
    id: workspace.id,
    organizationId: workspace.organizationId,
    projectId: workspace.projectId,
    environmentId,
    title: workspace.title,
    cwd: workspace.cwd,
    branch: workspace.branch,
    worktreePath: workspace.worktreePath,
    baseBranch: workspace.baseBranch,
    mode: workspace.mode,
    status: workspace.status,
    defaultSubChatId: workspace.defaultSubChatId,
    browserPreviewUrl: workspace.browserPreviewUrl ?? null,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    archivedAt: workspace.archivedAt,
  };
}

function mapWorkspaceAction(
  action: OrchestrationWorkspaceActionShell,
  environmentId: EnvironmentId,
): WorkspaceAction {
  return {
    id: action.id,
    organizationId: action.organizationId,
    projectId: action.projectId,
    workspaceId: action.workspaceId,
    environmentId,
    subChatId: action.subChatId,
    terminalId: action.terminalId,
    kind: action.kind,
    title: action.title,
    status: action.status,
    source: action.source,
    createdAt: action.createdAt,
    startedAt: action.startedAt,
    completedAt: action.completedAt,
    updatedAt: action.updatedAt,
  };
}

function mapThread(thread: OrchestrationThread, environmentId: EnvironmentId): Thread {
  return {
    id: thread.id,
    environmentId,
    codexThreadId: null,
    projectId: thread.projectId,
    ...(thread.workspaceId !== undefined ? { workspaceId: thread.workspaceId } : {}),
    tabGroupId: thread.tabGroupId ?? thread.id,
    tabType: thread.tabType ?? "chat",
    title: thread.title,
    modelSelection: normalizeModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    session: thread.session ? mapSession(thread.session) : null,
    messages: thread.messages.map((message) => mapMessage(environmentId, message)),
    proposedPlans: thread.proposedPlans.map(mapProposedPlan),
    error: sanitizeThreadErrorMessage(thread.session?.lastError),
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    pendingSourceProposedPlan: thread.latestTurn?.sourceProposedPlan,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    turnDiffSummaries: thread.checkpoints.map(mapTurnDiffSummary),
    activities: thread.activities.map((activity) => ({ ...activity })),
  };
}

function mapThreadShell(
  thread: OrchestrationThreadShell,
  environmentId: EnvironmentId,
): {
  shell: ThreadShell;
  session: ThreadSession | null;
  turnState: ThreadTurnState;
  summary: SidebarThreadSummary;
} {
  const shell: ThreadShell = {
    id: thread.id,
    environmentId,
    codexThreadId: null,
    projectId: thread.projectId,
    ...(thread.workspaceId !== undefined ? { workspaceId: thread.workspaceId } : {}),
    tabGroupId: thread.tabGroupId ?? thread.id,
    tabType: thread.tabType ?? "chat",
    title: thread.title,
    modelSelection: normalizeModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    error: sanitizeThreadErrorMessage(thread.session?.lastError),
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
  };
  const session = thread.session ? mapSession(thread.session) : null;
  const turnState: ThreadTurnState = {
    latestTurn: thread.latestTurn,
    pendingSourceProposedPlan: thread.latestTurn?.sourceProposedPlan,
  };
  const summary: SidebarThreadSummary = {
    id: thread.id,
    environmentId,
    projectId: thread.projectId,
    ...(thread.workspaceId !== undefined ? { workspaceId: thread.workspaceId } : {}),
    tabGroupId: thread.tabGroupId ?? thread.id,
    tabType: thread.tabType ?? "chat",
    title: thread.title,
    interactionMode: thread.interactionMode,
    session,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestUserMessageAt: thread.latestUserMessageAt,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
  };
  return {
    shell,
    session,
    turnState,
    summary,
  };
}

function mapSubChatShell(
  subChat: OrchestrationSubChatShell,
  environmentId: EnvironmentId,
): SubChatShell {
  return {
    ...mapThreadShell(subChat, environmentId).summary,
    organizationId: subChat.organizationId,
    workspaceId: subChat.workspaceId,
  };
}

function toThreadShell(thread: Thread): ThreadShell {
  return {
    id: thread.id,
    environmentId: thread.environmentId,
    codexThreadId: thread.codexThreadId,
    projectId: thread.projectId,
    ...(thread.workspaceId !== undefined ? { workspaceId: thread.workspaceId } : {}),
    tabGroupId: thread.tabGroupId ?? thread.id,
    tabType: thread.tabType ?? "chat",
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    error: thread.error,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
  };
}

function toThreadTurnState(thread: Thread): ThreadTurnState {
  return {
    latestTurn: thread.latestTurn,
    ...(thread.pendingSourceProposedPlan
      ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
      : {}),
  };
}

function sourceProposedPlansEqual(
  left: OrchestrationLatestTurn["sourceProposedPlan"] | undefined,
  right: OrchestrationLatestTurn["sourceProposedPlan"] | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return left.threadId === right.threadId && left.planId === right.planId;
}

function latestTurnsEqual(
  left: OrchestrationLatestTurn | null | undefined,
  right: OrchestrationLatestTurn | null | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return (
    left.turnId === right.turnId &&
    left.state === right.state &&
    left.requestedAt === right.requestedAt &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    left.assistantMessageId === right.assistantMessageId &&
    sourceProposedPlansEqual(left.sourceProposedPlan, right.sourceProposedPlan)
  );
}

function threadSessionsEqual(
  left: ThreadSession | null | undefined,
  right: ThreadSession | null | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return (
    left.provider === right.provider &&
    left.status === right.status &&
    left.orchestrationStatus === right.orchestrationStatus &&
    left.activeTurnId === right.activeTurnId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.lastError === right.lastError
  );
}

function sidebarThreadSummariesEqual(
  left: SidebarThreadSummary | undefined,
  right: SidebarThreadSummary,
): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.tabGroupId === right.tabGroupId &&
    left.tabType === right.tabType &&
    left.title === right.title &&
    left.interactionMode === right.interactionMode &&
    threadSessionsEqual(left.session, right.session) &&
    left.createdAt === right.createdAt &&
    left.archivedAt === right.archivedAt &&
    left.updatedAt === right.updatedAt &&
    latestTurnsEqual(left.latestTurn, right.latestTurn) &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.latestUserMessageAt === right.latestUserMessageAt &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.hasActionableProposedPlan === right.hasActionableProposedPlan
  );
}

function threadShellsEqual(left: ThreadShell | undefined, right: ThreadShell): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.environmentId === right.environmentId &&
    left.codexThreadId === right.codexThreadId &&
    left.projectId === right.projectId &&
    left.tabGroupId === right.tabGroupId &&
    left.tabType === right.tabType &&
    left.title === right.title &&
    left.modelSelection === right.modelSelection &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.error === right.error &&
    left.createdAt === right.createdAt &&
    left.archivedAt === right.archivedAt &&
    left.updatedAt === right.updatedAt &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath
  );
}

function threadTurnStatesEqual(left: ThreadTurnState | undefined, right: ThreadTurnState): boolean {
  return (
    left !== undefined &&
    latestTurnsEqual(left.latestTurn, right.latestTurn) &&
    sourceProposedPlansEqual(left.pendingSourceProposedPlan, right.pendingSourceProposedPlan)
  );
}

function appendId<T extends string>(ids: readonly T[], id: T): T[] {
  return ids.includes(id) ? [...ids] : [...ids, id];
}

function removeId<T extends string>(ids: readonly T[], id: T): T[] {
  return ids.filter((value) => value !== id);
}

function buildMessageSlice(thread: Thread): {
  ids: MessageId[];
  byId: Record<MessageId, ChatMessage>;
} {
  return {
    ids: thread.messages.map((message) => message.id),
    byId: Object.fromEntries(
      thread.messages.map((message) => [message.id, message] as const),
    ) as Record<MessageId, ChatMessage>,
  };
}

function buildActivitySlice(thread: Thread): {
  ids: string[];
  byId: Record<string, OrchestrationThreadActivity>;
} {
  return {
    ids: thread.activities.map((activity) => activity.id),
    byId: Object.fromEntries(
      thread.activities.map((activity) => [activity.id, activity] as const),
    ) as Record<string, OrchestrationThreadActivity>,
  };
}

function buildProposedPlanSlice(thread: Thread): {
  ids: string[];
  byId: Record<string, ProposedPlan>;
} {
  return {
    ids: thread.proposedPlans.map((plan) => plan.id),
    byId: Object.fromEntries(
      thread.proposedPlans.map((plan) => [plan.id, plan] as const),
    ) as Record<string, ProposedPlan>,
  };
}

function buildTurnDiffSlice(thread: Thread): {
  ids: TurnId[];
  byId: Record<TurnId, TurnDiffSummary>;
} {
  return {
    ids: thread.turnDiffSummaries.map((summary) => summary.turnId),
    byId: Object.fromEntries(
      thread.turnDiffSummaries.map((summary) => [summary.turnId, summary] as const),
    ) as Record<TurnId, TurnDiffSummary>,
  };
}

function getProjects(state: EnvironmentState): Project[] {
  return state.projectIds.flatMap((projectId) => {
    const project = state.projectById[projectId];
    return project ? [project] : [];
  });
}

function getThreads(state: EnvironmentState): Thread[] {
  return state.threadIds.flatMap((threadId) => {
    const thread = getThreadFromEnvironmentState(state, threadId);
    return thread ? [thread] : [];
  });
}

/**
 * Ensure a thread is registered in the bookkeeping indices (threadIds,
 * threadIdsByProjectId).  Shared by both the shell stream and detail stream
 * write paths — the bookkeeping is additive (append-only IDs) so concurrent
 * writes from both streams are safe.
 */
function ensureThreadRegistered(
  state: EnvironmentState,
  threadId: ThreadId,
  nextProjectId: ProjectId,
  previousProjectId: ProjectId | undefined,
): EnvironmentState {
  let nextState = state;

  if (!state.threadIds.includes(threadId)) {
    nextState = {
      ...nextState,
      threadIds: [...nextState.threadIds, threadId],
    };
  }

  if (previousProjectId !== nextProjectId) {
    let threadIdsByProjectId = nextState.threadIdsByProjectId;
    if (previousProjectId) {
      const previousIds = threadIdsByProjectId[previousProjectId] ?? EMPTY_THREAD_IDS;
      const nextIds = removeId(previousIds, threadId);
      if (nextIds.length === 0) {
        const { [previousProjectId]: _removed, ...rest } = threadIdsByProjectId;
        threadIdsByProjectId = rest as Record<ProjectId, ThreadId[]>;
      } else if (!arraysEqual(previousIds, nextIds)) {
        threadIdsByProjectId = {
          ...threadIdsByProjectId,
          [previousProjectId]: nextIds,
        };
      }
    }
    const projectThreadIds = threadIdsByProjectId[nextProjectId] ?? EMPTY_THREAD_IDS;
    const nextProjectThreadIds = appendId(projectThreadIds, threadId);
    if (!arraysEqual(projectThreadIds, nextProjectThreadIds)) {
      threadIdsByProjectId = {
        ...threadIdsByProjectId,
        [nextProjectId]: nextProjectThreadIds,
      };
    }
    if (threadIdsByProjectId !== nextState.threadIdsByProjectId) {
      nextState = {
        ...nextState,
        threadIdsByProjectId,
      };
    }
  }

  return nextState;
}

/**
 * Write thread state from the **detail stream** (per-thread subscription).
 *
 * Owns: messages, activities, proposed plans, turn diff summaries.
 * Also writes threadShellById / threadSessionById / threadTurnStateById so
 * the active thread has up-to-date state even if the shell stream event
 * hasn't arrived yet (both streams use structural equality checks to avoid
 * unnecessary re-renders when delivering equivalent data).
 * Does NOT write sidebarThreadSummaryById — that is shell-stream-only.
 */
function writeThreadState(
  state: EnvironmentState,
  nextThread: Thread,
  previousThread?: Thread,
): EnvironmentState {
  const nextShell = toThreadShell(nextThread);
  const nextTurnState = toThreadTurnState(nextThread);
  const previousShell = state.threadShellById[nextThread.id];
  const previousTurnState = state.threadTurnStateById[nextThread.id];

  let nextState = ensureThreadRegistered(
    state,
    nextThread.id,
    nextThread.projectId,
    previousThread?.projectId,
  );

  if (!threadShellsEqual(previousShell, nextShell)) {
    nextState = {
      ...nextState,
      threadShellById: {
        ...nextState.threadShellById,
        [nextThread.id]: nextShell,
      },
    };
  }

  if (!threadSessionsEqual(previousThread?.session ?? null, nextThread.session)) {
    nextState = {
      ...nextState,
      threadSessionById: {
        ...nextState.threadSessionById,
        [nextThread.id]: nextThread.session,
      },
    };
  }

  if (!threadTurnStatesEqual(previousTurnState, nextTurnState)) {
    nextState = {
      ...nextState,
      threadTurnStateById: {
        ...nextState.threadTurnStateById,
        [nextThread.id]: nextTurnState,
      },
    };
  }

  if (previousThread?.messages !== nextThread.messages) {
    const nextMessageSlice = buildMessageSlice(nextThread);
    nextState = {
      ...nextState,
      messageIdsByThreadId: {
        ...nextState.messageIdsByThreadId,
        [nextThread.id]: nextMessageSlice.ids,
      },
      messageByThreadId: {
        ...nextState.messageByThreadId,
        [nextThread.id]: nextMessageSlice.byId,
      },
    };
  }

  if (previousThread?.activities !== nextThread.activities) {
    const nextActivitySlice = buildActivitySlice(nextThread);
    nextState = {
      ...nextState,
      activityIdsByThreadId: {
        ...nextState.activityIdsByThreadId,
        [nextThread.id]: nextActivitySlice.ids,
      },
      activityByThreadId: {
        ...nextState.activityByThreadId,
        [nextThread.id]: nextActivitySlice.byId,
      },
    };
  }

  if (previousThread?.proposedPlans !== nextThread.proposedPlans) {
    const nextProposedPlanSlice = buildProposedPlanSlice(nextThread);
    nextState = {
      ...nextState,
      proposedPlanIdsByThreadId: {
        ...nextState.proposedPlanIdsByThreadId,
        [nextThread.id]: nextProposedPlanSlice.ids,
      },
      proposedPlanByThreadId: {
        ...nextState.proposedPlanByThreadId,
        [nextThread.id]: nextProposedPlanSlice.byId,
      },
    };
  }

  if (previousThread?.turnDiffSummaries !== nextThread.turnDiffSummaries) {
    const nextTurnDiffSlice = buildTurnDiffSlice(nextThread);
    nextState = {
      ...nextState,
      turnDiffIdsByThreadId: {
        ...nextState.turnDiffIdsByThreadId,
        [nextThread.id]: nextTurnDiffSlice.ids,
      },
      turnDiffSummaryByThreadId: {
        ...nextState.turnDiffSummaryByThreadId,
        [nextThread.id]: nextTurnDiffSlice.byId,
      },
    };
  }

  return nextState;
}

/**
 * Write thread state from the **shell stream** (all-threads subscription).
 *
 * Owns: sidebarThreadSummaryById (pre-computed server-side sidebar data).
 * Also writes threadShellById / threadSessionById / threadTurnStateById as
 * the authoritative source for these fields.  The detail stream may also
 * write them for the focused thread (see writeThreadState); structural
 * equality checks prevent unnecessary re-renders.
 * Does NOT write message/activity/proposedPlan/turnDiff content — that is
 * detail-stream-only.
 */
function writeThreadShellState(
  state: EnvironmentState,
  nextThread: {
    shell: ThreadShell;
    session: ThreadSession | null;
    turnState: ThreadTurnState;
    summary: SidebarThreadSummary;
  },
): EnvironmentState {
  const previousShell = state.threadShellById[nextThread.shell.id];

  let nextState = ensureThreadRegistered(
    state,
    nextThread.shell.id,
    nextThread.shell.projectId,
    previousShell?.projectId,
  );

  if (!threadShellsEqual(previousShell, nextThread.shell)) {
    nextState = {
      ...nextState,
      threadShellById: {
        ...nextState.threadShellById,
        [nextThread.shell.id]: nextThread.shell,
      },
    };
  }

  if (
    !threadSessionsEqual(state.threadSessionById[nextThread.shell.id] ?? null, nextThread.session)
  ) {
    nextState = {
      ...nextState,
      threadSessionById: {
        ...nextState.threadSessionById,
        [nextThread.shell.id]: nextThread.session,
      },
    };
  }

  if (
    !threadTurnStatesEqual(state.threadTurnStateById[nextThread.shell.id], nextThread.turnState)
  ) {
    nextState = {
      ...nextState,
      threadTurnStateById: {
        ...nextState.threadTurnStateById,
        [nextThread.shell.id]: nextThread.turnState,
      },
    };
  }

  if (
    !sidebarThreadSummariesEqual(
      state.sidebarThreadSummaryById[nextThread.shell.id],
      nextThread.summary,
    )
  ) {
    nextState = {
      ...nextState,
      sidebarThreadSummaryById: {
        ...nextState.sidebarThreadSummaryById,
        [nextThread.shell.id]: nextThread.summary,
      },
    };
  }

  return nextState;
}

function latestUserMessageAtFromThread(thread: Thread): string | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.role === "user") {
      return message.createdAt;
    }
  }
  return null;
}

function sidebarSummaryFromThread(
  thread: Thread,
  previous?: SidebarThreadSummary | undefined,
): SidebarThreadSummary {
  return {
    id: thread.id,
    environmentId: thread.environmentId,
    projectId: thread.projectId,
    ...(thread.workspaceId !== undefined ? { workspaceId: thread.workspaceId } : {}),
    tabGroupId: thread.tabGroupId ?? thread.id,
    tabType: thread.tabType ?? "chat",
    title: thread.title,
    interactionMode: thread.interactionMode,
    session: thread.session,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestUserMessageAt:
      latestUserMessageAtFromThread(thread) ?? previous?.latestUserMessageAt ?? null,
    hasPendingApprovals: previous?.hasPendingApprovals ?? false,
    hasPendingUserInput: previous?.hasPendingUserInput ?? false,
    hasActionableProposedPlan: previous?.hasActionableProposedPlan ?? false,
  };
}

function writeSubChatShellState(state: EnvironmentState, subChat: SubChatShell): EnvironmentState {
  const previousSubChat = state.subChatShellById[subChat.id];
  const subChatShellById = {
    ...state.subChatShellById,
    [subChat.id]: subChat,
  };
  let subChatIdsByWorkspaceId = state.subChatIdsByWorkspaceId;

  if (previousSubChat && previousSubChat.workspaceId !== subChat.workspaceId) {
    subChatIdsByWorkspaceId = {
      ...subChatIdsByWorkspaceId,
      [previousSubChat.workspaceId]: removeId(
        subChatIdsByWorkspaceId[previousSubChat.workspaceId] ?? [],
        subChat.id,
      ),
    };
  }

  const currentWorkspaceIds = subChatIdsByWorkspaceId[subChat.workspaceId] ?? [];
  const nextWorkspaceIds = appendId(currentWorkspaceIds, subChat.id);
  if (!arraysEqual(currentWorkspaceIds, nextWorkspaceIds)) {
    subChatIdsByWorkspaceId = {
      ...subChatIdsByWorkspaceId,
      [subChat.workspaceId]: nextWorkspaceIds,
    };
  }

  return {
    ...state,
    subChatShellById,
    subChatIdsByWorkspaceId,
  };
}

function writeOptimisticThreadShellMirror(
  state: EnvironmentState,
  thread: Thread,
): EnvironmentState {
  const summary = sidebarSummaryFromThread(thread, state.sidebarThreadSummaryById[thread.id]);
  let nextState = state;

  if (!sidebarThreadSummariesEqual(state.sidebarThreadSummaryById[thread.id], summary)) {
    nextState = {
      ...nextState,
      sidebarThreadSummaryById: {
        ...nextState.sidebarThreadSummaryById,
        [thread.id]: summary,
      },
    };
  }

  if (thread.workspaceId === undefined) {
    return nextState;
  }

  const workspace = nextState.workspaceById[thread.workspaceId];
  return writeSubChatShellState(nextState, {
    ...summary,
    organizationId: workspace?.organizationId ?? DEFAULT_LOCAL_ORGANIZATION_ID_VALUE,
    workspaceId: thread.workspaceId,
  });
}

function retainThreadScopedRecord<T>(
  record: Record<ThreadId, T>,
  nextThreadIds: ReadonlySet<ThreadId>,
): Record<ThreadId, T> {
  return Object.fromEntries(
    Object.entries(record).flatMap(([threadId, value]) =>
      nextThreadIds.has(threadId as ThreadId) ? [[threadId, value] as const] : [],
    ),
  ) as Record<ThreadId, T>;
}

function removeThreadState(state: EnvironmentState, threadId: ThreadId): EnvironmentState {
  const shell = state.threadShellById[threadId];
  if (!shell) {
    return state;
  }

  const nextThreadIds = removeId(state.threadIds, threadId);
  const currentProjectThreadIds = state.threadIdsByProjectId[shell.projectId] ?? EMPTY_THREAD_IDS;
  const nextProjectThreadIds = removeId(currentProjectThreadIds, threadId);
  const nextThreadIdsByProjectId =
    nextProjectThreadIds.length === 0
      ? (() => {
          const { [shell.projectId]: _removed, ...rest } = state.threadIdsByProjectId;
          return rest as Record<ProjectId, ThreadId[]>;
        })()
      : {
          ...state.threadIdsByProjectId,
          [shell.projectId]: nextProjectThreadIds,
        };

  const { [threadId]: _removedShell, ...threadShellById } = state.threadShellById;
  const { [threadId]: _removedSession, ...threadSessionById } = state.threadSessionById;
  const { [threadId]: _removedTurnState, ...threadTurnStateById } = state.threadTurnStateById;
  const { [threadId]: _removedMessageIds, ...messageIdsByThreadId } = state.messageIdsByThreadId;
  const { [threadId]: _removedMessages, ...messageByThreadId } = state.messageByThreadId;
  const { [threadId]: _removedActivityIds, ...activityIdsByThreadId } = state.activityIdsByThreadId;
  const { [threadId]: _removedActivities, ...activityByThreadId } = state.activityByThreadId;
  const { [threadId]: _removedPlanIds, ...proposedPlanIdsByThreadId } =
    state.proposedPlanIdsByThreadId;
  const { [threadId]: _removedPlans, ...proposedPlanByThreadId } = state.proposedPlanByThreadId;
  const { [threadId]: _removedTurnDiffIds, ...turnDiffIdsByThreadId } = state.turnDiffIdsByThreadId;
  const { [threadId]: _removedTurnDiffs, ...turnDiffSummaryByThreadId } =
    state.turnDiffSummaryByThreadId;
  const { [threadId]: _removedSidebarSummary, ...sidebarThreadSummaryById } =
    state.sidebarThreadSummaryById;
  const subChat = state.subChatShellById[threadId];
  const { [threadId]: _removedSubChat, ...subChatShellById } = state.subChatShellById;
  const subChatIdsByWorkspaceId =
    subChat === undefined
      ? state.subChatIdsByWorkspaceId
      : {
          ...state.subChatIdsByWorkspaceId,
          [subChat.workspaceId]: removeId(
            state.subChatIdsByWorkspaceId[subChat.workspaceId] ?? [],
            threadId,
          ),
        };

  return {
    ...state,
    threadIds: nextThreadIds,
    threadIdsByProjectId: nextThreadIdsByProjectId,
    threadShellById,
    threadSessionById,
    threadTurnStateById,
    messageIdsByThreadId,
    messageByThreadId,
    activityIdsByThreadId,
    activityByThreadId,
    proposedPlanIdsByThreadId,
    proposedPlanByThreadId,
    turnDiffIdsByThreadId,
    turnDiffSummaryByThreadId,
    sidebarThreadSummaryById,
    subChatShellById,
    subChatIdsByWorkspaceId,
  };
}

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") {
    return "error" as const;
  }
  if (status === "missing") {
    return "interrupted" as const;
  }
  return "completed" as const;
}

function compareActivities(
  left: Thread["activities"][number],
  right: Thread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function buildLatestTurn(params: {
  previous: Thread["latestTurn"];
  turnId: NonNullable<Thread["latestTurn"]>["turnId"];
  state: NonNullable<Thread["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"];
  sourceProposedPlan?: Thread["pendingSourceProposedPlan"];
}): NonNullable<Thread["latestTurn"]> {
  const resolvedPlan =
    params.previous?.turnId === params.turnId
      ? params.previous.sourceProposedPlan
      : params.sourceProposedPlan;
  return {
    turnId: params.turnId,
    state: params.state,
    requestedAt: params.requestedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    assistantMessageId: params.assistantMessageId,
    ...(resolvedPlan ? { sourceProposedPlan: resolvedPlan } : {}),
  };
}

function rebindTurnDiffSummariesForAssistantMessage(
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>,
  turnId: TurnId,
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"],
): TurnDiffSummary[] {
  let changed = false;
  const nextSummaries = turnDiffSummaries.map((summary) => {
    if (summary.turnId !== turnId || summary.assistantMessageId === assistantMessageId) {
      return summary;
    }
    changed = true;
    return {
      ...summary,
      assistantMessageId: assistantMessageId ?? undefined,
    };
  });
  return changed ? nextSummaries : [...turnDiffSummaries];
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<ChatMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ChatMessage[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (
      message.turnId !== undefined &&
      message.turnId !== null &&
      retainedTurnIds.has(message.turnId)
    ) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  retainedTurnIds: ReadonlySet<string>,
): OrchestrationThreadActivity[] {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  retainedTurnIds: ReadonlySet<string>,
): ProposedPlan[] {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderDriverKind {
  if (isProviderDriverKindValue(providerName)) {
    return providerName;
  }
  return ProviderDriverKind.make("codex");
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

function updateThreadState(
  state: EnvironmentState,
  threadId: ThreadId,
  updater: (thread: Thread) => Thread,
): EnvironmentState {
  const currentThread = getThreadFromEnvironmentState(state, threadId);
  if (!currentThread) {
    return state;
  }
  const nextThread = updater(currentThread);
  if (nextThread === currentThread) {
    return state;
  }
  return writeThreadState(state, nextThread, currentThread);
}

function buildProjectState(
  projects: ReadonlyArray<Project>,
): Pick<EnvironmentState, "projectIds" | "projectById"> {
  return {
    projectIds: projects.map((project) => project.id),
    projectById: Object.fromEntries(
      projects.map((project) => [project.id, project] as const),
    ) as Record<ProjectId, Project>,
  };
}

function buildOrganizationState(
  organizations: ReadonlyArray<Organization>,
  projects: ReadonlyArray<Project>,
): Pick<EnvironmentState, "organizationIds" | "organizationById" | "projectIdsByOrganizationId"> {
  const projectIdsByOrganizationId: Record<OrganizationId, ProjectId[]> = {};
  for (const project of projects) {
    if (project.organizationId === undefined) {
      continue;
    }
    projectIdsByOrganizationId[project.organizationId] = [
      ...(projectIdsByOrganizationId[project.organizationId] ?? []),
      project.id,
    ];
  }

  return {
    organizationIds: organizations.map((organization) => organization.id),
    organizationById: Object.fromEntries(
      organizations.map((organization) => [organization.id, organization] as const),
    ) as Record<OrganizationId, Organization>,
    projectIdsByOrganizationId,
  };
}

function buildWorkspaceState(
  workspaces: ReadonlyArray<Workspace>,
): Pick<EnvironmentState, "workspaceIdsByProjectId" | "workspaceById"> {
  const workspaceIdsByProjectId: Record<ProjectId, WorkspaceId[]> = {};
  for (const workspace of workspaces) {
    workspaceIdsByProjectId[workspace.projectId] = [
      ...(workspaceIdsByProjectId[workspace.projectId] ?? []),
      workspace.id,
    ];
  }

  return {
    workspaceIdsByProjectId,
    workspaceById: Object.fromEntries(
      workspaces.map((workspace) => [workspace.id, workspace] as const),
    ) as Record<WorkspaceId, Workspace>,
  };
}

function buildSubChatState(
  subChats: ReadonlyArray<SubChatShell>,
): Pick<EnvironmentState, "subChatIdsByWorkspaceId" | "subChatShellById"> {
  const subChatIdsByWorkspaceId: Record<WorkspaceId, ThreadId[]> = {};
  for (const subChat of subChats) {
    subChatIdsByWorkspaceId[subChat.workspaceId] = [
      ...(subChatIdsByWorkspaceId[subChat.workspaceId] ?? []),
      subChat.id,
    ];
  }

  return {
    subChatIdsByWorkspaceId,
    subChatShellById: Object.fromEntries(
      subChats.map((subChat) => [subChat.id, subChat] as const),
    ) as Record<ThreadId, SubChatShell>,
  };
}

function buildWorkspaceActionState(
  actions: ReadonlyArray<WorkspaceAction>,
): Pick<EnvironmentState, "workspaceActionIdsByWorkspaceId" | "workspaceActionById"> {
  const workspaceActionIdsByWorkspaceId: Record<WorkspaceId, WorkspaceActionId[]> = {};
  for (const action of actions) {
    workspaceActionIdsByWorkspaceId[action.workspaceId] = [
      ...(workspaceActionIdsByWorkspaceId[action.workspaceId] ?? []),
      action.id,
    ];
  }

  return {
    workspaceActionIdsByWorkspaceId,
    workspaceActionById: Object.fromEntries(
      actions.map((action) => [action.id, action] as const),
    ) as Record<WorkspaceActionId, WorkspaceAction>,
  };
}

function getStoredEnvironmentState(
  state: AppState,
  environmentId: EnvironmentId,
): EnvironmentState {
  return state.environmentStateById[environmentId] ?? initialEnvironmentState;
}

function commitEnvironmentState(
  state: AppState,
  environmentId: EnvironmentId,
  nextEnvironmentState: EnvironmentState,
): AppState {
  const currentEnvironmentState = state.environmentStateById[environmentId];
  const environmentStateById =
    currentEnvironmentState === nextEnvironmentState
      ? state.environmentStateById
      : {
          ...state.environmentStateById,
          [environmentId]: nextEnvironmentState,
        };

  if (environmentStateById === state.environmentStateById) {
    return state;
  }

  return {
    ...state,
    environmentStateById,
  };
}

function syncEnvironmentShellSnapshot(
  state: EnvironmentState,
  snapshot: OrchestrationShellSnapshot,
  environmentId: EnvironmentId,
): EnvironmentState {
  const nextOrganizations = (snapshot.organizations ?? []).map((organization) =>
    mapOrganization(organization, environmentId),
  );
  const nextProjects = snapshot.projects.map((project) => mapProject(project, environmentId));
  const nextWorkspaces = (snapshot.workspaces ?? []).map((workspace) =>
    mapWorkspace(workspace, environmentId),
  );
  const nextSubChats = (snapshot.subChats ?? []).map((subChat) =>
    mapSubChatShell(subChat, environmentId),
  );
  const nextWorkspaceActions = (snapshot.workspaceActions ?? []).map((action) =>
    mapWorkspaceAction(action, environmentId),
  );
  const nextThreadIds = new Set(snapshot.threads.map((thread) => thread.id));
  let nextState: EnvironmentState = {
    ...state,
    ...buildOrganizationState(nextOrganizations, nextProjects),
    ...buildProjectState(nextProjects),
    ...buildWorkspaceState(nextWorkspaces),
    ...buildSubChatState(nextSubChats),
    ...buildWorkspaceActionState(nextWorkspaceActions),
    threadIds: [],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    sidebarThreadSummaryById: {},
    messageIdsByThreadId: retainThreadScopedRecord(state.messageIdsByThreadId, nextThreadIds),
    messageByThreadId: retainThreadScopedRecord(state.messageByThreadId, nextThreadIds),
    activityIdsByThreadId: retainThreadScopedRecord(state.activityIdsByThreadId, nextThreadIds),
    activityByThreadId: retainThreadScopedRecord(state.activityByThreadId, nextThreadIds),
    proposedPlanIdsByThreadId: retainThreadScopedRecord(
      state.proposedPlanIdsByThreadId,
      nextThreadIds,
    ),
    proposedPlanByThreadId: retainThreadScopedRecord(state.proposedPlanByThreadId, nextThreadIds),
    turnDiffIdsByThreadId: retainThreadScopedRecord(state.turnDiffIdsByThreadId, nextThreadIds),
    turnDiffSummaryByThreadId: retainThreadScopedRecord(
      state.turnDiffSummaryByThreadId,
      nextThreadIds,
    ),
    bootstrapComplete: true,
  };

  for (const thread of snapshot.threads) {
    nextState = writeThreadShellState(nextState, mapThreadShell(thread, environmentId));
  }

  return nextState;
}

export function syncServerShellSnapshot(
  state: AppState,
  snapshot: OrchestrationShellSnapshot,
  environmentId: EnvironmentId,
): AppState {
  // TODO(CLIENT-RUNTIME MIGRATION - DO NOT EXPAND THIS WEB-ONLY COPY):
  // Keep web-specific projection here only until the store can consume
  // createShellSnapshotManager or a shared adapter over its reducer.
  return commitEnvironmentState(
    state,
    environmentId,
    syncEnvironmentShellSnapshot(
      getStoredEnvironmentState(state, environmentId),
      snapshot,
      environmentId,
    ),
  );
}

export function syncServerThreadDetail(
  state: AppState,
  thread: OrchestrationThread,
  environmentId: EnvironmentId,
): AppState {
  // TODO(CLIENT-RUNTIME MIGRATION - DO NOT EXPAND THIS WEB-ONLY COPY):
  // Keep web-specific projection here only until the store can consume
  // createThreadDetailManager or a shared adapter over its reducer.
  const environmentState = getStoredEnvironmentState(state, environmentId);
  const previousThread = getThreadFromEnvironmentState(environmentState, thread.id);
  return commitEnvironmentState(
    state,
    environmentId,
    writeThreadState(environmentState, mapThread(thread, environmentId), previousThread),
  );
}

function applyEnvironmentOrchestrationEvent(
  state: EnvironmentState,
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
): EnvironmentState {
  switch (event.type) {
    case "project.created": {
      const nextProject = mapProject(
        {
          id: event.payload.projectId,
          title: event.payload.title,
          workspaceRoot: event.payload.workspaceRoot,
          repositoryIdentity: event.payload.repositoryIdentity ?? null,
          defaultModelSelection: event.payload.defaultModelSelection,
          scripts: event.payload.scripts,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          deletedAt: null,
        },
        environmentId,
      );
      const existingProjectId =
        state.projectIds.find(
          (projectId) =>
            projectId === event.payload.projectId ||
            state.projectById[projectId]?.cwd === event.payload.workspaceRoot,
        ) ?? null;
      let projectById = state.projectById;
      let projectIds = state.projectIds;

      if (existingProjectId !== null && existingProjectId !== nextProject.id) {
        const { [existingProjectId]: _removedProject, ...restProjectById } = state.projectById;
        projectById = {
          ...restProjectById,
          [nextProject.id]: nextProject,
        };
        projectIds = state.projectIds.map((projectId) =>
          projectId === existingProjectId ? nextProject.id : projectId,
        );
      } else {
        projectById = {
          ...state.projectById,
          [nextProject.id]: nextProject,
        };
        projectIds =
          existingProjectId === null && !state.projectIds.includes(nextProject.id)
            ? [...state.projectIds, nextProject.id]
            : state.projectIds;
      }

      return {
        ...state,
        projectById,
        projectIds,
      };
    }

    case "project.meta-updated": {
      const project = state.projectById[event.payload.projectId];
      if (!project) {
        return state;
      }
      const nextProject: Project = {
        ...project,
        ...(event.payload.title !== undefined ? { name: event.payload.title } : {}),
        ...(event.payload.workspaceRoot !== undefined ? { cwd: event.payload.workspaceRoot } : {}),
        ...(event.payload.repositoryIdentity !== undefined
          ? { repositoryIdentity: event.payload.repositoryIdentity ?? null }
          : {}),
        ...(event.payload.defaultModelSelection !== undefined
          ? {
              defaultModelSelection: event.payload.defaultModelSelection
                ? normalizeModelSelection(event.payload.defaultModelSelection)
                : null,
            }
          : {}),
        ...(event.payload.scripts !== undefined
          ? { scripts: mapProjectScripts(event.payload.scripts) }
          : {}),
        ...(event.payload.browserPreviewUrl !== undefined
          ? { browserPreviewUrl: event.payload.browserPreviewUrl }
          : {}),
        updatedAt: event.payload.updatedAt,
      };
      return {
        ...state,
        projectById: {
          ...state.projectById,
          [event.payload.projectId]: nextProject,
        },
      };
    }

    case "project.deleted": {
      if (!state.projectById[event.payload.projectId]) {
        return state;
      }
      const { [event.payload.projectId]: _removedProject, ...projectById } = state.projectById;
      return {
        ...state,
        projectById,
        projectIds: removeId(state.projectIds, event.payload.projectId),
      };
    }

    case "thread.created": {
      const previousThread = getThreadFromEnvironmentState(state, event.payload.threadId);
      const nextThread = mapThread(
        {
          id: event.payload.threadId,
          projectId: event.payload.projectId,
          ...(event.payload.workspaceId !== undefined
            ? { workspaceId: event.payload.workspaceId }
            : {}),
          tabGroupId: event.payload.tabGroupId ?? event.payload.threadId,
          tabType: event.payload.tabType ?? "chat",
          title: event.payload.title,
          modelSelection: event.payload.modelSelection,
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          branch: event.payload.branch,
          worktreePath: event.payload.worktreePath,
          latestTurn: null,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          archivedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
        environmentId,
      );
      return writeOptimisticThreadShellMirror(
        writeThreadState(state, nextThread, previousThread),
        nextThread,
      );
    }

    case "thread.deleted":
      return removeThreadState(state, event.payload.threadId);

    case "thread.archived":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: event.payload.archivedAt,
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.unarchived":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: null,
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.meta-updated": {
      const currentThread = getThreadFromEnvironmentState(state, event.payload.threadId);
      if (!currentThread) {
        return state;
      }
      const nextThread: Thread = {
        ...currentThread,
        ...(event.payload.tabGroupId !== undefined ? { tabGroupId: event.payload.tabGroupId } : {}),
        ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
          : {}),
        ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
        ...(event.payload.worktreePath !== undefined
          ? { worktreePath: event.payload.worktreePath }
          : {}),
        updatedAt: event.payload.updatedAt,
      };
      return writeOptimisticThreadShellMirror(
        writeThreadState(state, nextThread, currentThread),
        nextThread,
      );
    }

    case "thread.runtime-mode-set":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        runtimeMode: event.payload.runtimeMode,
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.interaction-mode-set":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        interactionMode: event.payload.interactionMode,
        updatedAt: event.payload.updatedAt,
      }));

    case "thread.turn-start-requested":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
          : {}),
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        pendingSourceProposedPlan: event.payload.sourceProposedPlan,
        updatedAt: event.occurredAt,
      }));

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const latestTurn = thread.latestTurn;
        if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
          return thread;
        }
        return {
          ...thread,
          latestTurn: buildLatestTurn({
            previous: latestTurn,
            turnId: event.payload.turnId,
            state: "interrupted",
            requestedAt: latestTurn.requestedAt,
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
            assistantMessageId: latestTurn.assistantMessageId,
          }),
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.message-sent":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const message = mapMessage(thread.environmentId, {
          id: event.payload.messageId,
          role: event.payload.role,
          text: event.payload.text,
          ...(event.payload.attachments !== undefined
            ? { attachments: event.payload.attachments }
            : {}),
          turnId: event.payload.turnId,
          streaming: event.payload.streaming,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
        });
        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id !== message.id
                ? entry
                : {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
                    ...(message.streaming
                      ? entry.completedAt !== undefined
                        ? { completedAt: entry.completedAt }
                        : {}
                      : message.completedAt !== undefined
                        ? { completedAt: message.completedAt }
                        : {}),
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  },
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);
        const turnDiffSummaries =
          event.payload.role === "assistant" && event.payload.turnId !== null
            ? rebindTurnDiffSummariesForAssistantMessage(
                thread.turnDiffSummaries,
                event.payload.turnId,
                event.payload.messageId,
              )
            : thread.turnDiffSummaries;
        const latestTurn: Thread["latestTurn"] =
          event.payload.role === "assistant" &&
          event.payload.turnId !== null &&
          (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: event.payload.streaming
                  ? "running"
                  : thread.latestTurn?.state === "interrupted"
                    ? "interrupted"
                    : thread.latestTurn?.state === "error"
                      ? "error"
                      : "completed",
                requestedAt:
                  thread.latestTurn?.turnId === event.payload.turnId
                    ? thread.latestTurn.requestedAt
                    : event.payload.createdAt,
                startedAt:
                  thread.latestTurn?.turnId === event.payload.turnId
                    ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
                    : event.payload.createdAt,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
                completedAt: event.payload.streaming
                  ? thread.latestTurn?.turnId === event.payload.turnId
                    ? (thread.latestTurn.completedAt ?? null)
                    : null
                  : event.payload.updatedAt,
                assistantMessageId: event.payload.messageId,
              })
            : thread.latestTurn;
        return {
          ...thread,
          messages: cappedMessages,
          turnDiffSummaries,
          latestTurn,
          updatedAt: event.occurredAt,
        };
      });

    case "thread.session-set": {
      const currentThread = getThreadFromEnvironmentState(state, event.payload.threadId);
      if (!currentThread) {
        return state;
      }
      const nextThread: Thread = {
        ...currentThread,
        session: mapSession(event.payload.session),
        error: sanitizeThreadErrorMessage(event.payload.session.lastError),
        latestTurn:
          event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
            ? buildLatestTurn({
                previous: currentThread.latestTurn,
                turnId: event.payload.session.activeTurnId,
                state: "running",
                requestedAt:
                  currentThread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? currentThread.latestTurn.requestedAt
                    : event.payload.session.updatedAt,
                startedAt:
                  currentThread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? (currentThread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                    : event.payload.session.updatedAt,
                completedAt: null,
                assistantMessageId:
                  currentThread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? currentThread.latestTurn.assistantMessageId
                    : null,
                sourceProposedPlan: currentThread.pendingSourceProposedPlan,
              })
            : currentThread.latestTurn,
        updatedAt: event.occurredAt,
      };
      return writeOptimisticThreadShellMirror(
        writeThreadState(state, nextThread, currentThread),
        nextThread,
      );
    }

    case "thread.session-stop-requested": {
      const currentThread = getThreadFromEnvironmentState(state, event.payload.threadId);
      if (!currentThread?.session) {
        return state;
      }
      const nextThread: Thread = {
        ...currentThread,
        session: {
          ...currentThread.session,
          status: "closed",
          orchestrationStatus: "stopped",
          activeTurnId: undefined,
          updatedAt: event.payload.createdAt,
        },
        updatedAt: event.occurredAt,
      };
      return writeOptimisticThreadShellMirror(
        writeThreadState(state, nextThread, currentThread),
        nextThread,
      );
    }

    case "thread.proposed-plan-upserted":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const proposedPlan = mapProposedPlan(event.payload.proposedPlan);
        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== proposedPlan.id),
          proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-MAX_THREAD_PROPOSED_PLANS);
        return {
          ...thread,
          proposedPlans,
          updatedAt: event.occurredAt,
        };
      });

    case "thread.turn-diff-completed":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const checkpoint = mapTurnDiffSummary({
          turnId: event.payload.turnId,
          checkpointTurnCount: event.payload.checkpointTurnCount,
          checkpointRef: event.payload.checkpointRef,
          status: event.payload.status,
          files: event.payload.files,
          assistantMessageId: event.payload.assistantMessageId,
          completedAt: event.payload.completedAt,
        });
        const existing = thread.turnDiffSummaries.find(
          (entry) => entry.turnId === checkpoint.turnId,
        );
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return thread;
        }
        const turnDiffSummaries = [
          ...thread.turnDiffSummaries.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const latestTurn =
          thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: checkpointStatusToLatestTurnState(event.payload.status),
                requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
                startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
                completedAt: event.payload.completedAt,
                assistantMessageId: event.payload.assistantMessageId,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn;
        return {
          ...thread,
          turnDiffSummaries,
          latestTurn,
          updatedAt: event.occurredAt,
        };
      });

    case "thread.reverted":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const turnDiffSummaries = thread.turnDiffSummaries
          .filter(
            (entry) =>
              entry.checkpointTurnCount !== undefined &&
              entry.checkpointTurnCount <= event.payload.turnCount,
          )
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const retainedTurnIds = new Set(turnDiffSummaries.map((entry) => entry.turnId));
        const messages = retainThreadMessagesAfterRevert(
          thread.messages,
          retainedTurnIds,
          event.payload.turnCount,
        ).slice(-MAX_THREAD_MESSAGES);
        const proposedPlans = retainThreadProposedPlansAfterRevert(
          thread.proposedPlans,
          retainedTurnIds,
        ).slice(-MAX_THREAD_PROPOSED_PLANS);
        const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
        const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;

        return {
          ...thread,
          turnDiffSummaries,
          messages,
          proposedPlans,
          activities,
          pendingSourceProposedPlan: undefined,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(
                    (latestCheckpoint.status ?? "ready") as "ready" | "missing" | "error",
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                },
          updatedAt: event.occurredAt,
        };
      });

    case "thread.activity-appended":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const activities = [
          ...thread.activities.filter((activity) => activity.id !== event.payload.activity.id),
          { ...event.payload.activity },
        ]
          .toSorted(compareActivities)
          .slice(-MAX_THREAD_ACTIVITIES);
        return {
          ...thread,
          activities,
          updatedAt: event.occurredAt,
        };
      });

    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
      return state;
  }

  return state;
}

function applyEnvironmentShellEvent(
  state: EnvironmentState,
  event: OrchestrationShellStreamEvent,
  environmentId: EnvironmentId,
): EnvironmentState {
  switch (event.kind) {
    case "project-upserted": {
      const nextProject = mapProject(event.project, environmentId);
      const existingProjectId =
        state.projectIds.find(
          (projectId) =>
            projectId === event.project.id ||
            state.projectById[projectId]?.cwd === event.project.workspaceRoot,
        ) ?? null;
      let projectById = state.projectById;
      let projectIds = state.projectIds;

      if (existingProjectId !== null && existingProjectId !== nextProject.id) {
        const { [existingProjectId]: _removedProject, ...restProjectById } = state.projectById;
        projectById = {
          ...restProjectById,
          [nextProject.id]: nextProject,
        };
        projectIds = state.projectIds.map((projectId) =>
          projectId === existingProjectId ? nextProject.id : projectId,
        );
      } else {
        projectById = {
          ...state.projectById,
          [nextProject.id]: nextProject,
        };
        projectIds =
          existingProjectId === null && !state.projectIds.includes(nextProject.id)
            ? [...state.projectIds, nextProject.id]
            : state.projectIds;
      }

      return {
        ...state,
        projectById,
        projectIds,
      };
    }
    case "project-removed": {
      if (!state.projectById[event.projectId]) {
        return state;
      }
      const { [event.projectId]: _removedProject, ...projectById } = state.projectById;
      return {
        ...state,
        projectById,
        projectIds: removeId(state.projectIds, event.projectId),
      };
    }
    case "workspace-upserted": {
      const workspace = mapWorkspace(event.workspace, environmentId);
      return {
        ...state,
        workspaceById: {
          ...state.workspaceById,
          [workspace.id]: workspace,
        },
        workspaceIdsByProjectId: {
          ...state.workspaceIdsByProjectId,
          [workspace.projectId]: appendId(
            state.workspaceIdsByProjectId[workspace.projectId] ?? [],
            workspace.id,
          ),
        },
      };
    }
    case "workspace-removed": {
      const workspace = state.workspaceById[event.workspaceId];
      if (!workspace) {
        return state;
      }
      const { [event.workspaceId]: _removedWorkspace, ...workspaceById } = state.workspaceById;
      const workspaceIds = removeId(
        state.workspaceIdsByProjectId[workspace.projectId] ?? [],
        event.workspaceId,
      );
      return {
        ...state,
        workspaceById,
        workspaceIdsByProjectId: {
          ...state.workspaceIdsByProjectId,
          [workspace.projectId]: workspaceIds,
        },
      };
    }
    case "workspace-action-upserted": {
      const action = mapWorkspaceAction(event.action, environmentId);
      return {
        ...state,
        workspaceActionById: {
          ...state.workspaceActionById,
          [action.id]: action,
        },
        workspaceActionIdsByWorkspaceId: {
          ...state.workspaceActionIdsByWorkspaceId,
          [action.workspaceId]: appendId(
            state.workspaceActionIdsByWorkspaceId[action.workspaceId] ?? [],
            action.id,
          ),
        },
      };
    }
    case "workspace-action-removed": {
      const action = state.workspaceActionById[event.actionId];
      if (!action) {
        return state;
      }
      const { [event.actionId]: _removedAction, ...workspaceActionById } =
        state.workspaceActionById;
      return {
        ...state,
        workspaceActionById,
        workspaceActionIdsByWorkspaceId: {
          ...state.workspaceActionIdsByWorkspaceId,
          [action.workspaceId]: removeId(
            state.workspaceActionIdsByWorkspaceId[action.workspaceId] ?? [],
            event.actionId,
          ),
        },
      };
    }
    case "thread-upserted":
      return writeThreadShellState(state, mapThreadShell(event.thread, environmentId));
    case "sub-chat-upserted": {
      const subChat = mapSubChatShell(event.subChat, environmentId);
      return {
        ...state,
        subChatShellById: {
          ...state.subChatShellById,
          [subChat.id]: subChat,
        },
        subChatIdsByWorkspaceId: {
          ...state.subChatIdsByWorkspaceId,
          [subChat.workspaceId]: appendId(
            state.subChatIdsByWorkspaceId[subChat.workspaceId] ?? [],
            subChat.id,
          ),
        },
      };
    }
    case "sub-chat-removed": {
      const subChat = state.subChatShellById[event.subChatId];
      if (!subChat) {
        return state;
      }
      const { [event.subChatId]: _removedSubChat, ...subChatShellById } = state.subChatShellById;
      return {
        ...state,
        subChatShellById,
        subChatIdsByWorkspaceId: {
          ...state.subChatIdsByWorkspaceId,
          [subChat.workspaceId]: removeId(
            state.subChatIdsByWorkspaceId[subChat.workspaceId] ?? [],
            event.subChatId,
          ),
        },
      };
    }
    case "thread-removed":
      return removeThreadState(state, event.threadId);
  }
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
  environmentId: EnvironmentId,
): AppState {
  if (events.length === 0) {
    return state;
  }
  const currentEnvironmentState = getStoredEnvironmentState(state, environmentId);
  const nextEnvironmentState = events.reduce(
    (nextState, event) => applyEnvironmentOrchestrationEvent(nextState, event, environmentId),
    currentEnvironmentState,
  );
  return commitEnvironmentState(state, environmentId, nextEnvironmentState);
}

function getEnvironmentEntries(
  state: AppState,
): ReadonlyArray<readonly [EnvironmentId, EnvironmentState]> {
  return Object.entries(state.environmentStateById) as unknown as ReadonlyArray<
    readonly [EnvironmentId, EnvironmentState]
  >;
}

export function selectEnvironmentState(
  state: AppState,
  environmentId: EnvironmentId | null | undefined,
): EnvironmentState {
  return environmentId ? getStoredEnvironmentState(state, environmentId) : initialEnvironmentState;
}

export function selectProjectsForEnvironment(
  state: AppState,
  environmentId: EnvironmentId | null | undefined,
): Project[] {
  return getProjects(selectEnvironmentState(state, environmentId));
}

export function selectThreadsForEnvironment(
  state: AppState,
  environmentId: EnvironmentId | null | undefined,
): Thread[] {
  return getThreads(selectEnvironmentState(state, environmentId));
}

export function selectProjectsAcrossEnvironments(state: AppState): Project[] {
  return getEnvironmentEntries(state).flatMap(([, environmentState]) =>
    getProjects(environmentState),
  );
}

export function selectThreadsAcrossEnvironments(state: AppState): Thread[] {
  return getEnvironmentEntries(state).flatMap(([, environmentState]) =>
    getThreads(environmentState),
  );
}

/** Like `selectThreadsAcrossEnvironments` but returns stable `ThreadShell` references from the store (no derived data). */
export function selectThreadShellsAcrossEnvironments(state: AppState): ThreadShell[] {
  return getEnvironmentEntries(state).flatMap(([, environmentState]) =>
    environmentState.threadIds.flatMap((threadId) => {
      const shell = environmentState.threadShellById[threadId];
      return shell ? [shell] : [];
    }),
  );
}

export function selectSidebarThreadsAcrossEnvironments(state: AppState): SidebarThreadSummary[] {
  return getEnvironmentEntries(state).flatMap(([environmentId, environmentState]) =>
    environmentState.threadIds.flatMap((threadId) => {
      const thread = environmentState.sidebarThreadSummaryById[threadId];
      return thread && thread.environmentId === environmentId ? [thread] : [];
    }),
  );
}

export function selectSidebarThreadsForProjectRef(
  state: AppState,
  ref: ScopedProjectRef | null | undefined,
): SidebarThreadSummary[] {
  if (!ref) {
    return [];
  }

  const environmentState = selectEnvironmentState(state, ref.environmentId);
  const threadIds = environmentState.threadIdsByProjectId[ref.projectId] ?? EMPTY_THREAD_IDS;
  return threadIds.flatMap((threadId) => {
    const thread = environmentState.sidebarThreadSummaryById[threadId];
    return thread ? [thread] : [];
  });
}

export function selectSidebarThreadsForProjectRefs(
  state: AppState,
  refs: readonly ScopedProjectRef[],
): SidebarThreadSummary[] {
  if (refs.length === 0) return [];
  if (refs.length === 1) return selectSidebarThreadsForProjectRef(state, refs[0]);
  return refs.flatMap((ref) => selectSidebarThreadsForProjectRef(state, ref));
}

export function selectWorkspacesForProjectRef(
  state: AppState,
  ref: ScopedProjectRef | null | undefined,
): Workspace[] {
  if (!ref) {
    return [];
  }

  const environmentState = selectEnvironmentState(state, ref.environmentId);
  const workspaceIds =
    environmentState.workspaceIdsByProjectId[ref.projectId] ?? EMPTY_WORKSPACE_IDS;
  return workspaceIds.flatMap((workspaceId) => {
    const workspace = environmentState.workspaceById[workspaceId];
    return workspace ? [workspace] : [];
  });
}

export function selectWorkspacesForProjectRefs(
  state: AppState,
  refs: readonly ScopedProjectRef[],
): Workspace[] {
  if (refs.length === 0) return [];
  if (refs.length === 1) return selectWorkspacesForProjectRef(state, refs[0]);
  return refs.flatMap((ref) => selectWorkspacesForProjectRef(state, ref));
}

export function selectBootstrapCompleteForActiveEnvironment(state: AppState): boolean {
  return selectEnvironmentState(state, state.activeEnvironmentId).bootstrapComplete;
}

export function selectProjectByRef(
  state: AppState,
  ref: ScopedProjectRef | null | undefined,
): Project | undefined {
  return ref
    ? selectEnvironmentState(state, ref.environmentId).projectById[ref.projectId]
    : undefined;
}

export function selectThreadByRef(
  state: AppState,
  ref: ScopedThreadRef | null | undefined,
): Thread | undefined {
  return ref
    ? getThreadFromEnvironmentState(selectEnvironmentState(state, ref.environmentId), ref.threadId)
    : undefined;
}

export function selectThreadExistsByRef(
  state: AppState,
  ref: ScopedThreadRef | null | undefined,
): boolean {
  return ref
    ? selectEnvironmentState(state, ref.environmentId).threadShellById[ref.threadId] !== undefined
    : false;
}

export function selectSidebarThreadSummaryByRef(
  state: AppState,
  ref: ScopedThreadRef | null | undefined,
): SidebarThreadSummary | undefined {
  return ref
    ? selectEnvironmentState(state, ref.environmentId).sidebarThreadSummaryById[ref.threadId]
    : undefined;
}

export function selectThreadIdsByProjectRef(
  state: AppState,
  ref: ScopedProjectRef | null | undefined,
): ThreadId[] {
  return ref
    ? (selectEnvironmentState(state, ref.environmentId).threadIdsByProjectId[ref.projectId] ??
        EMPTY_THREAD_IDS)
    : EMPTY_THREAD_IDS;
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  if (state.activeEnvironmentId === null) {
    return state;
  }

  const nextEnvironmentState = updateThreadState(
    getStoredEnvironmentState(state, state.activeEnvironmentId),
    threadId,
    (thread) => {
      if (thread.error === error) return thread;
      return { ...thread, error };
    },
  );
  return commitEnvironmentState(state, state.activeEnvironmentId, nextEnvironmentState);
}

export function applyOrchestrationEvent(
  state: AppState,
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
): AppState {
  return commitEnvironmentState(
    state,
    environmentId,
    applyEnvironmentOrchestrationEvent(
      getStoredEnvironmentState(state, environmentId),
      event,
      environmentId,
    ),
  );
}

export function applyShellEvent(
  state: AppState,
  event: OrchestrationShellStreamEvent,
  environmentId: EnvironmentId,
): AppState {
  return commitEnvironmentState(
    state,
    environmentId,
    applyEnvironmentShellEvent(
      getStoredEnvironmentState(state, environmentId),
      event,
      environmentId,
    ),
  );
}

export function setActiveEnvironmentId(state: AppState, environmentId: EnvironmentId): AppState {
  if (state.activeEnvironmentId === environmentId) {
    return state;
  }

  return {
    ...state,
    activeEnvironmentId: environmentId,
  };
}

export function removeEnvironmentState(state: AppState, environmentId: EnvironmentId): AppState {
  if (!state.environmentStateById[environmentId] && state.activeEnvironmentId !== environmentId) {
    return state;
  }

  const { [environmentId]: _removed, ...environmentStateById } = state.environmentStateById;
  return {
    ...state,
    activeEnvironmentId:
      state.activeEnvironmentId === environmentId ? null : state.activeEnvironmentId,
    environmentStateById,
  };
}

export function setThreadBranch(
  state: AppState,
  threadRef: ScopedThreadRef,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  const nextEnvironmentState = updateThreadState(
    getStoredEnvironmentState(state, threadRef.environmentId),
    threadRef.threadId,
    (thread) => {
      if (thread.branch === branch && thread.worktreePath === worktreePath) return thread;
      const cwdChanged = thread.worktreePath !== worktreePath;
      return {
        ...thread,
        branch,
        worktreePath,
        ...(cwdChanged ? { session: null } : {}),
      };
    },
  );
  return commitEnvironmentState(state, threadRef.environmentId, nextEnvironmentState);
}

interface AppStore extends AppState {
  setActiveEnvironmentId: (environmentId: EnvironmentId) => void;
  removeEnvironmentState: (environmentId: EnvironmentId) => void;
  syncServerShellSnapshot: (
    snapshot: OrchestrationShellSnapshot,
    environmentId: EnvironmentId,
  ) => void;
  syncServerThreadDetail: (thread: OrchestrationThread, environmentId: EnvironmentId) => void;
  applyOrchestrationEvent: (event: OrchestrationEvent, environmentId: EnvironmentId) => void;
  applyOrchestrationEvents: (
    events: ReadonlyArray<OrchestrationEvent>,
    environmentId: EnvironmentId,
  ) => void;
  applyShellEvent: (event: OrchestrationShellStreamEvent, environmentId: EnvironmentId) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (
    threadRef: ScopedThreadRef,
    branch: string | null,
    worktreePath: string | null,
  ) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...initialState,
  setActiveEnvironmentId: (environmentId) =>
    set((state) => setActiveEnvironmentId(state, environmentId)),
  removeEnvironmentState: (environmentId) =>
    set((state) => removeEnvironmentState(state, environmentId)),
  syncServerShellSnapshot: (snapshot, environmentId) =>
    set((state) => syncServerShellSnapshot(state, snapshot, environmentId)),
  syncServerThreadDetail: (thread, environmentId) =>
    set((state) => syncServerThreadDetail(state, thread, environmentId)),
  applyOrchestrationEvent: (event, environmentId) =>
    set((state) => applyOrchestrationEvent(state, event, environmentId)),
  applyOrchestrationEvents: (events, environmentId) =>
    set((state) => applyOrchestrationEvents(state, events, environmentId)),
  applyShellEvent: (event, environmentId) =>
    set((state) => applyShellEvent(state, event, environmentId)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadRef, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadRef, branch, worktreePath)),
}));
