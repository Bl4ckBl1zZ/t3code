# Browser Agent Extension Rewrite

Status: draft implementation spec

## Summary

Replace the current browser-transfer implementation with a browser-agent architecture.

The Chrome extension becomes a paired remote agent that maintains an authenticated outbound
connection to the T3 backend. T3 Code no longer launches a transient T3 browser tab and does not
infer state from tab groups. The preview tab hosts an extension sidebar that embeds the target T3
chat route with an explicit same-session bearer handoff. Same-machine browser control and remote
browser control over Tailscale use the same backend protocol.

## Goals

- Support browser control on the same machine as the T3 Code desktop app.
- Support browser control from another machine over Tailscale or any reachable backend URL.
- Let T3 Code select a paired browser agent and command it to open, focus, inspect, annotate,
  and capture dev-server tabs.
- Remove the brittle tab-group and page-bridge flow entirely.
- Avoid third-party iframe cookie dependency by using a sidebar-scoped bearer session.
- Keep browser access explicit, paired, revocable, and observable.
- Make failures predictable: disconnected agent, unreachable dev URL, missing host permissions,
  ambiguous workspace link, expired auth, and tab not found must be first-class states.

## Non-Goals

- Running an HTTP server inside the Chrome extension.
- Depending on Chrome tab groups as the source of truth.
- Depending on browser cookies inside a sidebar iframe.
- Supporting the old `t3BrowserTransfer=1` URL flow after the rewrite lands.
- Supporting native Chrome Side Panel API as the primary UI host. It may be reintroduced later,
  but the initial rewrite should use an extension-owned inline sidebar on the preview tab so the
  website can be cropped/resized reliably.

## Current Problems

The existing implementation is intentionally deprecated by this spec.

- The desktop button builds a T3 web URL containing transfer params and a one-time pairing token.
- Chrome opens that T3 URL.
- The extension content script asks the service worker to open the dev tab.
- The service worker stores a tab-id link in `chrome.storage.session`.
- The service worker removes the source T3 tab and injects a sidebar into the dev tab.
- The sidebar iframes the full T3 web app without a durable auth handoff.

This breaks for long-term use because:

- The sidebar iframe has no `desktopBridge`.
- The iframe may not receive the browser-session cookie because browser cookie policies can treat it
  as a third-party context.
- The one-time pairing credential cannot be reused reliably after the top-level T3 tab consumes it.
- Tab groups are user-managed UI state, not durable workspace state.
- A same-machine launch mechanism cannot address a browser extension on another machine.
- The extension stores only ephemeral tab links and cannot recover authoritatively after browser
  restart, service-worker restart, or remote control handoff.

## Target Architecture

```text
T3 Desktop/Web
  |
  | HTTP / app WebSocket
  v
T3 Backend
  - auth
  - browser-agent registry
  - browser workspace links
  - command routing
  ^
  |
  | outbound authenticated WebSocket
  |
Chrome Extension Browser Agent
  - tabs/windows/groups observer
  - dev-page content script injector
  - inline sidebar host
  - screenshot/annotation executor
```

The extension always initiates the connection to the backend. This works for local Chrome,
Chrome on another Tailscale device, and future hosted or SSH-forwarded environments.

## Local Flow

1. T3 desktop starts a backend, for example `http://127.0.0.1:3773`.
2. The user installs the extension once.
3. User clicks `Transfer to Browser`.
4. If no agent is connected, T3 creates a bearer alias for the current session and opens
   `/browser-agent/auto-pair` on the configured backend URL.
5. The extension content script consumes the bearer alias from the URL hash, verifies it against
   `/api/auth/session`, and stores it in `chrome.storage.local`.
6. The extension opens an authenticated browser-agent WebSocket to the backend.
7. T3 retries the transfer once the browser agent is connected.
8. T3 backend commands the local agent to open or focus the dev server URL.
9. The extension injects the inline sidebar and annotation content script into the dev tab.

## Remote Flow

1. T3 backend is reachable on a network endpoint, for example `http://100.105.249.96:3773`.
2. Chrome on another machine has the extension installed.
3. The remote extension pairs with that Tailscale URL using a bearer alias from the currently
   authenticated T3 session.
4. The remote extension opens an outbound authenticated WebSocket to T3.
5. The extension reports tabs, capabilities, and reachable origins from the remote browser.
6. User picks the remote browser agent in T3 Code or T3 auto-selects it from the workspace link.
7. T3 sends `openOrFocusPreview` with a dev URL reachable from that remote machine, for example
   `http://100.105.249.96:3000`.
8. The remote extension opens/focuses that tab and injects the sidebar.
9. Annotation screenshots and notes flow back to the backend and are appended to the target thread.

## Authentication Model

