# T3 Browser Runtime Extension v2 Spec

Status: draft product, UX, and architecture spec

Owner: T3 Code

## Summary

Build one browser extension that serves two jobs:

1. Dev preview companion for T3 Code threads.
2. Full browser runtime for agents, including deep Chrome control and multi-tab orchestration.

The extension remains a packaged Manifest V3 runtime kernel. It does not fetch or execute remote
extension code. The T3 backend and agents send versioned commands, workflows, and data. The
extension executes those commands through packaged handlers using normal extension APIs and, when
enabled, `chrome.debugger` / Chrome DevTools Protocol (CDP).

The current side panel and annotation flows remain first-class features. They are not temporary
compatibility features.

## References

- Manifest V3 overview and packaged-code constraint:
  https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3
- Remote hosted code guidance:
  https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code
- Extension service workers:
  https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers
- Chrome debugger API:
  https://developer.chrome.com/docs/extensions/reference/api/debugger
- Chrome side panel API:
  https://developer.chrome.com/docs/extensions/reference/sidePanel

## Product Goals

- Give every T3 thread a browser workspace in the user's real browser.
- Preserve normal browser profile state: cookies, login sessions, SSO, installed extensions, and
  browser settings.
- Keep browser control scoped, visible, revocable, and auditable.
- Support one primary preview tab per thread.
- Support multiple agent-owned tabs per thread for orchestration and parallel work.
- Project each real browser workspace tab into T3 Code as a streamable thread tab.
- Keep the native browser side panel as the thread companion UI beside real browser tabs.
- Keep click-to-annotate as a high-quality visual feedback workflow.
- Support deep Chrome control through CDP for input, inspection, screenshots, console, network,
  accessibility tree, and page lifecycle operations.
- Make failures diagnosable from both T3 and the extension popup/diagnostics page.
- Make extension updates predictable through protocol/version detection instead of remote code
  loading.

## Non-Goals

- Do not execute remotely hosted extension JavaScript.
- Do not create one extension per use case. There is one extension with multiple runtime modes.
- Do not isolate browser profile state per thread in the MVP.
- Do not grant browser-wide agent access silently.
- Do not expose raw Chrome tab IDs directly to agents as authority tokens.
- Do not replace the side panel with an iframe-only workaround.
- Do not make CDP the only control path. Standard extension APIs remain the default path for preview
  and low-risk commands.
- Do not treat T3 browser tabs as separate browser instances. They are projections of real browser
  tabs owned by the paired browser.

## Core Product Model

### One Browser, Many Thread Workspaces

The user's browser is shared. Each T3 thread gets a browser workspace.

```text
Browser Agent Install
  Thread Workspace A
    Primary Tab
    Agent Tab: Frontend QA
    Agent Tab: Docs Research
  Thread Workspace B
    Primary Tab
    Agent Tab: Login Flow
```

The extension owns browser operations. The backend owns workspace state and authorization. The web UI
shows workspaces and tabs as thread-owned objects, not as raw browser internals.

### Browser Tabs Projected Into T3 Tabs

Every linked browser workspace tab can be projected into T3 Code as a real thread tab. The T3 tab is
not a browser instance. It is a streamed control surface for a real tab in the paired browser.

```text
T3 Thread
  [Chat]
  [Browser: Primary]
  [Browser: Frontend QA]
  [Browser: Docs Research]
```

Projection rules:

- Creating a primary browser tab creates or focuses a `Browser: Primary` T3 tab.
- Creating an agent browser tab creates a T3 tab named from its owner/purpose.
- Closing the T3 projected tab can either close the real browser tab or detach the projection,
  depending on lifecycle and user choice.
- Closing the real browser tab marks the projected T3 tab as closed and offers `Reopen`.
- Switching T3 tabs changes which streamed browser surface is visible in T3.
- Switching browser tabs directly updates active/focused state in T3 but does not force T3 focus
  unless the user opted into follow mode.

This gives browser work the same mental model as chat/diff/terminal work: tabs in T3 represent
active work surfaces, while the actual browser still remains the source of truth.

### Runtime Modes

The same extension can be in several modes at once:

- **Unpaired**: extension is installed but not connected to a T3 backend.
- **Preview Mode**: open/focus primary app preview tabs for T3 threads.
- **Thread Workspace Mode**: maintain one workspace per thread with primary and agent tabs.
- **Side Panel Mode**: show the matching T3 thread beside a linked browser tab.
- **Annotation Mode**: let the user click an element and send visual context back to T3.
- **Deep Control Mode**: attach CDP/debugger to selected tabs for advanced agent control.
- **Diagnostics Mode**: inspect pairing, auth, socket, workspace, command, and CDP state.

### Tab Roles

Each browser workspace can own many tabs.

```ts
type BrowserWorkspaceTabRole =
  | "primary" // main preview tab for the thread
  | "agent" // created or claimed for a specific agent/run
  | "scratch" // temporary tab created for workflow steps
  | "handoff"; // user-facing tab left for later manual work
```

Rules:

