# Organization, Project, Workspace, And Sub-Chat Model

Status: Proposed

This spec defines the target structure for T3 Code's core work organization model:

```txt
organization
  > projects
      > workspaces
          > sub chats
              > messages / activities / plans / checkpoints / provider session
          > actions
          > terminal
```

The primary architectural change is that `workspace` becomes the operational unit. A sub-chat is only the conversational and provider-session unit inside a workspace.

## Goals

- Make the product hierarchy match how developers think about work: organization, project, workspace, then focused chats and actions.
- Stop using a thread as the owner of operational state such as worktree path, terminal sessions, git status, and script runs.
- Allow several sub-chats to collaborate against the same workspace without duplicating terminal, file, git, and dev-server context.
- Make project/workspace state explicit enough for web, desktop, browser-agent, and mobile surfaces to share the same model.
- Preserve existing thread data through a staged migration with compatibility aliases.

## Non-Goals

- This spec does not require cloud multi-tenant permissions in the first implementation.
- This spec does not remove local-only environments.
- This spec does not require multiple organizations to be visible by default in local desktop mode.
- This spec does not redesign provider runtime internals beyond moving the parent key from thread to sub-chat/workspace where appropriate.

## Current Model

The current implementation is roughly:

```txt
environment
  > projects
      > threads
          > messages
          > activities
          > proposed plans
          > checkpoints
          > provider session
          > branch/worktree metadata
          > thread-scoped terminal UI/backend state
  > cwd-addressed workspace file APIs
  > settings-backed sidebar project folders
  > standalone organization panels
```

Important current assumptions:

- `OrchestrationProject` owns `workspaceRoot`, scripts, default model selection, and preview URL.
- `OrchestrationThread` points directly to `projectId` and owns `branch`, `worktreePath`, `messages`, `activities`, `proposedPlans`, `checkpoints`, and `session`.
- Terminal contracts and backend state are keyed by `(threadId, terminalId)`.
- Workspace files are addressed by `(environmentId, cwd, relativePath)` on the client and by `cwd` on the server. There is no durable `WorkspaceId`.
- Thread tab groups are implemented as `tabGroupId` and `tabType` fields on threads.
- Organization panels use organization terminology, but they are separate from projects/workspaces/threads.

## Target Model

The target implementation is:

```txt
organization
  > projects
      > workspaces
          > sub chats
              > messages
              > activities
              > proposed plans
              > checkpoints
              > provider session
          > actions
          > terminal sessions
          > files, git state, preview state, browser context
```

### Ownership Rules

- Organization owns grouping, ordering, defaults, and future permissions.
- Project owns durable product/repository metadata and shared project defaults.
- Workspace owns execution context: `cwd`, branch/worktree, file tree, git state, dev-server preview, workspace actions, terminal sessions, and browser-agent workspace context.
- Sub-chat owns conversation context: messages, activities, proposed plans, checkpoints, provider session, model/runtime settings, approvals, and user-input prompts.
- Workspace action owns a user-visible workflow or command execution. It may be linked to a sub-chat, terminal, provider tool call, project script, git operation, or browser action.
- Terminal session belongs to a workspace. It may be referenced from a sub-chat message or action, but it is not owned by the sub-chat.

## Terminology

### Organization

An organization is the top-level container for projects. In local desktop mode, the default organization can be implicit and named "Local".

Organizations should eventually be the natural place for:

- Project grouping and ordering.
- Shared provider defaults.
- Cloud membership and permissions.
- Organization panels.
- Cross-project dashboards and generated panels.

### Project

A project represents a durable codebase, product, or repository identity. A project should not be equivalent to a single checkout path.

Project fields should include:

```ts
interface Project {
  id: ProjectId;
  organizationId: OrganizationId;
  title: string;
  repositoryIdentity: RepositoryIdentity | null;
  defaultModelSelection: ModelSelection | null;
  scripts: ProjectScript[];
  browserPreviewUrl: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
}
```

Compatibility note: current `project.workspaceRoot` should migrate to the first workspace for that project.