The extension is an authenticated browser agent that can reuse the currently authenticated T3
session instead of creating a new paired client.

- Automatic pairing uses `/api/auth/session/bearer-token` to mint a bearer alias for the current
  authenticated session. This route is available to owner and non-owner client sessions.
- The alias is tied to the original session row; revoking the original session revokes the extension
  and sidebar alias.
- Manual pairing can still exchange an explicit one-time credential with
  `/api/auth/bootstrap/bearer` for debugging or first-time remote setup.
- The extension stores only bearer-session credentials, never desktop bootstrap credentials or
  one-time credentials.
- WebSocket connection uses short-lived WS tokens from `/api/auth/ws-token`.
- Revoking the underlying session immediately prevents new WS tokens and terminates active agent
  connections.

Recommended server metadata for extension sessions:

```ts
type BrowserAgentClientMetadata = {
  kind: "browser-extension";
  label: string;
  browser: "chrome" | "brave" | "edge" | "unknown";
  platform: string;
  extensionVersion: string;
};
```

## Browser Agent Registry

The backend owns the source of truth for connected agents.

```ts
type BrowserAgent = {
  id: string;
  sessionId: string;
  label: string;
  connected: boolean;
  lastSeenAt: string;
  connectionId: string | null;
  device: {
    browser: string;
    platform: string;
    userAgent: string;
  };
  capabilities: {
    tabs: boolean;
    scripting: boolean;
    screenshots: boolean;
    inlineSidebar: boolean;
    sidePanelApi: boolean;
  };
  reachableOrigins: string[];
};
```

Agent IDs are server-issued and stable for a paired extension install. Connection IDs are ephemeral.

## Tab State Model

The extension streams tab snapshots to the backend. T3 Code reads browser state from the backend,
not directly from the extension and not from grouped tabs in a T3 web page.

```ts
type BrowserTabSnapshot = {
  agentId: string;
  tabId: number;
  windowId: number;
  groupId: number | null;
  url: string | null;
  title: string | null;
  active: boolean;
  audible: boolean;
  pinned: boolean;
  status: "loading" | "complete" | "unknown";
  kind: "dev-server" | "t3-code" | "other";
  observedAt: string;
};
```

The extension should debounce tab updates and send compact patches. Full snapshots are sent on
connect, reconnect, explicit backend request, and extension startup.

## Workspace Link Model

The backend persists which browser agent/tab belongs to a workspace/thread.

```ts
type BrowserWorkspaceLink = {
  id: string;
  workspaceId: string;
  threadId: string;
  environmentId: string;
  agentId: string;
  devServerUrl: string;
  devServerOrigin: string;
  tabId: number | null;
  windowId: number | null;
  sidebarSessionId: string;
  createdAt: string;
  updatedAt: string;
};
```

The link should survive browser refresh, extension service-worker restart, and T3 web reload. If a
tab disappears, the link remains but enters a `needs-tab` state until the agent opens/focuses a new
tab for the same `devServerUrl`.

## Agent WebSocket Protocol

Use a dedicated WebSocket endpoint for browser agents:

```text
GET /browser-agent/ws?wsToken=...
```

The WS token is issued through `/api/auth/ws-token` using the extension bearer session.

### Agent To Server

```ts
type BrowserAgentInbound =
  | {
      type: "browserAgent.hello";
      requestId: string;
      agentVersion: number;
      extensionVersion: string;
      capabilities: BrowserAgent["capabilities"];
      device: BrowserAgent["device"];
    }
  | {
      type: "browserAgent.tabs.snapshot";
      requestId: string;
      tabs: BrowserTabSnapshot[];
    }
  | {
      type: "browserAgent.tabs.patch";
      requestId: string;
      upserted: BrowserTabSnapshot[];
      removed: Array<{ tabId: number; windowId: number | null }>;
    }
  | {
      type: "browserAgent.command.result";
      commandId: string;
      ok: true;
      payload?: unknown;
    }
  | {
      type: "browserAgent.command.result";
      commandId: string;
      ok: false;
      error: {
        code:
          | "agent-unavailable"
          | "tab-not-found"
          | "permission-denied"
          | "unreachable-url"
          | "content-script-failed"
          | "screenshot-failed"
          | "annotation-cancelled"
          | "unknown";
        message: string;
      };
    }
  | {
      type: "browserAgent.annotation.submitted";
      commandId: string;
      workspaceLinkId: string;
      text: string;
      screenshotDataUrl: string;
      pageUrl: string;
      pageTitle: string;
      selectorLabel?: string;
    };
```

### Server To Agent