- Each thread has exactly one primary tab when linked.
- A thread may have zero or more agent tabs.
- Agent tabs must be associated with the owning thread and, when possible, a run/agent identity.
- A tab can be promoted to primary by the user.
- Agent-created ephemeral tabs can be cleaned up automatically when a run completes.
- Handoff tabs stay open and visible even after an agent run completes.

### Control States

Control is tracked independently from visibility.

```ts
type BrowserControlState =
  | "off" // linked but agent control disabled
  | "standard" // extension APIs and content scripts
  | "deep" // standard control plus CDP/debugger
  | "paused"; // temporarily blocked by the user
```

Thread-level defaults:

- Preview opens with `standard` control available.
- Deep control requires explicit activation in T3 UI.
- The user can pause all browser control for a thread without detaching tabs.
- Emergency detach removes all debugger attachments and rejects future commands until re-enabled.

## Personas And Jobs

### Local Developer

Wants to preview a local app, keep T3 chat next to the app, annotate UI issues, and let the agent
inspect the running app using the user's existing browser profile.

### Remote Browser User

Pairs a browser on another machine to a reachable T3 backend. Wants the same preview, side panel,
annotation, and agent runtime behavior without relying on same-machine browser launch.

### Agent Runtime

Needs structured browser tools that are scoped to the current thread/workspace. May create multiple
tabs for orchestration, but should not accidentally control unrelated browser tabs.

### Developer Debugging The Extension

Needs concrete diagnostics: installed version, backend URL, auth state, WebSocket state, workspace
links, tab snapshots, command log, side panel state, annotation state, and CDP attach state.

## Architecture

### High-Level Diagram

```text
T3 Web/Desktop UI
  - thread browser panel
  - preview button
  - browser tab list
  - permission prompts
  - diagnostics drawer
        |
        | app WebSocket / RPC
        v
T3 Backend
  - auth and pairing
  - browser agent registry
  - workspace/tab model
  - command routing
  - agent browser tool bridge
  - audit log
        ^
        | authenticated browser-agent WebSocket
        v
Browser Extension Runtime Kernel
  - transport module
  - workspace module
  - tabs module
  - side panel module
  - annotation module
  - content script module
  - CDP/debugger module
  - diagnostics module
```

### Packaged Runtime Kernel

The extension bundles all executable logic:

- WebSocket transport and reconnect.
- Pairing and auth.
- Capability negotiation.
- Command dispatcher.
- Browser workspace/tab manager.
- Side panel manager.
- Annotation overlay and capture.
- Standard input/navigation/screenshot handlers.
- CDP/debugger adapter.
- Diagnostics and ring-buffer logs.

The server sends commands, data, and declarative workflows. It never sends extension JS to execute.

### Backend Responsibilities

The backend:

- Authenticates extension connections.
- Maintains connected browser agents.
- Persists thread browser workspaces.
- Authorizes browser commands against the active thread/workspace.
- Selects the browser agent for each command.
- Translates agent/tool requests into browser runtime commands.
- Records audit events for sensitive browser operations.
- Detects protocol mismatch and prompts for extension update.

### Extension Modules

```text
apps/chrome-extension/src/
  background/
    serviceWorker.ts
    transport.ts
    commandRouter.ts
    diagnostics.ts
    storage.ts
  runtime/
    capabilities.ts
    workspaces.ts
    tabs.ts
    sidePanel.ts
    annotation.ts
    debugger.ts
    screenshots.ts
    input.ts
  content/
    annotationOverlay.ts
    domSnapshot.ts
    pageBridge.ts
  ui/
    popup/
    sidepanel/
    diagnostics/
```

This is an architectural target. The current flat extension can be migrated incrementally.

## Permissions

Target manifest permissions:

```json
{
  "permissions": ["storage", "tabs", "tabGroups", "windows", "scripting", "sidePanel", "debugger"],
  "host_permissions": ["<all_urls>"]
}
```

Permission rationale:

- `storage`: persisted pairing, workspace cache, diagnostics.
- `tabs`, `windows`, `tabGroups`: create/focus/group/observe browser tabs.
- `scripting`: inject annotation overlay and page helpers.
- `sidePanel`: native T3 thread side panel.
- `debugger`: CDP deep control.
- `<all_urls>`: support arbitrary local, staging, docs, SSO, and external app tabs.

UX must explain the debugger permission because it is powerful.

## Capability Negotiation

On WebSocket connect, the extension sends:

```ts
type BrowserRuntimeHello = {
  type: "browserAgent.hello";
  agentId?: string;
  runtime: {
    protocolVersion: number;
    extensionVersion: string;
    buildId?: string;
    browser: "chrome" | "brave" | "edge" | "chromium" | "unknown";
    platform: string;
  };
  capabilities: {
    standard: string[];
    sidePanel: string[];
    annotation: string[];
    cdp: string[];
    diagnostics: string[];
  };
};
```

Example capabilities:

```txt
workspace.create
workspace.list
tab.create
tab.attachActive
tab.focus
tab.close
tab.navigate
tab.input
tab.snapshot
tab.screenshot
sidePanel.open
sidePanel.setThread
annotation.activate
annotation.cancel
cdp.attach
cdp.detach
cdp.send
diagnostics.snapshot
diagnostics.logs
```

