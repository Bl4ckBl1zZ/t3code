# Sidebar Workspace Navigation UX Spec

Status: Draft

## Summary

The sidebar should make the user's work easy to scan without exposing internal compatibility labels like `main` as a permanent navigation layer. The durable model remains project > workspace > sub-chat, but the visible navigation should hide implicit default workspaces when they do not add meaning.

The target experience is:

- Projects remain the primary sidebar groups.
- Branch/worktree workspaces remain visible as compact expandable groups.
- The implicit default workspace is hidden when it is just the project's normal working tree.
- Sub-chats from a hidden default workspace are shown directly under the nearest meaningful parent.
- Active provider work is visible on the sub-chat row and rolls up to the workspace, project member, and project rows.
- Empty implicit default workspaces do not render a `main` row or a repeated empty state.

## Problem

Today, many projects show a `main` workspace row even when that row represents only the default project working tree. This creates visual noise:

```txt
Project
  main
    No threads yet
```

or:

```txt
Project
  main
    Build sidebar labels
```

For the user, `main` is usually not a task, branch, workspace, or meaningful destination. It is an implementation detail. The extra row makes the hierarchy feel deeper than the user's mental model and competes with branch/worktree names that are meaningful.

The sidebar also needs to preserve workspace semantics because workspaces own terminals, actions, previews, git state, and sub-chat grouping. The UX goal is not to remove default workspaces from the model; it is to make them invisible unless they become meaningful.

## Goals

- Reduce sidebar text and indentation by hiding implicit default workspace rows.
- Keep branch/worktree workspace rows visible and renameable.
- Make active work visible even when the active sub-chat belongs to a hidden default workspace.
- Avoid duplicate labels where a workspace title and sub-chat title communicate the same context.
- Keep the sidebar understandable for single-project, monorepo, multi-project, and remote environments.
- Preserve the project > workspace > sub-chat model in state, routing, and commands.
- Provide a migration-safe path that does not delete, rename, or rewrite existing workspace records.

## Non-Goals

- Do not remove default workspace records from persistence.
- Do not rename existing `main` workspace data automatically.
- Do not redesign the whole workbench tab model in this change.
- Do not introduce user-facing legacy `thread` terminology as part of the new sidebar UX.
- Do not make empty default workspaces a first-class visual row.

## Terminology

**Project group**

The top-level visible project row in the sidebar. It may represent one physical project or a grouped set of related physical projects.

**Project member**

A physical project row inside a grouped project, for example a package/repo member such as `restorecord-new`, `microAPI`, or `server`.

**Workspace**

A workspace-scoped execution and file context. Workspaces own or scope sub-chats, actions, terminals, preview targets, and git state.

**Implicit default workspace**

The workspace representing the normal project working tree. It is commonly displayed as `main`, has no custom user title, and usually has no branch/worktree identity that the user needs to select.

**Named workspace**

A workspace with a meaningful display name. This includes branch/worktree workspaces like `discord-message-payloads` and user-renamed default workspaces.

**Sub-chat**

A chat session inside a workspace. Legacy thread rows may still back this data during the compatibility phase.

## Information Architecture

### Current Noisy Shape

```txt
Projects
  T3 Code
    t3code
      main
        Clarify sidebar workspace labels
      server

  RestoreCord
    restorecord-new
      main
        No threads yet
      discord-message-payloads
        Discord Message Payloads
      automod-tab
        AutoMod
    microAPI
      main
        No threads yet
```

### Target Compact Shape

```txt
Projects
  T3 Code
    t3code
      Clarify sidebar workspace labels
    server

  RestoreCord
    restorecord-new
      discord-message-payloads
        Discord Message Payloads
      automod-tab
        AutoMod
    microAPI
    botNode
    snapshotGo
```

If the default workspace has multiple sub-chats, show them directly under the project member:

```txt
Project
  Build login flow
  Review auth edge cases
  feature/sidebar
    Sidebar polish
```

If the default workspace is renamed by the user, it becomes meaningful and should be visible:

```txt
Project
  Core cleanup
    Build login flow
    Review auth edge cases
  feature/sidebar
    Sidebar polish
```