### Workspace

A workspace is an active checkout, worktree, branch, or operational context for a project.

Workspace fields should include:

```ts
interface Workspace {
  id: WorkspaceId;
  organizationId: OrganizationId;
  projectId: ProjectId;
  environmentId: EnvironmentId;
  title: string;
  cwd: string;
  branch: string | null;
  worktreePath: string | null;
  baseBranch: string | null;
  mode: "local" | "worktree" | "remote";
  status: "ready" | "preparing" | "error" | "archived";
  defaultSubChatId: SubChatId | null;
  browserPreviewUrl: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
}
```

Workspace responsibilities:

- Resolve the effective `cwd` for file, git, terminal, and provider execution.
- Own worktree creation and cleanup state.
- Provide the default browser-agent context for provider browser tools.
- Own workspace-level action history.
- Own terminal sessions and terminal UI layout.
- Provide a stable parent for multiple sub-chats that share files and runtime state.

### Sub-Chat

A sub-chat is the conversation and provider-session unit inside a workspace.

Sub-chat fields should include:

```ts
interface SubChat {
  id: SubChatId;
  workspaceId: WorkspaceId;
  projectId: ProjectId;
  organizationId: OrganizationId;
  title: string;
  role: "main" | "implementation" | "review" | "research" | "custom";
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  latestTurn: OrchestrationLatestTurn | null;
  session: OrchestrationSession | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
}
```

Sub-chat detail state:

```txt
sub_chat_messages
sub_chat_activities
sub_chat_proposed_plans
sub_chat_checkpoints
sub_chat_turns
sub_chat_pending_approvals
sub_chat_pending_user_inputs
sub_chat_sessions
```

Compatibility note: current `thread` can be kept as an API alias during migration, but the persisted/read-model concept should move toward `subChat`.

### Workspace Action

A workspace action is a durable, user-visible operation within a workspace.

Examples:

- Run project script.
- Git pull, sync, switch branch, create PR, merge PR.
- Prepare worktree.
- Install dependencies.
- Start dev server.
- Apply proposed plan.
- Revert checkpoint.
- Browser preview or capture.
- Terminal command run.
- Provider tool request summary.

Action fields should include:

```ts
interface WorkspaceAction {
  id: WorkspaceActionId;
  workspaceId: WorkspaceId;
  projectId: ProjectId;
  organizationId: OrganizationId;
  subChatId: SubChatId | null;
  terminalId: TerminalId | null;
  kind: string;
  title: string;
  status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  source: "user" | "provider" | "system" | "script" | "git" | "browser";
  payload: unknown;
  result: unknown;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}
```

Actions should be visible at workspace level, not buried inside a single sub-chat. When an action originates from a sub-chat, the sub-chat timeline can still render a linked activity row.

### Terminal

Terminal sessions should be keyed by `(workspaceId, terminalId)`.

```ts
interface WorkspaceTerminalSession {
  workspaceId: WorkspaceId;
  terminalId: TerminalId;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  label: string;
  hasRunningSubprocess: boolean;
  projectScript: TerminalProjectScriptContext | null;
  updatedAt: string;
}
```

Terminal history should migrate from thread-scoped files to workspace-scoped files. A compatibility reader can look for old thread history when opening a migrated workspace terminal for the first time.

## Contract Changes

### New IDs

Add shared branded IDs in `packages/contracts/src/baseSchemas.ts` or a focused contract module:

```ts
OrganizationId;
WorkspaceId;
SubChatId;
WorkspaceActionId;
TerminalId;
```

`ThreadId` should remain available during migration. Long term, either:

- Alias `ThreadId` to `SubChatId` for wire compatibility, or
- Introduce `SubChatId` and keep `ThreadId` only for legacy decoding.

### Orchestration Read Models

Target shell snapshot:

```ts
interface OrchestrationShellSnapshot {
  snapshotSequence: number;
  organizations: OrganizationShell[];
  projects: ProjectShell[];
  workspaces: WorkspaceShell[];
  subChats: SubChatShell[];
  workspaceActions: WorkspaceActionShell[];
  updatedAt: string;
}
```