The server must not send commands that are not advertised by the extension.

## Data Model

### Browser Agent

```ts
type BrowserAgent = {
  id: string;
  sessionId: string;
  connected: boolean;
  browser: "chrome" | "brave" | "edge" | "chromium" | "unknown";
  label: string;
  extensionVersion: string;
  protocolVersion: number;
  capabilities: BrowserAgentCapabilities;
  connectedAt: string;
  lastSeenAt: string;
};
```

### Browser Workspace

```ts
type BrowserWorkspace = {
  id: string;
  environmentId: string;
  threadId: string;
  agentId: string;
  primaryTabId: string | null;
  controlState: BrowserControlState;
  deepControlEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};
```

### Browser Workspace Tab

```ts
type BrowserWorkspaceTab = {
  id: string;
  workspaceId: string;
  agentId: string;
  projectedThreadTabId: string | null;
  browserTabId: number | null;
  windowId: number | null;
  role: BrowserWorkspaceTabRole;
  title: string | null;
  url: string | null;
  purpose: string | null;
  owner: {
    kind: "user" | "agent" | "system";
    providerSessionId?: string;
    runId?: string;
    label?: string;
  };
  lifecycle: "persistent" | "ephemeral" | "handoff";
  status: "opening" | "loading" | "complete" | "closed" | "error";
  streamState: "off" | "starting" | "live" | "screenshot-fallback" | "error";
  controlState: BrowserControlState;
  cdpAttached: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
};
```

### Browser Command

```ts
type BrowserCommand = {
  commandId: string;
  workspaceId: string;
  tabId?: string;
  type: string;
  params: unknown;
  timeoutMs?: number;
};
```

### Browser Command Result

```ts
type BrowserCommandResult =
  | {
      commandId: string;
      ok: true;
      payload?: unknown;
    }
  | {
      commandId: string;
      ok: false;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
    };
```

## Command Protocol

### Workspace Commands

```txt
workspace.create
workspace.restore
workspace.detach
workspace.pauseControl
workspace.resumeControl
workspace.enableDeepControl
workspace.disableDeepControl
workspace.snapshot
```

### Tab Commands

```txt
tab.create
tab.attachActive
tab.openOrFocusPrimary
tab.focus
tab.close
tab.promoteToPrimary
tab.rename
tab.setPurpose
tab.navigate
tab.back
tab.forward
tab.reload
tab.input
tab.snapshot
tab.screenshot
tab.stream.start
tab.stream.stop
tab.capture.start
tab.capture.stop
```

### Side Panel Commands

```txt
sidePanel.open
sidePanel.setThread
sidePanel.clearThread
sidePanel.syncActiveTab
sidePanel.showOpenPrompt
sidePanel.hideOpenPrompt
```

### Annotation Commands

```txt
annotation.activate
annotation.cancel
annotation.submit
annotation.captureElement
```

### Deep Control Commands

```txt
cdp.attach
cdp.detach
cdp.send
cdp.runtime.evaluate
cdp.input.dispatch
cdp.network.enable
cdp.network.disable
cdp.accessibility.snapshot
cdp.console.read
```

`cdp.send` is generic, but server policy should still gate which CDP domains and methods are allowed
for each thread/control state.

### Diagnostics Commands

```txt
diagnostics.snapshot
diagnostics.logs
diagnostics.pingBackend
diagnostics.forceReconnect
diagnostics.clear
```

## UI Surfaces

### 1. T3 Thread Browser Panel

The browser panel is the main T3-side workspace UI.

Primary layout:

```text
Browser
----------------------------------------------------------------------------
[Primary] localhost:3000                     [Agent access: On] [Deep: Off]
----------------------------------------------------------------------------
Tabs
  * Primary                 localhost:3000
  - Frontend QA             /settings
  - Docs Research           React Router docs
  - Login Flow              /login
----------------------------------------------------------------------------
[Back] [Forward] [Reload] [URL input........................] [Open] [...]
----------------------------------------------------------------------------
Live browser surface or screenshot fallback
----------------------------------------------------------------------------
Brave on David's Mac | Live 1080p | Side panel linked | Agent can control
```

#### Empty State

Title: `Connect browser tab`

Primary actions:

- `Open app preview`
- `Attach active tab`
- `New blank tab`
- `Pair browser`

Copy:

```text
This uses your existing browser profile. The agent for this thread only controls linked tabs.
```

States:

- No browser agent: primary action is `Pair browser`.
- Browser agent connected, no preview URL: primary action is `New blank tab`.
- Preview URL detected: primary action is `Open app preview`.

#### Connected State

Header shows:

- Browser agent label.
- Workspace state.
- Agent access state.
- Deep control state.
- Side panel state.

Toolbar actions:

- Back.
- Forward.
- Reload/stop.
- URL input.
- Open in browser.
- Screenshot.
- Annotate.
- Create agent tab.
- Attach active tab.
- Pause control.
- Enable/disable deep control.
- More menu.

Tab list actions:

- Focus.
- Rename.
- Set purpose.
- Promote to primary.
- Close.
- Mark handoff.
- Detach from thread.
- Enable/disable deep control for tab.