## Workspace Visibility Rules

### Rule 1: Hide Implicit Empty Default Workspaces

If a workspace is implicit default and has no visible sub-chats, no visible running actions, and no visible running terminals, do not render a workspace row.

Before:

```txt
microAPI
  main
    No threads yet
```

After:

```txt
microAPI
```

### Rule 2: Hoist Sub-Chats From Hidden Default Workspaces

If a workspace is implicit default and has visible sub-chats, render those sub-chats directly under the project or project member.

Before:

```txt
t3code
  main
    Clarify sidebar workspace labels
```

After:

```txt
t3code
  Clarify sidebar workspace labels
```

The sub-chat still keeps its `workspaceId`; this is display-only hoisting.

### Rule 3: Show Branch/Worktree Workspaces

Show a workspace row when it has branch/worktree identity or a non-default user-facing name.

Examples that should remain visible:

```txt
discord-message-payloads
automod-tab
restorecord-new
feature/sidebar
bugfix-ci
```

### Rule 4: Show User-Renamed Default Workspaces

If the user renames the default workspace to a meaningful title, show it as a workspace group.

Example:

```txt
Project
  Release cleanup
    Update changelog
    Fix release action
```

If the user renames it back to `main` or clears the custom title, it may become hidden again if it otherwise matches the implicit default rules.

### Rule 5: Do Not Show Repeated Empty States

Empty states should appear once at the nearest meaningful level.

Allowed:

```txt
Project
  No chats yet
```

Avoid:

```txt
Project
  main
    No threads yet
```

For grouped projects with multiple empty project members, omit repeated `No chats yet` rows by default. Use a subtle hover action or context menu for creating a chat.

### Rule 6: Preserve Visible Status For Hidden Workspaces

If a hidden default workspace has active provider work, pending approval, pending input, running actions, or running terminals, roll status up to the project member and project rows.

If there is an active sub-chat row, show status on that row too.

## Display Name Rules

### Workspace Name Resolution

Workspace title display should use this priority:

1. User custom title, if meaningful.
2. Branch leaf, for branch/worktree workspaces.
3. Worktree directory basename, for worktree-backed legacy records.
4. Project/member name context, for implicit default workspace tooltips only.
5. `main` only in developer/debug surfaces, never as a normal default sidebar row.

Examples:

| Raw data                                                                                  | Sidebar label              |
| ----------------------------------------------------------------------------------------- | -------------------------- |
| branch `Bl4ckBl1zZ/discord-message-payloads`                                              | `discord-message-payloads` |
| title `Bl4ckBl1zZ-discord-message-payloads`, branch `Bl4ckBl1zZ/discord-message-payloads` | `discord-message-payloads` |
| worktree path `/repo/.worktrees/automod-tab`                                              | `automod-tab`              |
| default workspace title `main`, no custom title                                           | hidden                     |
| default workspace custom title `Release cleanup`                                          | `Release cleanup`          |

### Sub-Chat Name Resolution

Sub-chat rows show the sub-chat title only. They should not include branch, workspace, project, or owner prefixes unless the title itself was explicitly set to that text by the user.

## Status Rollup

Status should be computed independently from visibility. A hidden default workspace can still contribute status to visible parent rows.

### Status Priority

Use the existing priority model:

1. Pending approval
2. Pending user input
3. Running/working
4. Connecting
5. Plan ready
6. Completed/unread completion
7. Idle/no status

### Status Placement

```txt
Project row
  Project member row
    Workspace row
      Sub-chat row
```

- Sub-chat row shows its own status.
- Workspace row shows the highest-priority status from its visible and hidden sub-chats, terminals, and actions.
- Project member row shows the highest-priority status from all child workspaces, including hidden default workspaces.
- Project group row shows the highest-priority status from all member projects.

### Active Selection

- The selected sub-chat row should use the strongest active highlight.
- Parent rows should use a subtle active state only when their descendants contain the selected sub-chat.
- Collapsed parent rows must still show the status indicator.

## Desktop UI Specification

### Project Row

Content:

- Chevron
- Project favicon
- Project name
- Optional status indicator
- Optional panel/action affordance

