# Thread-Scoped Browser Tab Agent

Status: draft product and implementation spec

## Summary

Add a first-class `Browser` tab beside each chat thread. The browser tab represents one real tab in
the user's paired browser, preferably Brave when that is the user's default browser agent. Browser
profile state is shared: cookies, login sessions, extensions, autofill, and SSO live in the user's
normal browser profile. Authority is scoped: each coding agent can only view and control the browser
tab linked to its own T3 thread.

The T3 UI should render a live mirrored view of the linked browser tab using extension-based tab
capture. User input in the mirrored surface is forwarded to the real browser tab. Agent browser tools
are exposed through a T3-owned MCP bridge that validates every command against the thread's browser
workspace link before routing it to the paired browser agent.

This is not full browser-session isolation. It is tab-scoped control over a shared browser session.

## Goals

- Give every thread a browser tab that feels embedded in T3 Code.
- Prefer controlling an existing user browser profile, including Brave.
- Preserve user login state and installed extensions.
- Scope each agent to one browser tab per thread by default.
- Let the user see exactly what the agent sees and controls.
- Support local app preview, authenticated web apps, SSO flows, and manual user takeover.
- Keep browser access explicit, visible, revocable, and auditable.
- Reuse the existing browser-agent registry, workspace links, sidebar auth, and annotation direction.

## Non-Goals

- Do not fully isolate browser cookies or login state per thread.
- Do not let a thread agent control all browser tabs by default.
- Do not mount an existing Brave native tab view inside Electron. Existing Brave tabs can be mirrored,
  but their native view remains owned by Brave.
- Do not make iframe embedding the primary rendering strategy. Many real apps block iframe embedding.
- Do not expose unrestricted browser automation MCP directly to Codex without a T3 authorization layer.
- Do not support arbitrary browser automation across the user's whole profile in the MVP.

## Definitions

- **Browser agent**: The paired browser extension connected to the T3 backend.
- **Browser tab**: A real tab in Brave, Chrome, Edge, or another supported Chromium browser.
- **Thread browser link**: Durable mapping between a T3 thread and one browser tab.
- **Mirrored browser view**: The live visual stream of the real browser tab rendered inside T3.
- **Tab authority**: The set of capabilities granted to a thread agent for its linked tab.
- **T3 Browser MCP**: A T3-owned MCP bridge that exposes browser tools for the current thread only.

## Product Model

### Shared Profile, Scoped Authority

The user browser profile remains shared. If the user is logged into GitHub, Linear, Vercel, an
internal admin app, or a staging dashboard in Brave, agents can use that state when the user grants a
thread access to a tab.

The isolation boundary is not the browser profile. The isolation boundary is:

```text
environmentId + threadId -> browserAgentId + windowId + tabId + allowed origins/capabilities
```

Each agent receives browser tools that implicitly target its own thread link. The agent does not pass
raw `tabId` values. The server resolves the thread from the provider session and looks up the link.

### Real Browser Ownership

The real page is loaded in Brave. T3 shows a live mirror. This avoids iframe restrictions, preserves
extensions and user profile state, and lets the user interact in either place:

- Interact in T3 mirrored view.
- Interact directly in Brave.
- Let the agent interact through T3 Browser MCP tools.

All three control paths update the same real tab.

## Current Codebase Fit

The repo already has much of the browser-agent foundation:

- Browser agent contracts in `packages/contracts/src/browserAgent.ts`.
- Browser agent WebSocket route in `apps/server/src/browserAgents/ws.ts`.
- In-memory browser agent registry and workspace links in
  `apps/server/src/browserAgents/registry.ts`.
- Preview open/focus UI in `apps/web/src/components/chat/PreviewButton.tsx`.
- Browser-agent sidebar auth in the primary environment auth flow.
- Existing thread tabs, currently limited to `ThreadTabType = "chat"`.

The main additions are:

- Add `browser` as a thread tab type or add a parallel thread panel model.
- Add live tab capture and mirrored rendering.
- Add a T3-owned MCP bridge with per-thread authorization.
- Add browser command/result protocol for snapshots, clicks, typing, navigation, screencast state,
  console/network inspection, and lifecycle recovery.

## UX Principles

1. **Visible control**: The user can always tell when a thread has browser access.
2. **One thread, one tab**: A browser tab belongs to exactly one active thread link by default.
3. **Shared session is intentional**: UI copy should say the browser uses the user's existing browser
   profile.
4. **Manual takeover is normal**: The user can operate the page directly in Brave or in T3.
5. **Failure states are concrete**: Missing extension, disconnected browser, closed tab, capture
   blocked, permission denied, and page unreachable are distinct states.