#### Multi-Agent Grouping

When orchestration creates multiple agent tabs, group tabs by owner:

```text
Primary
  localhost:3000

Agent: Frontend QA
  /settings
  /billing

Agent: Docs Research
  React Router docs
  Stripe docs
```

The user can collapse groups, focus individual tabs, or close all ephemeral tabs for a group.

### 2. Projected Browser Thread Tabs

Each browser workspace tab can appear in the T3 thread tab strip as a browser tab.

Example tab strip:

```text
[Chat] [Browser: Primary] [Browser: Settings QA] [Browser: Stripe Docs] [+]
```

Projected browser tab contents:

```text
Browser: Settings QA
----------------------------------------------------------------------------
Owner: Agent - Frontend QA        Role: agent        Stream: Live
URL: http://localhost:3000/settings
----------------------------------------------------------------------------
[Back] [Forward] [Reload] [URL input........................] [Open in Browser]
[Pause Agent] [Annotate] [Screenshot] [Deep: Off] [...]
----------------------------------------------------------------------------
Live streamed browser surface
----------------------------------------------------------------------------
Brave on David's Mac | Real tab #184 | Side panel linked | Agent can control
```

Tab label behavior:

- Primary tab: `Browser: Primary` or the app name when known.
- Agent tab: `Browser: <purpose>` or `Browser: <agent label>`.
- Scratch tab: `Browser: Scratch`.
- Handoff tab: `Browser: Handoff`.
- Closed tab: muted label plus warning icon.
- Deep-control tab: subtle debugger indicator.
- Live stream tab: live dot.

Interaction behavior:

- Selecting a projected T3 tab starts or resumes streaming for that real browser tab.
- Leaving the projected tab may keep streaming live, downgrade to screenshot fallback, or pause
  based on performance policy.
- T3 keyboard/mouse input targets the selected projected browser tab.
- Agent commands target workspace tab IDs, not the currently selected T3 tab, unless the user is
  manually controlling the surface.
- A user can detach the projection while leaving the real browser tab open.
- A user can close both the T3 projection and the real browser tab in one action.

Projection actions:

- `Focus in Browser`.
- `Open in T3`.
- `Detach projection`.
- `Close real tab`.
- `Promote to primary`.
- `Rename`.
- `Mark handoff`.
- `Pause agent control`.

Streaming states:

```text
Live
Starting
Paused to save resources
Screenshot fallback
Closed
Disconnected
Error
```

### 3. Preview Button Flow

Preview remains the low-friction path.

Behavior:

- If an appropriate browser agent is connected, open/focus the thread primary tab.
- If no agent is connected, auto-pair when possible.
- If the extension is missing or auto-pair fails, show an actionable error.
- If a primary tab already exists, focus it rather than opening a duplicate.
- If the tab exists but was closed, reopen it.

### 4. Extension Popup

The popup is the extension's quick status and repair surface.

Sections:

- Connection status.
- Paired backend URL.
- Browser agent identity.
- Active workspace/tab.
- Side panel state.
- Deep control state.
- Last error.
- Diagnostics summary.

Primary actions:

- Pair.
- Forget.
- Reconnect.
- Open diagnostics.
- Detach debugger from all tabs.
- Open T3 backend.

Popup healthy example:

```text
T3 Code Browser Agent

Connected: http://127.0.0.1:3773
Browser: Brave
Workspace: thread "Fix checkout flow"
Side panel: linked
Deep control: off

socket: open
lastHello: 2026-06-04T12:15:30.804Z
environment: ok
auth-session: ok
ws-token: ok
```

Popup broken example:

```text
T3 Code Browser Agent

Paired: http://127.0.0.1:3773
Socket: reconnecting
Last error: WebSocket token rejected

[Reconnect] [Forget] [Diagnostics]
```

### 5. Native Side Panel

The side panel remains a first-class UX feature.

Purpose:

- Show the linked T3 thread beside the real browser tab.
- Let the user keep chat/context visible while using the app.
- Follow the active linked tab.
- Provide quick actions: annotate, pause agent control, open thread, detach.

Behavior:

- When Preview opens or focuses a primary tab, the extension attempts to open the side panel.
- If Chrome blocks automatic opening, the extension sets a badge/prompt telling the user to click
  the extension icon.
- When the user switches to a linked tab, the side panel shows that tab's thread.
- When a tab is detached or closed, the side panel association is cleared.
- Side panel auth uses a sidebar-scoped bearer handoff, not third-party cookies.

Side panel layout:

```text
T3 Code
----------------------------------------------------------------------------
Thread: Fix checkout flow                         [Pause Agent] [Annotate]
----------------------------------------------------------------------------
Chat transcript / composer
----------------------------------------------------------------------------
Browser tab
localhost:3000/checkout
Side panel linked | Agent control on | Deep off
```

### 6. Annotation Overlay

The annotation flow remains first-class.

Flow:

1. User clicks `Annotate` in T3 or side panel.
2. Backend sends `annotation.activate`.
3. Extension focuses the linked tab.
4. Content script enters annotation mode.
5. Hovering highlights candidate elements.
6. User clicks an element.
7. Extension captures a cropped screenshot and element metadata.
8. Extension sends `annotation.submitted`.
9. T3 appends an annotation message with screenshot attachment.
10. Overlay exits.

Overlay UI:

- Visible hover outline.
- Small floating instruction label.
- `Esc` cancels.
- Clicking outside valid target either selects page/body or shows a retry hint.
- If capture fails, submit text/selector metadata with a clear failure note.

Annotation payload:

```ts
type AnnotationPayload = {
  workspaceId: string;
  tabId: string;
  url: string | null;
  title: string | null;
  note?: string;
  element: {
    selectorCandidates: string[];
    text: string | null;
    role: string | null;
    boundingBox: { x: number; y: number; width: number; height: number } | null;
  };
  screenshot?: {
    dataUrl: string;
    crop: { x: number; y: number; width: number; height: number };
  };
};
```

### 7. Diagnostics Page

A full diagnostics page is available from the popup and T3 UI.

Sections:

- Extension version and build ID.
- Manifest permissions.
- Browser name/version.
- Backend URL and descriptor.
- Auth session state.
- WebSocket state.
- Current connected agent ID.
- Workspaces and tabs.
- Side panel state.
- Annotation state.
- CDP attach state.
- Recent command log.
- Recent errors.

Actions:

- Copy diagnostics JSON.
- Clear logs.
- Force reconnect.
- Re-request tab snapshot.
- Detach all debugger sessions.
- Forget backend.

Diagnostics JSON must not include bearer tokens, WS tokens, cookies, or page secrets.

### 8. Permission And Safety Prompts

T3 should explain deep control before enabling it.

Prompt title:

```text
Enable deep browser control for this thread?
```

Prompt copy:

```text
This lets the agent use Chrome DevTools Protocol on linked tabs in this thread. It can inspect the
page, dispatch input, capture screenshots, read console output, and observe network activity. You
can pause or detach control at any time.
```

Actions:

- `Enable deep control`
- `Keep standard control`

Secondary options:

- `Remember for this project`
- `Only for this thread`

## UX Flows

### Flow 1: First Install And Pair

1. User opens T3 and clicks Preview.
2. T3 detects no connected browser agent.
3. T3 creates an auto-pair credential.
4. T3 opens `/browser-agent/auto-pair` in the default browser.
5. Content script sends the credential to the extension service worker.
6. Extension exchanges it for a bearer session.
7. Extension stores backend URL and session token.
8. Extension requests a WS token.
9. Extension connects to `/browser-agent/ws`.
10. Extension sends hello and capabilities.
11. T3 retries the Preview command.
12. Extension opens/focuses the primary tab and side panel.

Success criteria:

- User does not manually paste a token for the common local flow.
- T3 shows the browser agent as connected.
- Popup diagnostics show environment/auth/ws-token as healthy.

Failure states:

- Extension not installed.
- Content script did not respond.
- Backend unreachable from browser.
- Credential expired.
- WS token rejected.
- WebSocket failed.

### Flow 2: Manual Pair From Popup

1. User opens extension popup.
2. User enters backend URL.
3. User enters pairing token.
4. Extension exchanges token for bearer session.
5. Extension connects WebSocket.
6. Popup shows connection diagnostics.

Success criteria:

- Manual pairing works for local and remote reachable backends.
- Popup clearly distinguishes paired, connected, and authenticated states.

### Flow 3: Open Primary Preview Tab

1. User clicks Preview or `Open app preview`.
2. T3 resolves preview URL.
3. Backend selects connected browser agent.
4. If workspace exists, command targets primary tab.
5. If workspace does not exist, backend creates workspace and primary tab record.
6. Extension opens/focuses tab.
7. Extension groups/labels tab if supported.
8. Extension sets side panel thread.
9. Extension streams tab snapshot.
10. T3 browser panel shows connected state.

Acceptance criteria:

- Repeated Preview clicks do not create duplicate primary tabs.
- If the tab was closed, T3 shows a closed state and can reopen.
- Side panel opens when possible.

### Flow 4: Attach Current Browser Tab

1. User navigates directly in browser.
2. User opens T3 browser panel.
3. User clicks `Attach active tab`.
4. Backend sends `tab.attachActive`.
5. Extension records the active tab as a workspace tab.
6. User picks role: primary, agent, scratch, or handoff.
7. Side panel links to the current thread.

Acceptance criteria:

- User can attach an already-authenticated page.
- T3 shows the actual URL/title.
- Agent control follows the thread's control state.

### Flow 5: Agent Creates Additional Tab

1. Agent decides it needs a second tab.
2. Agent calls a T3 browser tool such as `browser_tab_create`.
3. Backend verifies thread authorization.
4. Backend creates an agent tab record with owner metadata.
5. Extension opens a background or foreground tab depending on command params.
6. T3 browser panel shows the new tab under the agent/run group.
7. Agent commands target that tab by workspace tab ID.

Acceptance criteria:

- Agent-created tab is visibly associated with the thread and run.
- Agent cannot create tabs outside an authorized workspace.
- User can focus, close, or mark the tab as handoff.