Behavior:

- Click toggles expansion.
- Context menu includes project-level actions.
- Status rolls up from all descendant workspaces and sub-chats.

### Project Member Row

Show only when needed to distinguish grouped projects or multiple physical roots.

Content:

- Chevron, when it has visible children
- Favicon or folder icon
- Project member name
- Optional status indicator

Behavior:

- Hidden default workspace children are hoisted under this row.
- Empty implicit default workspace does not create a child row.

### Named Workspace Row

Content:

- Chevron
- Workspace icon or project favicon
- Workspace title
- Compact status indicator
- New sub-chat action on hover/focus

Behavior:

- Click toggles expansion.
- Double-click starts inline rename.
- Context menu includes:
  - New sub-chat
  - Rename workspace
  - Open in terminal, when available
  - Open worktree/folder, when available
  - Stop active sub-chats, when any are running
  - Archive workspace

### Hidden Default Workspace

No direct row in the sidebar.

Actions remain available through:

- Project or project member context menu: `New chat`
- Command palette: `New chat in current project workspace`
- Active workspace controls in the workbench footer/header
- Search results secondary text

### Sub-Chat Row

Content:

- Optional status indicator
- Sub-chat title
- Relative activity time
- Archive affordance on hover/focus
- Optional terminal/status decorations

Behavior:

- Click opens the sub-chat.
- Context menu includes:
  - Rename chat
  - New chat in same workspace
  - Stop session, when active
  - Archive chat
  - Delete chat, when safe

### Empty States

Project/member empty state:

```txt
No chats yet
```

Rules:

- Show only when the expanded parent has no visible sub-chats and no visible named workspaces.
- Do not show under hidden default workspace.
- Prefer a subtle single-line empty state over a full row stack.

## Mobile UI Specification

Mobile should prioritize workspace cards and active work over deep trees.

Recommended mobile hierarchy:

```txt
Project
  Active
    Discord Message Payloads - Working
  Workspaces
    discord-message-payloads
    automod-tab
  Recent chats
    Clarify sidebar workspace labels
```

Mobile rules:

- Hide implicit default workspace labels by default.
- Show active status in an `Active` section when space is constrained.
- Opening a named workspace can show sub-chats as a second-level screen instead of an expanded tree.
- Keep `main` out of visible labels unless user-renamed.

## UX Story Flows

### Flow 1: First Chat In A Simple Project

Scenario:

The user opens a project and starts a chat in the normal working tree.

Steps:

1. User opens project `T3 Code`.
2. Sidebar shows `T3 Code`.
3. User creates a new chat.
4. App creates or uses the implicit default workspace.
5. Sidebar shows the chat directly under `T3 Code`.

Target UI:

```txt
T3 Code
  Clarify sidebar workspace labels
```

User perception:

The user sees the project and the chat. They do not need to understand that a default workspace exists.

### Flow 2: Empty Default Workspace

Scenario:

The project exists, but no chats have been started.

Steps:

1. Sidebar renders project `microAPI`.
2. App detects only an implicit default workspace with no visible sub-chats.
3. Sidebar hides the default workspace.
4. If the project row is expanded and has no other visible children, optionally show one empty state.

Target UI:

```txt
microAPI
```

Optional expanded UI:

```txt
microAPI
  No chats yet
```

User perception:

The sidebar does not imply that `main` is something the user should manage.

### Flow 3: Branch Workspace With One Sub-Chat

Scenario:

The user creates a branch/worktree workspace to implement a feature.

Steps:

1. User creates workspace from branch `Bl4ckBl1zZ/discord-message-payloads`.
2. App resolves display label to `discord-message-payloads`.
3. Sidebar shows a named workspace row.
4. User starts a sub-chat inside it.

Target UI:

```txt
RestoreCord
  restorecord-new
    discord-message-payloads
      Discord Message Payloads
```

User perception:

The workspace label communicates the branch/worktree, and the chat title communicates the task.

### Flow 4: Active Chat In Hidden Default Workspace

Scenario:

The active provider session belongs to the implicit default workspace.

Steps:

1. User sends a prompt in a default workspace chat.
2. Provider session enters `running`.
3. Store mirrors session state to sidebar summary.
4. Sidebar shows status on the sub-chat row.
5. Project/member row also shows the rollup status.

Target UI:

```txt
T3 Code                     Working dot
  Clarify sidebar labels    Working dot
```

User perception:

Even without a visible `main` row, active work is obvious.

### Flow 5: Active Chat In Collapsed Named Workspace

Scenario:

The user collapses a named workspace while a sub-chat is running.

Steps:

1. Workspace `discord-message-payloads` has a running sub-chat.
2. User collapses the workspace row.
3. Child sub-chat row becomes hidden.
4. Workspace row keeps the working status indicator.
5. Project/member row also keeps rollup status.

Target UI:

```txt
RestoreCord                 Working dot
  restorecord-new           Working dot
    discord-message-payloads Working dot
```

User perception:

Collapsed navigation does not hide active work.

### Flow 6: Rename Branch Workspace

Scenario:

The user wants a friendlier name for a branch workspace.

Steps:

1. User right-clicks `discord-message-payloads`.
2. User selects `Rename workspace`.
3. Inline input appears in the workspace row.
4. User enters `Dashboard payload work`.
5. App dispatches `workspace.meta.update`.
6. Sidebar updates title.

Target UI:

```txt
restorecord-new
  Dashboard payload work
    Discord Message Payloads
```

User perception:

Workspace labels are controllable when they are meaningful navigation groups.

### Flow 7: Rename Default Workspace

Scenario:

The user wants to name the normal project workspace because it has become a meaningful long-lived context.

Steps:

1. User opens project/member context menu.
2. User selects `Rename project workspace`.
3. App renames the implicit default workspace.
4. Because it now has a meaningful custom name, sidebar shows it as a visible workspace group.

Target UI:

```txt
Project
  Release cleanup
    Update changelog
```

User perception:

The default workspace remains hidden until the user intentionally turns it into a named workspace.

### Flow 8: Create New Chat From Project Row

Scenario:

The project has no visible workspace rows, but the user wants a new chat.

Steps:

1. User clicks project-level new chat action.
2. App creates a sub-chat in the implicit default workspace.
3. Sidebar shows the new sub-chat directly under the project/member row.

Target UI:

```txt
Project
  New chat
```

User perception:

Creating a simple chat does not require choosing or seeing `main`.

### Flow 9: Create New Branch Workspace

Scenario:

The user wants isolated workspace state for a feature.

Steps:

1. User selects `New workspace`.
2. App asks for mode: current working tree, new worktree/branch, existing branch/worktree, remote.
3. User selects new worktree/branch.
4. App creates workspace in `preparing`.
5. Sidebar shows a named workspace row with preparing status.
6. When ready, the workspace row becomes normal and contains its first sub-chat.

Target UI:

```txt
Project
  feature/sidebar        Preparing
    New chat
```

User perception:

Named workspaces are for meaningful alternate execution contexts.

### Flow 10: Search Hidden Default Workspace Chat

Scenario:

The user searches for a chat that lives in a hidden default workspace.

Steps:

1. User searches `sidebar labels`.
2. Result shows sub-chat title.
3. Secondary text shows project/member context, not `main`.

Target result:

```txt
Clarify sidebar workspace labels
T3 Code / t3code
```

If the workspace is named:

```txt
Discord Message Payloads
RestoreCord / restorecord-new / discord-message-payloads
```

User perception:

Search gives location context without exposing irrelevant default labels.

### Flow 11: Stop Or Archive Active Sub-Chat

Scenario:

The user wants to archive a running sub-chat.

Steps:

1. User opens context menu on active sub-chat.
2. Archive/delete action is disabled or replaced with stop-and-archive.
3. If user chooses stop-and-archive, app stops the provider session first.
4. Status indicators clear after projected session state is no longer active.
5. Archive removes sub-chat from visible navigation.
6. If it was the only child of a hidden default workspace, no empty `main` row appears.

Target UI after archive:

```txt
Project
```

User perception:

Lifecycle operations are clear and do not reveal empty implementation containers.