6. **No surprise broad access**: The agent never gets unrestricted browser-wide tools unless the user
   explicitly grants a broader mode later.

## Primary UX

### Thread Tab Strip

For a server-backed chat thread, the tab strip should support:

- `Chat` tab
- `Browser` tab
- Future tabs such as `Diff`, `Logs`, or `Preview` if the product expands

Initial layout:

```text
[ Chat ] [ Browser ]                                      [+]
```

The `Browser` tab label should include compact state:

- No link: muted browser icon
- Linked and idle: normal browser icon
- Agent controlling: animated or accent ring
- Capture active: small live dot
- Error: warning icon

Avoid long status text in the tab. Use tooltip and panel-level status bars.

### Browser Panel Empty State

When the thread has no browser tab linked:

Title: `Connect browser tab`

Actions:

- `Open app preview`
- `Attach current Brave tab`
- `New blank tab`

Supporting status:

- If no browser agent is connected: show `Pair Brave extension` as the primary action.
- If browser agent exists but no capture permission: show `Enable live view`.
- If the project has `browserPreviewUrl` or detected dev server URL: default to `Open app preview`.

Copy should be short and explicit:

```text
This uses your existing Brave profile. The agent for this thread will only control the linked tab.
```

### Browser Panel Connected State

When linked:

Top toolbar:

- Back
- Forward
- Reload/Stop
- URL display/input
- Open in Brave
- Capture toggle
- Agent access toggle
- More menu

Main area:

- Live mirrored browser surface.
- If live capture is unavailable, show latest screenshot with `Refresh` and `Enable live view`.

Bottom or top status strip:

- Browser agent name, for example `Brave on David's Mac`
- Linked thread state
- Capture quality, for example `Live 1080p`
- Agent access state, for example `Agent can control this tab`

### Agent Access Toggle

The browser panel should separate user viewing from agent control:

- `Agent access: On`
- `Agent access: Paused`

When paused:

- User can still view/control the browser in T3.
- Agent MCP calls fail with a clear message: `Browser access is paused for this thread.`
- Chat UI should show a small paused-browser indicator if the agent attempts to use the browser.

### Live View Interaction

Mouse and keyboard in the mirrored browser surface should work like a remote browser:

- Click, double-click, right-click where supported.
- Type text into focused fields.
- Keyboard shortcuts forwarded when the browser surface is focused.
- Scroll with trackpad/wheel.
- Drag support after MVP if needed.

Focus affordance:

- When the mirrored view has keyboard focus, show a subtle focus ring.
- Escape returns keyboard focus to the T3 shell.

### Browser Tab Lifecycle

If the real Brave tab is closed:

Panel state:

```text
Browser tab closed
[Reopen] [Attach another tab]
```

If the tab navigates away:

- Keep the link unless the user detaches it.
- Show current URL.
- If origin changed from the expected dev server origin, show a non-blocking indicator.

If the browser agent disconnects:

Panel state:

```text
Brave extension disconnected
The linked tab is still remembered. Reconnect Brave to resume live view and agent control.
[Retry] [Pair browser]
```

## User Stories

### Story 1: Open App Preview In Brave

As a developer, I want a thread to open my local app in Brave so the agent and I can inspect the UI
using my normal login state.

Flow:

1. User opens a thread.
2. User clicks `Browser`.
3. T3 detects `browserPreviewUrl` or a dev server URL.
4. User clicks `Open app preview`.
5. T3 selects the connected Brave browser agent.
6. Browser agent opens or focuses a Brave tab.
7. T3 stores the thread browser link.
8. T3 starts live capture.
9. Browser panel shows the mirrored tab.
10. Agent browser tools become available for that thread.

Acceptance:

- The tab opens in Brave.
- The same tab is mirrored in T3.
- Existing Brave login state is available.
- Only the active thread's agent can control the linked tab.

### Story 2: Attach Existing Brave Tab

As a developer, I want to attach an already-open authenticated page to a thread.

Flow:

1. User logs into a site in Brave.
2. User opens the thread's `Browser` tab in T3.
3. User clicks `Attach current Brave tab`.
4. Browser extension reports eligible active tabs.
5. User confirms the selected tab.
6. T3 creates the thread browser link.
7. T3 starts mirroring the tab.

Acceptance:

- The page is not reloaded unless required.
- The agent only controls the attached tab.
- User can detach the tab later.

### Story 3: User Takes Over

As a developer, I want to manually fix login, CAPTCHA, or a complex UI state while keeping the same
thread browser tab.

Flow:

1. Agent reaches a login or verification step.
2. T3 shows the page in the browser panel.
3. User clicks into the mirrored view and completes the flow, or opens the real tab in Brave.
4. Agent continues using the same tab after user finishes.