### Flow 6: Multi-Agent Orchestration

1. A T3 orchestration starts multiple agent runs for the same thread.
2. Each agent can create one or more tabs.
3. Each created browser tab is projected into the T3 thread tab strip.
4. T3 groups projected tabs by agent/run in the browser panel.
5. Agents operate independently in their own real browser tabs.
6. User can inspect progress by switching projected T3 tabs or real browser tabs.
7. When an agent finishes, T3 applies tab lifecycle policy:
   - close ephemeral tabs and remove projections,
   - retain persistent tabs and projections,
   - mark handoff tabs.

Acceptance criteria:

- Two agents cannot accidentally send input to the same tab unless explicitly sharing it.
- Primary tab remains stable.
- User can close all projected tabs for one agent group.

### Flow 7: Stream Browser Tab Into T3 Tab

1. A browser workspace tab exists or is created.
2. Backend creates a projected T3 thread tab for that workspace tab.
3. T3 adds the projected tab to the thread tab strip.
4. User selects the projected T3 tab.
5. T3 requests `tab.stream.start` for the workspace tab.
6. Extension starts live capture or screenshot fallback.
7. T3 renders the streamed browser surface inside the projected tab.
8. User input in the streamed surface routes to the real browser tab.
9. Real browser navigation/title/status updates update the projected T3 tab.
10. If the user leaves the projected tab, T3 applies stream policy: keep live, downgrade, or pause.

Acceptance criteria:

- Every primary or agent browser tab can be represented as a T3 tab.
- Selecting the T3 tab shows the corresponding real browser tab stream.
- Closing the real browser tab does not silently remove history; T3 shows `Closed` with `Reopen`.
- Closing the T3 tab asks whether to close the real browser tab or only detach the projection.
- Agent-owned projected tabs show owner/purpose metadata.
- Stream errors degrade to screenshot fallback when possible.

### Flow 8: Browser-To-T3 Focus Sync

1. User focuses a linked real browser tab directly in the browser.
2. Extension observes active tab change.
3. Extension sends tab focus/update event to backend.
4. T3 marks the matching projected browser tab as active in-browser.
5. If follow mode is enabled, T3 switches to the matching projected tab.
6. If follow mode is disabled, T3 only updates status indicators.

Acceptance criteria:

- Browser focus changes are visible in T3.
- T3 does not unexpectedly steal focus unless follow mode is enabled.
- Follow mode is per-thread or per-workspace, not global by default.

### Flow 9: Projected Tab Close Or Detach

1. User closes a projected browser tab in T3.
2. T3 asks whether to close the real browser tab or detach only the T3 projection when the lifecycle
   is persistent or handoff.
3. For ephemeral agent tabs, T3 can default to closing the real browser tab.
4. Backend sends `tab.close` or updates projection state.
5. Extension closes the real tab when requested.
6. T3 removes or marks the projection based on result.

Acceptance criteria:

- The user can leave real browser tabs open while cleaning up T3 tabs.
- Ephemeral agent tabs can be closed without extra friction.
- Closing primary tab requires confirmation or offers immediate undo.

### Flow 10: Enable Deep Chrome Control

1. Agent requests a deep-control operation or user toggles `Deep control`.
2. T3 shows the deep-control prompt.
3. User enables deep control for thread/project.
4. Backend sends `cdp.attach`.
5. Extension attaches debugger to selected tab.
6. T3 shows `Deep: On` and tab-level debugger state.
7. Agent can use CDP-backed commands.

Acceptance criteria:

- User can see which tabs have debugger attached.
- User can detach one tab or all tabs.
- If Chrome blocks/interrupts debugger attach, T3 shows a concrete error.

### Flow 11: Pause And Resume Agent Control

1. User clicks `Pause agent control`.
2. Backend marks workspace control as paused.
3. Extension detaches debugger for affected tabs.
4. Standard user interaction remains available.
5. Agent browser commands fail with a useful error.
6. User clicks `Resume`.
7. Control state returns to standard or deep depending on prior state.

Acceptance criteria:

- Paused state is visible in T3 and side panel.
- Pausing takes effect immediately.
- Resume does not silently reattach debugger unless deep control was previously enabled.

### Flow 12: Annotate UI

1. User clicks `Annotate`.
2. Extension focuses linked tab.
3. Overlay activates.
4. User selects element.
5. Extension captures screenshot/metadata.
6. Annotation message appears in T3 thread.
7. Overlay exits.

Acceptance criteria:

- Works from T3 browser panel and side panel.
- `Esc` cancels.
- Tab close/disconnect exits overlay.
- Failure to screenshot still sends useful metadata when possible.

### Flow 13: Side Panel Blocked By Browser

1. Extension attempts `sidePanel.open`.
2. Browser refuses because action requires a user gesture or tab context.
3. Extension sets badge/prompt on the tab.
4. Content script may show a small prompt: `Click the T3 extension to open side panel`.
5. User clicks extension icon.
6. Side panel opens with the correct thread.

Acceptance criteria:

- User gets a clear next action.
- Prompt clears after side panel opens.
- Prompt does not keep reappearing after dismissal unless user triggers Preview again.