Target detail subscriptions:

```txt
subscribeOrganization(organizationId)
subscribeProject(projectId)
subscribeWorkspace(workspaceId)
subscribeSubChat(subChatId)
```

Initial implementation can keep `subscribeShell` and `subscribeThread` while adding workspace/sub-chat projections. The UI should switch to workspace/sub-chat selectors before legacy APIs are removed.

### Commands

New or renamed commands:

```txt
organization.create
organization.meta.update
organization.archive

project.create
project.meta.update
project.archive
project.delete

workspace.create
workspace.prepare-worktree
workspace.meta.update
workspace.archive
workspace.delete
workspace.action.start
workspace.action.cancel
workspace.action.complete

sub-chat.create
sub-chat.meta.update
sub-chat.archive
sub-chat.delete
sub-chat.turn.start
sub-chat.turn.interrupt
sub-chat.approval.respond
sub-chat.user-input.respond
sub-chat.checkpoint.revert
sub-chat.session.stop
```

Backward-compatible command aliases:

```txt
thread.create -> sub-chat.create with bootstrap workspace fallback
thread.turn.start -> sub-chat.turn.start
thread.archive -> sub-chat.archive
thread.delete -> sub-chat.delete
```

## Persistence Changes

Add projection tables:

```sql
projection_organizations
projection_workspaces
projection_sub_chats
projection_workspace_actions
projection_workspace_terminal_sessions
```

Rename or migrate thread tables:

```txt
projection_threads -> projection_sub_chats
projection_thread_messages -> projection_sub_chat_messages
projection_thread_activities -> projection_sub_chat_activities
projection_thread_sessions -> projection_sub_chat_sessions
projection_turns -> projection_sub_chat_turns
projection_pending_approvals -> projection_sub_chat_pending_approvals
projection_thread_proposed_plans -> projection_sub_chat_proposed_plans
projection_checkpoints -> projection_sub_chat_checkpoints
```

Migration strategy:

1. Create a default local organization.
2. For each existing project, assign `organizationId = local`.
3. Create at least one workspace for each project.
4. For existing threads with `worktreePath = null`, attach them to the project's primary workspace.
5. For existing threads with a distinct `worktreePath`, create or reuse a workspace keyed by `(projectId, worktreePath)`.
6. Convert each thread to a sub-chat under the selected workspace.
7. Keep old table names or compatibility views until all runtime code reads the new projections.

## Routing

The route should become workspace-first:

```txt
/orgs/:organizationId/projects/:projectId/workspaces/:workspaceId/chats/:subChatId
```

Short local route aliases can exist for daily use:

```txt
/:workspaceId/:subChatId
/w/:workspaceId/c/:subChatId
```

Draft route:

```txt
/orgs/:organizationId/projects/:projectId/workspaces/:workspaceId/chats/draft/:draftId
```

Rules:

- The selected workspace remains stable when switching sub-chats.
- Opening files, terminals, actions, preview, or git panels should not change the active sub-chat unless the user explicitly selects a sub-chat.
- Deep links to legacy `/:environmentId/:threadId` should resolve through a legacy lookup and redirect to the workspace/sub-chat route.

## UI Information Architecture

### Sidebar

Target sidebar structure:

```txt
Organization switcher

Projects
  Project A
    Chat: Build login flow
    Chat: Review auth edge cases
      Action: pnpm test
      Terminal: dev server
    Workspace: feature/sidebar
      Chat: Sidebar polish
  Project B
    No chats yet

Explorer
Settings
```

Sidebar behavior:

- Organization switcher is top-level. In local-only mode, show the current organization name but avoid forcing users through organization management.
- Project rows are durable groups and should not imply a specific filesystem path.
- Workspace rows show operational status: branch, worktree/local indicator, dirty git state, running terminal/process, failed actions, and active provider work.
- Implicit default workspace rows such as `main` should be hidden in normal navigation unless the user gives them a meaningful custom name. Sub-chats from a hidden default workspace should appear directly under the relevant project or project member. See [Sidebar workspace navigation UX](./sidebar-workspace-navigation-spec.md).
- Sub-chat rows show conversation status: running turn, pending approval, pending user input, actionable plan, unread activity.
- Actions and terminals can be surfaced as compact workspace children or through workspace tabs depending on available space.
- Drag/drop should move workspaces between project/sidebar groups only when it does not change repository identity unexpectedly.

### Main Workbench

The main workbench should be workspace-scoped.

Recommended layout:

```txt
Top workspace bar
  Project name / workspace name / branch / status / preview / git / actions

Workbench tabs
  Chat tabs
  File tabs
  Diff tabs
  Terminal tabs
  Actions tab

Main content
  Active chat, file, diff, terminal, or actions view

Composer
  Visible only when active tab is a chat
```

Changes from current UI:

- Thread tab strip becomes sub-chat tabs inside a workspace.
- File tabs no longer feel globally separate from chat. They are workspace tabs.
- Terminal can be opened as a workspace tab or bottom panel, but the ownership is workspace-level.
- Actions get a first-class workspace view instead of only appearing as chat timeline rows or transient toasts.

### Workspace Header

The workspace header should answer:

- Which organization/project/workspace am I in?
- Which branch/worktree is active?
- Is the workspace ready, preparing, failing, dirty, or running something?
- What are the primary actions I can take?

Suggested controls:

- Project/workspace breadcrumb.
- Workspace switcher.
- Branch/worktree selector.
- Git status action.
- Preview button.
- Terminal button.
- Actions button.
- New sub-chat button.

### Sub-Chat Surface

Sub-chat UI keeps the current chat strengths:

- Timeline of messages, activities, approvals, user inputs, plans, and checkpoints.
- Composer with provider/model/runtime controls.
- Plan sidebar.
- Diff side panel.
- Pending approval and user-input panels.

But sub-chat should receive workspace context from the parent:

- Composer sends `workspaceId` plus `subChatId`.
- Provider sessions start in the workspace `cwd`.
- Terminal context chips reference workspace terminals.
- File links resolve through the workspace.
- Plans/checkpoints apply to workspace state.

### Actions Surface

Actions should have a compact operational view:

```txt
Actions
  Running
    pnpm test
    Prepare worktree
  Needs attention
    Approval required: write outside workspace
  Completed
    Git sync
    Created pull request
```

Each action should show:

- Status.
- Source.
- Associated sub-chat, if any.
- Associated terminal, if any.
- Start/completion time.
- Primary next action, such as open terminal, view diff, approve, retry, cancel, or open PR.

### Terminal Surface

Terminal UI options:

- Bottom panel for fast chat-adjacent workflows.
- Workspace tab for larger terminal sessions.
- Split terminal groups within a workspace.

Terminal rules:

- Terminal sessions persist when switching sub-chats in the same workspace.
- Running project scripts appear as workspace actions and terminal sessions.
- Terminal context can be attached to any sub-chat in the same workspace.
- Closing a sub-chat does not close workspace terminals.
- Archiving/deleting a workspace handles terminal shutdown explicitly.

## UX Story Flows

### Flow 1: First Run, Add Existing Repository

1. User opens T3 Code.
2. App shows the default local organization.
3. User clicks "Add project".
4. User selects a repository folder.
5. App creates:
   - Project from repository identity.
   - Workspace named `main` with `cwd` set to the selected folder.
   - Main sub-chat named `New chat`.
6. User lands in the new workspace with the chat tab active.
7. Sidebar shows:

```txt
Local
  repo-name
    main
      New chat
```

Success criteria:

- User can send a prompt immediately.
- File explorer and terminal use the workspace `cwd`.
- The project can later have more workspaces without duplicating project metadata.

### Flow 2: Start A New Feature Workspace

1. User opens a project.
2. User clicks "New workspace".
3. App asks for workspace mode:
   - Use current checkout.
   - Create worktree from base branch.
   - Connect remote workspace.