### Flow 12: Multi-Member Project Group

Scenario:

`RestoreCord` groups several physical projects.

Steps:

1. Sidebar shows `RestoreCord`.
2. Child project members show only when needed to distinguish roots.
3. Each member hides its own implicit empty default workspace.
4. Named workspaces remain grouped under the member they belong to.

Target UI:

```txt
RestoreCord
  restorecord-new
    discord-message-payloads
      Discord Message Payloads
    automod-tab
      AutoMod
  microAPI
  botNode
  snapshotGo
```

User perception:

Project members remain useful, but their default workspaces do not add extra noise.

## Interaction Details

### Click Targets

- Project/member row click: expand/collapse.
- Named workspace row click: expand/collapse.
- Sub-chat row click: open sub-chat.
- Project/member new-chat button: create chat in implicit default workspace.
- Named workspace new-chat button: create sub-chat in that workspace.

### Keyboard

- Arrow left/right collapses or expands project/member/workspace rows.
- Enter/Space opens sub-chat rows and toggles grouping rows.
- F2 starts rename on focused named workspace or sub-chat.
- Command palette exposes all actions, including hidden default workspace actions.

### Context Menus

Project/member row:

- New chat
- New workspace
- Rename project
- Rename project workspace, when default workspace exists
- Open folder
- Settings

Named workspace row:

- New sub-chat
- Rename workspace
- Open folder/worktree
- Open terminal
- Stop active sub-chats
- Archive workspace

Sub-chat row:

- Rename chat
- New chat in same workspace
- Stop session
- Archive chat
- Delete chat, when safe

### Tooltips

Tooltips may include hidden workspace context when needed:

```txt
Default project workspace
```

Do not show `main` in tooltip unless it is the user-visible custom workspace name.

## Data And Display Model

### Phase 1: Heuristic Display Classification

Use current workspace data to classify visibility:

```ts
type WorkspaceDisplayKind = "hidden-default" | "hoisted-default" | "visible-workspace";
```

Heuristic for implicit default:

- `branch === null`
- `worktreePath === null`
- title is empty, `main`, or matches the generated default title
- workspace is not archived

Heuristic for visible workspace:

- `branch !== null`
- `worktreePath !== null`
- title is a meaningful custom title
- workspace has visible workspace-level actions that need a row

Phase 1 is display-only and should be contained in sidebar logic helpers.

### Phase 2: Explicit Title Source

Longer term, add explicit metadata so display logic does not rely only on title heuristics:

```ts
interface WorkspaceShell {
  id: WorkspaceId;
  title: string;
  generatedTitle: string;
  customTitle: string | null;
  isDefaultWorkspace: boolean;
}
```

Rules:

- `customTitle === null && isDefaultWorkspace === true` hides the default row.
- `customTitle !== null` shows the row, even for default workspace.
- `generatedTitle` can still be used in debug/dev surfaces.

## Implementation Plan

### 1. Add Sidebar Navigation Derivation

Introduce a pure helper in `apps/web/src/components/Sidebar.logic.ts`:

```ts
buildSidebarWorkspaceNavigation(input): SidebarWorkspaceNavigationItem[]
```

Output should encode:

- Project/member grouping target.
- Workspace display kind.
- Hoisted sub-chat rows.
- Visible workspace rows.
- Empty state rows.
- Status rollup keys.

This keeps the React component from reimplementing hidden-main rules inline.

### 2. Hide And Hoist Default Workspace Rows

Update `SidebarProjectThreadList` rendering:

- Hidden empty default workspace: render nothing.
- Hidden default workspace with chats: render chats directly under parent.
- Visible workspace: render workspace header and children.

### 3. Status Aggregation

Keep status aggregation independent from rendered rows.

Requirements:

- `thread.session-set` updates `sidebarThreadSummaryById`.
- Workspace status considers visible and hidden sub-chats.
- Project/member status considers all descendant workspaces.

### 4. Rename Behavior

Keep existing `workspace.meta.update` for visible workspace rename.

Add project/member context menu action for implicit default workspace rename:

- Label: `Rename project workspace`
- If renamed to a meaningful title, visible row appears.
- If renamed to empty or generated default, row becomes hidden again.

### 5. Empty State Behavior

Centralize empty state derivation:

- One empty state per expanded project/member section.
- No empty state for hidden default workspace.
- No repeated `No threads yet` under every `main`.

### 6. Search And Command Palette

Search results should include hidden default workspace chats without showing `main` as location.

Command palette should include:

- `New chat in project workspace`
- `Rename project workspace`
- `New workspace`

### 7. Browser And Mobile Follow-Up

Browser/mobile surfaces should apply the same display classification, but may render it as sections/cards instead of a tree.

## Test Plan

### Unit Tests

Add tests for sidebar logic:

- Empty implicit default workspace is hidden.
- Implicit default workspace with one sub-chat hoists the sub-chat.
- Implicit default workspace with multiple sub-chats hoists all sub-chats.
- Branch/worktree workspace remains visible.
- User-renamed default workspace remains visible.
- Renaming default workspace back to `main` hides it.
- `No chats yet` appears once at project/member level.
- Running sub-chat inside hidden default workspace rolls up status to project/member.
- Running sub-chat inside collapsed named workspace keeps status on workspace row.
- Generated labels like `Bl4ckBl1zZ-discord-message-payloads` resolve to `discord-message-payloads`.

Add store tests:

- `thread.session-set` mirrors running state into sidebar summaries.
- `thread.session-stop-requested` clears running state in sidebar summaries.
- Workspace/sub-chat shell mirrors keep workspace id while hoisting display.

### Browser/UI Tests

Add component/browser tests for:

- Simple project with default chat renders no `main` row.
- Project with empty default workspace renders no nested empty state.
- Branch workspace renders as a group.
- Active running chat shows status on row and parent rollup.
- Keyboard expand/collapse works for visible workspace rows.
- Inline workspace rename remains accessible.

### Manual QA

Use local data shapes:

1. Single project with one default chat.
2. Single project with no chats.
3. Project with default chat plus branch workspace.
4. Grouped project with multiple member projects.
5. Running sub-chat in hidden default workspace.
6. Running sub-chat in collapsed named workspace.
7. Renamed default workspace.
8. Remote environment project.

## Acceptance Criteria

- No implicit default `main` workspace row appears in the normal sidebar.
- Empty implicit default workspaces do not render `No threads yet`.
- Default workspace sub-chats remain reachable and appear directly under the relevant parent.
- Branch/worktree workspaces remain visible and expandable.
- User-renamed default workspaces become visible.
- Active provider work is visible in the sidebar even when the workspace row is hidden.
- Collapsed rows retain active status indicators.
- Rename, archive, stop, and new chat actions remain reachable.
- Legacy routes and thread-backed data continue to work.
- The implementation has focused unit tests and passes `vp check` and `vp run typecheck`.

## Risks And Mitigations

Risk: Users cannot find default workspace actions.

Mitigation: Put default workspace actions on project/member context menus and command palette.

Risk: Hiding `main` makes workspace context less explicit.

Mitigation: Keep workspace context visible in the workbench footer/header when it matters for files, terminals, diffs, preview, or commands.

Risk: Heuristics misclassify a user-intended `main` workspace.

Mitigation: Phase 2 should add explicit `customTitle` and `isDefaultWorkspace` metadata. Phase 1 should treat renamed or branch/worktree-backed workspaces as visible.

Risk: Status disappears when a row is hoisted or hidden.

Mitigation: Compute status from data groups, not rendered rows, and test running hidden-default sessions.

Risk: Multi-member project groups become ambiguous.

Mitigation: Keep project member rows when they distinguish physical roots; only hide the implicit workspace layer underneath them.

## Open Questions

- Should renamed default workspaces be visible immediately, or only after they have at least one sub-chat/action?
- Should a project with only one member hide the project member row too?
- Should the workbench footer say `Project workspace` for hidden default workspaces or show no workspace label?
- Should `main` remain searchable as an alias for hidden default workspace chats?
- Should workspace archive/delete be available for implicit default workspace, or only for named workspaces?