### Flow 14: Extension Disconnects

1. WebSocket closes or service worker restarts.
2. Extension reconnects using stored backend/session.
3. Extension sends hello and full tab/workspace snapshot.
4. Backend reconciles state.
5. T3 browser panel updates.

Acceptance criteria:

- Existing workspace tabs remain visible in T3 as remembered state.
- Commands fail only while no agent is connected.
- Reconnect does not create duplicate workspace records.

### Flow 15: Protocol Mismatch Or Update Required

1. Extension connects with unsupported protocol version or missing required capability.
2. Backend marks agent as connected but incompatible.
3. T3 shows `Extension update required`.
4. Popup diagnostics show missing capability/protocol mismatch.
5. User updates/reloads unpacked extension package.
6. Extension reconnects and advertises new capabilities.

Acceptance criteria:

- The failure does not look like a pairing/auth issue.
- T3 tells the user exactly which extension version/capability is missing.

### Flow 16: Emergency Detach

1. User clicks `Detach all browser control`.
2. Backend pauses all workspaces for the current browser agent.
3. Extension detaches all debugger sessions.
4. Extension cancels active annotation overlays.
5. Extension stops live capture.
6. T3 shows all workspaces as paused.

Acceptance criteria:

- Emergency detach works from popup and T3 UI.
- No browser command can run until user resumes.

## User Stories And Acceptance Criteria

### Story: Developer Opens Preview

As a developer, I want Preview to open the app in my real browser and show the T3 thread in the side
panel, so I can work in my normal browser profile.

Acceptance criteria:

- Preview creates or focuses one primary tab for the thread.
- Side panel links to the thread.
- Repeated Preview clicks are idempotent.
- Missing extension, disconnected extension, and update-required states are distinct.

### Story: Developer Annotates UI Bug

As a developer, I want to click a UI element and send a screenshot-backed annotation to T3, so the
agent can understand exactly what I mean.

Acceptance criteria:

- Annotation mode highlights elements.
- Selected element metadata and screenshot are sent to T3.
- The annotation is appended to the correct thread.
- Escape/cancel works.

### Story: Agent Uses Thread Browser

As an agent, I want browser tools scoped to the current thread, so I can inspect and interact with
the user's app without affecting unrelated tabs.

Acceptance criteria:

- Browser tools resolve the current thread workspace server-side.
- Agent cannot address raw browser tab IDs outside the workspace.
- Paused control rejects commands.
- Errors include actionable messages.

### Story: Agent Creates Multiple Tabs

As an agent doing orchestration, I want to create multiple tabs under my run, so I can compare pages,
research docs, and test flows in parallel.

Acceptance criteria:

- New tabs are grouped under the agent/run.
- Each tab has owner/purpose/lifecycle metadata.
- User can inspect, focus, close, or mark handoff.
- Tabs do not become primary unless promoted.

### Story: Browser Tabs Stream As T3 Tabs

As a user, I want each real browser tab in a thread workspace to appear as a streamed tab inside T3
Code, so I can switch between browser work surfaces the same way I switch between chat, terminal,
diff, or other thread tabs.

Acceptance criteria:

- Primary and agent browser tabs are represented in the T3 thread tab strip.
- Selecting a projected T3 tab displays the live stream for the corresponding real browser tab.
- T3 tab labels reflect browser tab role, title, owner, stream state, and error state.
- Closing a projected T3 tab gives the correct close-vs-detach behavior for its lifecycle.
- Browser-side focus, navigation, title, loading, and close events update projected T3 tabs.
- Streaming can degrade to screenshot fallback without detaching the browser tab.

### Story: User Enables Deep Control

As a user, I want to enable deep Chrome control for a thread when needed, so agents can use CDP for
advanced inspection and input.

Acceptance criteria:

- Deep control requires explicit activation.
- The UI shows when debugger is attached.
- User can detach debugger per tab or globally.
- CDP commands are audited.

### Story: User Debugs Pairing

As a user, I want the popup and diagnostics page to explain why pairing failed, so I do not have to
guess between auth, backend URL, WebSocket, stale extension, or protocol mismatch.

Acceptance criteria:

- Popup shows environment, auth session, WS token, socket state, and last error.
- Diagnostics page can copy safe JSON.
- Tokens and cookies are never included in copied diagnostics.

## Error Model

Standard error fields:

```ts
type BrowserRuntimeError = {
  code:
    | "extension-unpaired"
    | "backend-unreachable"
    | "auth-invalid"
    | "ws-token-failed"
    | "socket-disconnected"
    | "protocol-mismatch"
    | "capability-missing"
    | "workspace-not-found"
    | "tab-not-found"
    | "tab-closed"
    | "control-paused"
    | "deep-control-disabled"
    | "debugger-attach-failed"
    | "command-timeout"
    | "permission-denied"
    | "page-script-failed";
  message: string;
  details?: unknown;
};
```

Every command failure must map to one of these codes or a deliberately added new code.

## Safety And Privacy