4. User selects "Create worktree".
5. App creates workspace in `preparing` state and starts a workspace action.
6. Worktree setup output appears in Actions and optionally a terminal.
7. When ready, app creates a main sub-chat and opens it.

Success criteria:

- Worktree preparation is not hidden inside a chat.
- Failed setup leaves a failed workspace action with retry/details.
- The workspace exists even if no provider session has started yet.

### Flow 3: Multiple Sub-Chats In One Workspace

1. User is in workspace `feature/sidebar`.
2. User opens "New sub-chat".
3. App creates a new sub-chat under the same workspace.
4. User asks one sub-chat to implement the sidebar.
5. User asks another sub-chat to review accessibility concerns.
6. Both sub-chats share:
   - Same file tree.
   - Same git status.
   - Same terminal sessions.
   - Same action history.

Success criteria:

- Switching sub-chats does not reset terminal or file tabs.
- Each sub-chat keeps separate messages, plans, checkpoints, and provider session.
- Workspace actions make cross-chat changes understandable.

### Flow 4: Run A Project Script

1. User clicks a pinned project script in the workspace header.
2. App creates a workspace action with source `script`.
3. App opens or reuses a workspace terminal.
4. Script output streams in the terminal.
5. The action row updates to running/completed/failed.
6. Any sub-chat can reference the terminal output as context.

Success criteria:

- Script runs are not tied to whichever sub-chat happened to be active.
- The action remains discoverable after switching chats.
- A failed script has a clear retry/open-terminal path.

### Flow 5: Use Terminal Context In A Sub-Chat

1. User runs tests in a workspace terminal.
2. User selects failing output.
3. User clicks "Add to chat".
4. App asks which active sub-chat should receive the terminal context if no chat tab is focused.
5. Composer receives a terminal context chip.
6. User sends a prompt.

Success criteria:

- Terminal context is valid for sub-chats in the same workspace.
- Terminal context cannot be attached to a sub-chat in a different workspace without explicit copy/confirmation.
- Expired terminal context is shown clearly and can be removed or refreshed.

### Flow 6: Apply A Proposed Plan In A New Sub-Chat

1. User receives a proposed plan in `Planning` sub-chat.
2. User clicks "Implement in new sub-chat".
3. App creates an `implementation` sub-chat under the same workspace.
4. App links the implementation sub-chat to the source proposed plan.
5. Implementation changes files in the shared workspace.
6. Workspace actions show "Implement proposed plan" and any related tool activity.

Success criteria:

- Plan source and implementation target remain linked.
- Workspace context is shared, so diffs/checkpoints apply to the same checkout.
- The user can return to the planning sub-chat without losing implementation state.

### Flow 7: Review Diff Across Workspace

1. User opens the Diff tab from the workspace header.
2. Diff view uses the workspace git state, not a single sub-chat.
3. User can filter by:
   - All changes.
   - Changes from sub-chat.
   - Changes from action.
   - Changes since checkpoint.
4. User opens a file from the diff into a workspace file tab.

Success criteria:

- Diff is accurate for the workspace.
- Sub-chat-specific checkpoint diff remains available from the sub-chat timeline.
- Workspace-wide diff and sub-chat checkpoint diff are clearly different concepts.

### Flow 8: Browser Preview

1. User starts a dev server in a workspace terminal.
2. App detects the dev server and associates it with the workspace.
3. User clicks Preview.
4. Browser-agent extension opens the preview for the workspace.
5. Provider browser tools operate in the workspace browser context.

Success criteria:

- Preview is not tied to a sub-chat.
- A sub-chat can request browser work through the workspace context.
- Closing a sub-chat does not close the workspace preview unless the provider-owned browser context is explicitly stopped.

### Flow 9: Archive Or Delete A Sub-Chat

1. User archives a sub-chat.
2. App removes it from normal workspace chat tabs/sidebar rows.
3. Workspace remains open.
4. Terminals, actions, files, and other sub-chats remain unchanged.

Delete rules:

- Deleting an active sub-chat requires stopping its provider session first.
- Deleting a sub-chat does not delete the workspace.
- Deleting a sub-chat does not close workspace terminals.

### Flow 10: Archive Or Delete A Workspace

1. User chooses archive/delete workspace.
2. App shows active sub-chats, running actions, and terminal sessions.
3. If anything is active, user must stop it or choose an explicit stop-and-archive flow.
4. Archive hides workspace but keeps sub-chat history and terminal metadata where appropriate.
5. Delete removes workspace-owned state according to retention rules.

Success criteria:

- Workspace cleanup is explicit and predictable.
- Worktree deletion is separate from workspace archive unless the user opts in.
- Active provider sessions and terminals cannot be silently destroyed.

### Flow 11: Move Project Into Organization Folder

1. User creates or selects an organization.
2. User moves a project into that organization.
3. Project workspaces and sub-chats move with the project.
4. Links remain stable through IDs.

Success criteria:

- Organization is not just a sidebar folder.
- Project membership determines where workspaces appear.
- Future cloud permission checks have a natural boundary.

### Flow 12: Mobile Review

1. User opens T3 Code mobile.
2. App shows organizations, then projects, then active workspaces.
3. User opens a workspace.
4. User reviews actions, terminals, diffs, and sub-chats.
5. User responds to approval in a sub-chat or views a workspace terminal.

Success criteria:

- Mobile can prioritize workspace cards over dense desktop panels.
- Sub-chat detail stays stack-friendly.
- Workspace actions provide a concise operational summary.

## UI States

### Workspace States

- `ready`: Normal operation.
- `preparing`: Worktree/setup in progress.
- `blocked`: Waiting for user input, credentials, or approval at workspace level.
- `error`: Setup or runtime failure.
- `archived`: Hidden from primary navigation.
- `deleting`: Explicit cleanup in progress.

### Sub-Chat States

- `idle`: No active provider session or turn.
- `starting`: Provider session starting.
- `running`: Active turn.
- `ready`: Session ready for next turn.
- `interrupted`: Last turn interrupted.
- `error`: Provider/session failure.
- `archived`: Hidden from primary navigation.

### Action States

- `queued`
- `running`
- `blocked`
- `completed`
- `failed`
- `cancelled`

### Terminal States

- `starting`
- `running`
- `exited`
- `error`

## Client State Shape

Client runtime should normalize around the target hierarchy:

```ts
interface EnvironmentState {
  organizationIds: OrganizationId[];
  organizationById: Record<OrganizationId, Organization>;

  projectIdsByOrganizationId: Record<OrganizationId, ProjectId[]>;
  projectById: Record<ProjectId, Project>;

  workspaceIdsByProjectId: Record<ProjectId, WorkspaceId[]>;
  workspaceById: Record<WorkspaceId, Workspace>;

  subChatIdsByWorkspaceId: Record<WorkspaceId, SubChatId[]>;
  subChatShellById: Record<SubChatId, SubChatShell>;
  subChatSessionById: Record<SubChatId, SubChatSession | null>;
  subChatDetailById: Record<SubChatId, SubChatDetail>;

  actionIdsByWorkspaceId: Record<WorkspaceId, WorkspaceActionId[]>;
  actionById: Record<WorkspaceActionId, WorkspaceAction>;

  terminalIdsByWorkspaceId: Record<WorkspaceId, TerminalId[]>;
  terminalByWorkspaceId: Record<WorkspaceId, Record<TerminalId, TerminalSummary>>;
}
```

Workbench tabs should be workspace-scoped:

```ts
type WorkbenchTab =
  | { kind: "sub-chat"; workspaceId: WorkspaceId; subChatId: SubChatId }
  | { kind: "file"; workspaceId: WorkspaceId; relativePath: string }
  | { kind: "diff"; workspaceId: WorkspaceId; filter?: DiffFilter }
  | { kind: "terminal"; workspaceId: WorkspaceId; terminalId: TerminalId }
  | { kind: "actions"; workspaceId: WorkspaceId };
```

## Migration Plan