Acceptance:

- Agent does not lose tab context.
- No cookie export/import is needed.
- User actions in Brave are reflected in T3.

### Story 4: Pause Agent Browser Control

As a developer, I want to pause agent control without closing the tab.

Flow:

1. User opens browser panel.
2. User switches `Agent access` to paused.
3. Agent attempts a browser action.
4. T3 rejects the MCP call and records a visible activity.
5. User resumes access.
6. Agent can continue.

Acceptance:

- Viewing remains available while control is paused.
- Rejected tool calls have clear errors.
- Pause state is per thread.

### Story 5: Multiple Agents, Multiple Tabs

As a developer, I want two threads to work against the same logged-in browser profile without
controlling each other's pages.

Flow:

1. Thread A opens a browser tab.
2. Thread B opens a browser tab.
3. Both tabs run in the same Brave profile.
4. Each thread sees only its own browser panel.
5. Agent A cannot control thread B's tab.

Acceptance:

- Both tabs share login state.
- Links are tracked separately by `threadId`.
- Agent commands are rejected if they do not match the current thread link.

### Story 6: Closed Or Lost Tab Recovery

As a developer, I want clear recovery when the real Brave tab disappears.

Flow:

1. User closes the linked Brave tab.
2. Browser agent sends tab removal/update.
3. T3 marks the link as `needs-tab`.
4. Browser panel shows `Reopen` and `Attach another tab`.
5. User chooses an action.

Acceptance:

- The thread link is not silently deleted.
- Agent browser tools fail with actionable error until a tab is restored.
- Reopen uses the last known URL.

## UI States

### Browser Link State

```ts
type ThreadBrowserLinkState =
  | "unlinked"
  | "opening"
  | "linked"
  | "needs-tab"
  | "agent-disconnected"
  | "capture-permission-needed"
  | "capture-active"
  | "capture-paused"
  | "error";
```

### Capture State

```ts
type BrowserCaptureState =
  | "off"
  | "requesting-permission"
  | "live"
  | "screenshot-fallback"
  | "blocked"
  | "error";
```

### Agent Control State

```ts
type BrowserAgentControlState = "enabled" | "paused-by-user" | "paused-by-policy" | "unavailable";
```

## Browser Rendering Strategy

### Preferred: Extension Tab Capture

The browser extension captures the linked tab as a `MediaStream` and streams frames to T3. The T3
web app renders the stream in the browser panel.

Implementation options:

- WebRTC peer connection between extension/offscreen document and T3 web app.
- WebSocket transport with encoded frames if WebRTC is too much for MVP.
- Screenshot fallback using `captureVisibleTab` for low-frequency refresh.

Expected quality:

- 720p or 1080p target.
- 30fps target for local use.
- 50-150ms local latency target with WebRTC.
- Screenshot fallback should be treated as degraded mode.

Known limitations:

- Captures page content, not browser chrome.
- Capture may need explicit user activation/permission.
- Audio capture has browser-specific behavior and should be deferred unless needed.
- Text clarity depends on bitrate and scaling.

### Alternative: CDP Screencast

If the user enables CDP connection for Brave, T3 can mirror via `Page.startScreencast` and route input
over CDP. This is powerful but exposes broad debugging capabilities. It should be opt-in and clearly
labeled.

### Rejected For This Feature: Electron WebContentsView

Electron can render embedded web contents, but that would be an Electron Chromium session, not the
user's existing Brave profile with Brave extensions and login state. It may be useful for a separate
T3-owned browser mode, but not for "use my existing Brave" mode.

## Agent Tooling Model

### T3-Owned MCP Bridge

The Codex session should receive MCP tools from a T3-owned bridge, not direct unrestricted
browser automation access.

Every browser MCP request should include or derive:

- `environmentId`
- `threadId`
- provider session id
- browser workspace link id
- requested action

The server validates:

- The provider session belongs to the target thread.
- The thread has a browser link.
- Agent access is enabled.
- The linked browser agent is connected.
- The linked tab exists.
- The requested action is allowed by policy.

Only then does T3 route the command to the browser extension.

### Initial MCP Tools

MVP tools:

- `browser_navigate(url)`
- `browser_snapshot()`
- `browser_click(ref | coordinates)`
- `browser_type(text)`
- `browser_press_key(key)`
- `browser_scroll(delta)`
- `browser_screenshot()`
- `browser_current_page()`

Post-MVP tools:

- `browser_select_option(ref, value)`
- `browser_hover(ref)`
- `browser_drag(start, end)`
- `browser_console_messages()`
- `browser_network_requests()`
- `browser_wait_for(condition)`
- `browser_evaluate_readonly(expression)`
- `browser_file_upload(ref, filePath)`

Avoid `browser_run_code_unsafe` in the first version.

### Snapshot Strategy

Use accessibility snapshots where possible because they are compact and useful for agents. The
extension/content script can compute an accessibility-like DOM snapshot for the current tab, or T3
can use CDP behind the bridge if CDP mode is enabled.

Snapshots should include stable refs scoped to the current page version. Refs expire after
navigation, reload, or significant DOM invalidation.

## Data Model

Extend `BrowserWorkspaceLink` into a durable thread browser link:

```ts
type ThreadBrowserWorkspaceLink = {
  id: BrowserWorkspaceLinkId;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  agentId: BrowserAgentId;
  tabId: number | string | null;
  windowId: number | string | null;
  url: string | null;
  expectedOrigin: string | null;
  title: string | null;
  browserLabel: string;
  captureState: BrowserCaptureState;
  controlState: BrowserAgentControlState;
  liveViewSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
};
```

The current in-memory registry is acceptable for MVP, but durable persistence is required for
polished behavior across server restart.

## Protocol Additions

### Server To Browser Agent

```ts
type BrowserAgentCommand =
  | {
      type: "browserAgent.command.openOrFocusThreadTab";
      commandId: string;
      workspaceLink: ThreadBrowserWorkspaceLink;
      url: string;
      focus: boolean;
    }
  | {
      type: "browserAgent.command.attachActiveTab";
      commandId: string;
      workspaceLinkId: string;
    }
  | {
      type: "browserAgent.command.startTabCapture";
      commandId: string;
      workspaceLinkId: string;
      quality: {
        maxWidth: number;
        maxHeight: number;
        fps: number;
      };
    }
  | {
      type: "browserAgent.command.stopTabCapture";
      commandId: string;
      workspaceLinkId: string;
    }
  | {
      type: "browserAgent.command.input";
      commandId: string;
      workspaceLinkId: string;
      input:
        | { type: "click"; x: number; y: number; button: "left" | "middle" | "right" }
        | { type: "type"; text: string }
        | { type: "key"; key: string }
        | { type: "scroll"; deltaX: number; deltaY: number };
    }
  | {
      type: "browserAgent.command.snapshot";
      commandId: string;
      workspaceLinkId: string;
    }
  | {
      type: "browserAgent.command.screenshot";
      commandId: string;
      workspaceLinkId: string;
    };
```

### Browser Agent To Server

```ts
type BrowserAgentInbound =
  | {
      type: "browserAgent.threadTab.updated";
      workspaceLinkId: string;
      tabId: number | string | null;
      windowId: number | string | null;
      url: string | null;
      title: string | null;
      status: "loading" | "complete" | "closed" | "unknown";
    }
  | {
      type: "browserAgent.capture.started";
      workspaceLinkId: string;
      liveViewSessionId: string;
      transport: "webrtc" | "websocket";
    }
  | {
      type: "browserAgent.capture.stopped";
      workspaceLinkId: string;
      reason: "user" | "tab-closed" | "permission-revoked" | "error";
      message?: string;
    }
  | {
      type: "browserAgent.command.result";
      commandId: string;
      ok: boolean;
      payload?: unknown;
      error?: {
        code: string;
        message: string;
      };
    };
```

## Security And Privacy Requirements

- Browser capture must be visibly indicated in T3.
- Agent browser access must be visibly indicated and pausable per thread.
- T3 must reject commands for missing, closed, detached, or unauthorized tabs.
- T3 must not expose raw browser-wide tab control to Codex.
- T3 must not place browser-agent bearer tokens in page DOM or dev-page URLs.
- Extension content scripts must not receive backend bearer tokens.
- Captured frames must not be persisted unless the user or agent explicitly takes a screenshot.
- Screenshots attached to thread messages must be shown in the conversation like other image
  attachments.
- If a linked tab shows sensitive user content, the user should be able to stop capture instantly.
- CDP mode, if implemented, must be opt-in because it grants broad browser debugging authority.

## Settings UX

Add `Browser Agents` settings:

- Connected browser agents
- Browser name, profile label, extension version
- Connected/disconnected status
- Last seen
- Default browser agent preference, for example Brave
- Capture quality:
  - Auto
  - 720p
  - 1080p
  - Screenshot fallback only
- Default agent access for new browser tabs:
  - Enabled
  - Paused until manually enabled
- Revoke browser agent session
- Pair another browser

## First-Run Pairing Flow