```ts
type BrowserAgentCommand =
  | {
      type: "browserAgent.command.openOrFocusPreview";
      commandId: string;
      workspaceLinkId: string;
      devServerUrl: string;
      sidebarSessionId: string;
      focus: boolean;
    }
  | {
      type: "browserAgent.command.attachSidebar";
      commandId: string;
      workspaceLinkId: string;
      tabId: number;
      sidebarSessionId: string;
    }
  | {
      type: "browserAgent.command.detachSidebar";
      commandId: string;
      sidebarSessionId: string;
    }
  | {
      type: "browserAgent.command.activateAnnotation";
      commandId: string;
      workspaceLinkId: string;
      tabId: number;
      sidebarSessionId: string;
    }
  | {
      type: "browserAgent.command.captureVisibleTab";
      commandId: string;
      tabId: number;
      crop?: { x: number; y: number; width: number; height: number };
    }
  | {
      type: "browserAgent.command.requestTabsSnapshot";
      commandId: string;
    };
```

All command results must be correlated by `commandId`. Commands should be idempotent where possible.

## Server Modules

Add server-side ownership in `apps/server`.

Suggested modules:

- `browserAgents/BrowserAgentConnectionManager.ts`
- `browserAgents/BrowserAgentRegistry.ts`
- `browserAgents/BrowserAgentCommandRouter.ts`
- `browserAgents/BrowserWorkspaceLinks.ts`
- `browserAgents/ws.ts`

Responsibilities:

- Authenticate browser-agent WS sessions.
- Track connected agents by auth session.
- Persist browser workspace links.
- Store the latest tab snapshot per agent in memory.
- Broadcast agent status and tab updates to web clients.
- Route commands from T3 UI to the correct connected agent.
- Convert annotation submissions into thread messages with image attachments.

Persistence should store only durable links and paired-agent records. High-volume tab snapshots should
stay in memory at first, with a latest-snapshot projection if needed.

## Contracts

Add schema-only contracts in `packages/contracts`.

Suggested files:

- `src/browserAgent.ts`
- `src/browserAgentProtocol.ts`
- `src/browserWorkspaceLink.ts`

Contracts must use Effect Schema and remain schema-only. Runtime helpers belong in `packages/shared`
or the app packages.

## Web UI

Replace transfer UI behavior.

The `Transfer to Browser` button should:

1. Read connected browser agents from backend state.
2. Resolve the best dev-server URL from terminal detection and advertised network endpoint.
3. Select an agent:
   - reuse the agent from an existing `BrowserWorkspaceLink`;
   - auto-select if exactly one connected agent can reach the dev URL;
   - otherwise show a compact picker.
4. Send a backend command to create/update a `BrowserWorkspaceLink` and open/focus preview.
5. Show command progress and concrete errors.

Top-bar annotation button should:

1. Resolve active `BrowserWorkspaceLink` for the current thread/workspace.
2. Send `activateAnnotation` to the linked agent.
3. Reflect active/running/failed state from command results.

Settings should add a `Browser Agents` section:

- connected/disconnected agents
- browser/platform/version
- last seen
- reachable origins
- revoke session
- copy pairing link
- create pairing link

## Extension UI

The extension should have three surfaces.

### Popup

- Shows current connection status.
- Lets the user paste a pairing URL/token or choose a saved backend.
- Lets the user connect/disconnect.
- Shows connected backend label and agent label.

### Service Worker

- Owns auth state and backend WebSocket.
- Observes tabs/windows/groups.
- Executes commands.
- Injects content scripts.
- Stores bearer sessions and backend records in `chrome.storage.local`.

### Content Script

- Runs on dev pages only after command-driven injection.
- Owns inline sidebar host, crop/reserve layout, resize, close, and annotation overlay.
- Embeds the target T3 chat route supplied by the service worker.
- Does not own T3 web auth state beyond passing the command-scoped bootstrap URL to the iframe.
- Sends page events to the service worker, which forwards them over the agent WS.

The inline sidebar is extension-native chrome around an embedded T3 chat route. The embedded app
must authenticate through a one-time bootstrap token and then use a bearer session for HTTP and
WebSocket traffic, so it does not rely on third-party cookies.

## URL Selection

The backend and web UI must distinguish:

- T3 backend URL used by extension auth and WS.
- Dev server URL to open in the browser.
- Dev server URL variant reachable by the selected browser agent.

For same machine, the dev URL may be `http://localhost:3000`.

For remote Tailscale, the dev URL usually must be rewritten to the selected advertised endpoint host,
for example `http://100.105.249.96:3000`. The backend should expose a URL resolution helper that
takes:

```ts
type BrowserReachabilityInput = {
  localDevServerUrl: string;
  advertisedBackendEndpoint: string;
  selectedAgentId: string;
};
```

and returns the dev URL that should be opened on that agent.

## Deprecation And Removal Plan

Remove the old flow entirely in the same feature branch.

### Remove Old Web Flow