### Phase 1: Add Workspace Model Beside Threads

- Add `WorkspaceId` and workspace contract schemas.
- Add `projection_workspaces`.
- Backfill one workspace per current project/worktree grouping.
- Add workspace shell data to `subscribeShell`.
- Keep current thread routes and terminal keys.

### Phase 2: Attach Threads To Workspaces

- Add `workspaceId` to thread/sub-chat contracts and projections.
- Populate `workspaceId` for all existing threads.
- Update selectors to group threads under workspace.
- Keep `projectId` on threads as denormalized compatibility data.

### Phase 3: Move UI To Workspace-First

- Add workspace route and redirect legacy thread route.
- Make sidebar show project > workspace > sub-chat.
- Make workbench tabs scoped to workspace.
- Move file tabs from global file tab state to workspace tab state.
- Keep thread APIs as compatibility wrappers.

### Phase 4: Move Terminal To Workspace

- Add workspace terminal contracts and RPCs.
- Support terminal metadata keyed by workspace.
- Migrate persisted terminal history with fallback from old thread history.
- Update terminal UI state from `threadKey` to `workspaceKey`.
- Keep old terminal RPCs until no active UI calls them.

### Phase 5: Add Workspace Actions

- Add workspace action contracts, projections, and stream events.
- Convert project script runs into actions.
- Convert git operations into actions.
- Link provider tool activity to workspace actions where useful.
- Add Actions tab and workspace action sidebar indicators.

### Phase 6: Rename Thread To Sub-Chat

- Rename UI copy from thread to sub-chat where user-facing.
- Rename contracts gradually, preserving wire aliases.
- Rename persistence tables only after compatibility is stable.
- Update docs and AGENTS.md once this becomes the live architecture.

### Phase 7: Organization As Real Parent

- Add organization list/shell to primary app state.
- Move sidebar project folders toward organization/project membership.
- Integrate organization panels under organization routes.
- Prepare for cloud permission checks.

## Compatibility Requirements

- Existing users must not lose thread history.
- Existing thread URLs must redirect to the equivalent workspace/sub-chat.
- Existing terminal history should be readable where possible.
- Current project scripts should continue to run.
- Current project settings should map to project defaults or workspace defaults explicitly.
- Existing provider sessions should stop cleanly during migration boundaries; do not attempt to hot-migrate active subprocesses.

## Implementation Risks

- Terminal ownership migration is high risk because backend locks, history files, metadata streams, and UI state are thread-keyed.
- Route migration can break deep links and draft promotion if compatibility lookup is incomplete.
- Duplicating `projectId` across workspace and sub-chat can drift unless treated as denormalized read-model data.
- Workspace actions can become noisy if every provider activity is promoted to an action. Only durable or user-meaningful operations should become workspace actions.
- Worktree cleanup must remain explicit. Workspace archive should not silently delete filesystem state.

## Open Questions

- Should every project always have a default workspace, or can a project exist with zero workspaces?
- Should `workspace.cwd` always point to the effective working directory, or should `cwd` and `worktreePath` be separate for display and compatibility only?
- Should terminal be primarily a bottom panel, a tab, or both?
- Should actions be persisted forever, capped per workspace, or archived with sub-chat history?
- Should organization be visible in local-only mode, or mostly implicit until cloud/multi-org is enabled?
- Should sub-chat provider sessions share any provider-level context within a workspace, or remain fully isolated?

## Acceptance Criteria

- Users can navigate organization > project > workspace > sub-chat without learning legacy thread terminology.
- Multiple sub-chats can operate in the same workspace while sharing terminal, files, git state, preview, and actions.
- Archiving/deleting a sub-chat does not affect workspace terminals or actions.
- Archiving/deleting a workspace clearly handles active sub-chats, terminals, actions, and worktree cleanup.
- Existing thread data migrates to sub-chats with no lost messages, plans, checkpoints, or sessions.
- Existing projects migrate with a clear project/workspace split.
- The UI always makes the current workspace visible when editing files, running commands, reviewing diffs, or chatting.