1. User clicks `Browser` in a thread.
2. T3 sees no browser agent.
3. T3 shows `Pair Brave extension`.
4. User installs or opens the extension in Brave.
5. Extension pairs with the T3 backend.
6. T3 detects connected browser agent.
7. User continues with `Open app preview` or `Attach current Brave tab`.

Brave should be called out explicitly when detected or selected, but Chrome/Edge should continue to
work through the same browser-agent protocol.

## Error States

### No Browser Agent

```text
No paired browser
Pair the browser extension to use your existing Brave tabs with this thread.
[Pair Brave extension]
```

### Permission Needed

```text
Live view needs permission
Brave requires a user action before a tab can be captured.
[Enable live view]
```

### Tab Closed

```text
Browser tab closed
The agent cannot use the browser until this thread is linked to a tab again.
[Reopen last URL] [Attach another tab]
```

### Control Paused

```text
Agent browser access paused
You can keep browsing. The agent cannot control this tab until access is resumed.
[Resume agent access]
```

### Disconnected

```text
Browser disconnected
Reconnect the Brave extension to resume live view and agent control.
[Retry] [Pair browser]
```

## Implementation Phases

### Phase 1: Tab Link And Browser Panel

- Add `browser` tab type or a dedicated thread panel model.
- Add browser panel empty, opening, linked, and error states.
- Add RPCs for create/open/attach/detach thread browser links.
- Extend registry to track link lifecycle and tab status.
- Add focused unit tests for link selection and state transitions.

### Phase 2: Extension Tab Commands

- Add command handlers for open/focus, attach active tab, tab updates, and input forwarding.
- Add content-script snapshot and basic input execution.
- Add screenshot fallback.
- Enforce one active thread link per tab unless user confirms reassignment.

### Phase 3: Live Mirrored View

- Implement tab capture start/stop.
- Add WebRTC or frame-stream transport to T3.
- Render live stream in browser panel.
- Forward pointer/keyboard/scroll events.
- Add capture quality setting and degraded fallback.

### Phase 4: T3 Browser MCP

- Implement T3-owned MCP server or provider-runtime dynamic MCP adapter.
- Inject per-thread browser MCP config into Codex thread start/resume.
- Validate every tool call against the current thread link.
- Surface browser MCP activity in the conversation timeline.

### Phase 5: Hardening

- Persist browser links.
- Recover on extension restart, browser restart, and server restart.
- Add command timeouts and cancellation.
- Add console/network tools.
- Add remote browser-agent support over Tailscale.
- Add full manual and automated coverage.

## Testing

Unit tests:

- Link creation, update, close, detach, and reattach.
- Agent selection and preferred Brave agent behavior.
- Authorization rejects cross-thread browser commands.
- Agent access pause/resume.
- Browser MCP request validation.
- Snapshot ref expiry after navigation.

Web tests:

- Browser tab strip rendering.
- Empty state actions.
- Error state recovery actions.
- Capture state display.
- Agent access toggle behavior.

Extension tests:

- Open/focus linked tab.
- Attach active tab.
- Input forwarding.
- Screenshot fallback.
- Tab close updates.
- Capture start/stop lifecycle.

Manual acceptance:

- Pair Brave extension.
- Open local app preview in Brave.
- T3 mirrors the Brave tab.
- Use existing logged-in session.
- Agent controls only its thread tab.
- Two threads can each control separate Brave tabs.
- Pause agent access blocks browser tools.
- Closing the real tab shows recovery UI.

Required checks for implementation branches:

- `bun fmt`
- `bun lint`
- `bun typecheck`
- focused tests with `bun run test`

## Open Questions

- Should the browser tab be a true `ThreadTabType = "browser"` in orchestration, or should browser be
  a local per-thread panel that does not create/archive thread records?
- Should capture start automatically when opening the Browser tab, or only after the user clicks
  `Enable live view`?
- Should the default agent access state be enabled or paused for newly attached existing tabs?
- Do we need a "private browsing" mode later with a separate temporary profile for sensitive tests?
- Should a single Brave tab be assignable to multiple read-only threads, or should links always be
  exclusive?
- Should CDP mode be supported as an advanced option for users who want higher fidelity automation?

## References

- Existing browser-agent draft: `docs/browser-agent-extension.md`
- Chrome `tabCapture` API:
  https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- Chrome `tabs.captureVisibleTab`:
  https://developer.chrome.com/docs/extensions/reference/tabs
- Chrome DevTools Protocol `Page.startScreencast`:
  https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast
- Electron web embeds and `WebContentsView`:
  https://www.electronjs.org/docs/latest/tutorial/web-embeds
- Brave Chrome extension support:
  https://brave.com/learn/using-chrome-extensions-in-brave/