- Delete transfer URL construction using `t3BrowserTransfer`, `t3BrowserTransferId`,
  `t3DevServerUrl`, `t3ExtensionPath`, and `t3GroupTitle`.
- Delete `BrowserTransferSetupPrompt`.
- Delete root-route transfer setup parsing.
- Replace `apps/web/src/browserTransfer.ts` with the new browser-agent client API or delete it.
- Replace tests that assert URL transfer behavior with browser-agent command tests.

### Remove Old Extension Flow

- Delete page-to-extension `window.postMessage` startup for browser transfer.
- Delete service-worker `t3code.browserTransfer.links` storage.
- Delete source T3 tab creation/removal assumptions.
- Delete `isLikelyT3CodeTab` and tab-group-based inference as command-critical logic.
- Delete side panel iframe session lookup based on `t3SidePanelSessionId`.
- Delete native side panel fallback as the primary open path.
- Keep only command-driven content-script injection for dev tabs.

### Remove Old Desktop Flow

- Stop `Transfer to Browser` from calling `openInChrome` with a T3 URL.
- Keep generic `openExternal` APIs only where still used outside this feature.
- Remove extension install path plumbing from transfer if it has no other owner.

### Compatibility

No compatibility shim is required. The old feature is early WIP and should be replaced outright.

If stale old query params are encountered, the web app should ignore them. If old extension storage
keys exist, the new extension should clear them on startup.

## Implementation Phases

### Phase 1: Contracts And Server Registry

- Add contract schemas.
- Add browser-agent WS endpoint.
- Add auth-session metadata for browser extension clients.
- Add in-memory connected agent registry.
- Add backend command routing and result correlation.
- Add web push events for agent connected/disconnected and tab snapshots.

### Phase 2: Extension Agent

- Rewrite extension service worker around backend pairing and WS connection.
- Add popup pairing UI.
- Add tab snapshot reporting.
- Add command handlers for open/focus, attach sidebar, detach sidebar, and activate annotation.
- Clear old storage keys on startup.

### Phase 3: Web UI Rewrite

- Replace transfer button with backend browser-agent command.
- Add agent picker and status states.
- Add browser-agent settings panel.
- Replace annotation button path with backend command path.
- Remove old transfer setup prompt and URL parsing.

### Phase 4: Sidebar And Annotation Rewrite

- Convert inline sidebar to extension-owned chrome that embeds the focused T3 chat route.
- Keep website crop/reserve/resize behavior.
- Route annotation submissions through service worker to backend.
- Backend appends annotation messages to the correct thread.

### Phase 5: Cleanup And Hardening

- Delete old files and tests.
- Add reconnect backoff and command timeouts.
- Add revocation handling.
- Add explicit host permission failure messaging.
- Add integration tests for local and remote-style URL resolution.

## Testing Requirements

Unit tests:

- contract schema decoding for all protocol messages
- browser-agent registry connect/disconnect/reconnect
- command routing and timeout behavior
- workspace link persistence/update behavior
- URL rewriting for local and Tailscale endpoints
- web transfer button agent selection
- annotation command state transitions

Extension tests:

- service worker pairs with bearer auth
- service worker reconnects after restart
- tab snapshot debounce and patches
- `openOrFocusPreview` reuses matching existing tab
- `attachSidebar` reinjects after tab refresh
- old storage keys are cleared

Manual acceptance:

- same-machine Chrome/Brave extension pairs with local desktop backend
- transfer opens/focuses `localhost` dev server
- refresh keeps sidebar linked
- annotation sends screenshot and text to focused thread
- remote Chrome extension pairs over Tailscale
- transfer opens/focuses Tailscale dev URL on remote machine
- revoking extension session disconnects the agent and disables commands

Required project checks:

- `bun fmt`
- `bun lint`
- `bun typecheck`
- focused tests for changed packages

## Security Requirements

- Extension pairing must be explicit and revocable.
- Extension bearer tokens must never be placed in dev-page DOM or URL.
- Content scripts must not receive backend bearer tokens.
- Commands must validate agent ownership and active session.
- Screenshot and annotation commands must require an existing workspace link.
- Backend must reject commands to disconnected or unauthorized agents.
- Host permission errors must be surfaced to the user without silent fallback.

## Open Questions

- Should browser-agent sessions have a new `role`, or should they remain `client` with
  `client.kind = "browser-extension"` metadata?
- Should the extension sidebar support full chat composition or only annotation-focused messages
  in the first rewrite?
- Should tab snapshots be persisted for disconnected agents or kept memory-only?
- Should dev-server reachability be inferred from agent-reported probe results or selected from
  advertised endpoints only?
- Should the browser-agent WebSocket be a dedicated endpoint or a channel inside the existing app
  WebSocket protocol?