- Extension never executes remote extension JS.
- Bearer tokens and WS tokens are never displayed or copied in diagnostics.
- Agent tools are authorized server-side by thread/workspace.
- Deep control requires explicit user activation.
- CDP commands are audited with method, target workspace tab, timestamp, and caller.
- Sensitive payloads such as cookies, authorization headers, form values, and local storage dumps
  require a separate policy decision before exposure to agents.
- User can pause control per thread.
- User can emergency detach all control from popup.

## Update Strategy

Because remote executable code is not allowed, updates happen by package replacement.

Update flow:

1. Backend exposes latest extension package/version metadata.
2. T3 compares connected extension version and capabilities.
3. If incompatible, T3 shows update-required UI.
4. User installs/reloads the unpacked extension or a future installer updates the package.
5. Extension reconnects with the new protocol/capabilities.

The server may evolve orchestration and command payloads freely as long as it only sends commands
supported by the installed extension.

## Implementation Phases

### Phase 1: Stabilize Current Runtime

- Keep existing side panel and annotation flows.
- Keep current Preview behavior.
- Keep diagnostics in popup.
- Keep protocol capability negotiation.
- Fix session selection so connected browser-agent sessions are valid even when separate from the
  UI session.
- Add integration test harness that launches Chromium with unpacked extension.

### Phase 2: Modular Extension Runtime

- Split service worker into transport, command router, storage, tabs, side panel, annotation,
  diagnostics modules.
- Add ring-buffer logs.
- Add diagnostics page.
- Add typed command registry.
- Add capability-gated command dispatch.

### Phase 3: Workspace And Multi-Tab Model

- Replace one workspace link per thread with browser workspace plus tabs.
- Add primary tab and agent tab roles.
- Add tab owner/purpose/lifecycle metadata.
- Project browser workspace tabs into the T3 thread tab strip.
- Add live stream and screenshot fallback state per projected browser tab.
- Add T3 browser panel tab grouping.
- Add agent tab create/focus/close/promote commands.
- Add close-vs-detach lifecycle handling for projected browser tabs.

### Phase 4: Deep Chrome Control

- Add `debugger` permission.
- Add CDP attach/detach/send module.
- Add deep-control UI prompt.
- Add tab-level debugger state.
- Add CDP audit log.
- Add emergency detach.

### Phase 5: Agent Browser Tool Bridge

- Expose T3-owned browser tools to agents.
- Resolve every tool call through current provider session/thread workspace.
- Add multi-agent tab allocation.
- Add lifecycle cleanup policies for ephemeral tabs.

### Phase 6: Production Hardening

- Retry/backoff tuning.
- Reconnect reconciliation.
- Protocol mismatch UI.
- Safe diagnostic export.
- Update/install UX.
- End-to-end tests for pairing, preview, side panel, annotation, multi-tab, and CDP attach.
- End-to-end tests for projected T3 browser tabs, live stream start/stop, screenshot fallback, and
  real-tab close recovery.

## Testing Strategy

### Unit Tests

- Command router capability gating.
- Workspace/tab state transitions.
- Error mapping.
- Diagnostics redaction.
- Control-state authorization.

### Integration Tests

- Launch Chromium with unpacked extension.
- Pair against local test backend.
- Verify hello/capabilities.
- Open primary preview tab.
- Verify projected browser tab appears in T3 thread tab state.
- Start and stop tab streaming.
- Open side panel state.
- Activate/cancel annotation.
- Create multiple agent tabs.
- Verify agent tabs project into T3 as separate streamed browser tabs.
- Attach/detach debugger.

### Manual QA

- Brave default browser.
- Chrome.
- Remote Tailscale backend.
- Service worker restart.
- Browser restart.
- Extension reload.
- Backend restart.
- Closed tab recovery.
- Projected tab close vs real browser tab close.
- Side panel blocked-by-gesture recovery.

## Open Product Decisions

- Should deep control default to thread-only or project-wide after first enablement?
- Should agent-created tabs open foreground or background by default?
- What tab lifecycle policy should apply when a multi-agent run completes?
- Should the extension auto-group tabs using browser tab groups, or should grouping be UI-only in
  T3?
- Which CDP domains are allowed by default?
- Should network request bodies ever be exposed to agents?
- Should side panel show full chat composer or a compact thread companion?

## Draft UI Copy

### Deep Control Prompt

```text
Enable deep browser control for this thread?

This lets the agent use Chrome DevTools Protocol on linked tabs in this thread. It can inspect the
page, dispatch input, capture screenshots, read console output, and observe network activity. You
can pause or detach control at any time.

[Enable deep control] [Keep standard control]
```

### Paused Control Banner

```text
Browser control paused

The agent cannot interact with linked browser tabs for this thread. You can still use the browser
manually.

[Resume control] [Detach tabs]
```

### Update Required Banner

```text
Browser extension update required

This thread needs browser runtime capability cdp.attach, but the connected extension only supports
runtime protocol 1.

[Download latest extension] [Open diagnostics]
```

### Side Panel Prompt

```text
Click the T3 extension icon to open the thread side panel.
```

### Diagnostics Redaction Notice

```text
Diagnostics exclude bearer tokens, WebSocket tokens, cookies, and page secrets.
```
