# Organization Panel Agents

Status: draft implementation spec

## Summary

Add one editable TypeScript dashboard panel per organization. Each organization gets a dedicated
panel agent that can update only that organization's panel file. The organization main page renders a
stable application shell plus the generated panel. A prompt control on that page starts an agent turn
scoped to the panel file, streams progress and patches back to the browser, and relies on Vite HMR in
development to update the rendered panel in real time.

The first version is intentionally narrow:

- one organization has one panel folder
- one panel folder contains one editable `Panel.tsx`
- the panel is normal typed React/TypeScript code
- the panel can import approved client-side modules, hooks, API clients, and UI components
- the server enforces the write boundary, independent of prompt wording
- the organization page survives broken generated code through an error boundary and rollback path

## Goals

- Give every organization a custom dashboard page coded from the ground up.
- Keep each organization's generated surface isolated from other organizations.
- Let users prompt an org-specific agent from the organization main page.
- Stream agent status, file edits, diffs, and compile/runtime state to the UI.
- Render updates live during local development through Vite HMR.
- Preserve a strong TypeScript contract for generated panels.
- Allow useful imports such as Convex hooks, typed API clients, UI components, charts, and formatting
  helpers.
- Make failed generations recoverable without taking down the whole app.
- Keep the MVP small enough that the edit boundary can be audited.

## Non-Goals

- A general website builder.
- Letting the panel agent edit arbitrary repo files.
- Letting generated panel code access server-only modules, secrets, filesystem APIs, or process env.
- Multi-file panel projects in the first version.
- Runtime execution of uncompiled arbitrary code in production.
- A visual drag-and-drop builder.
- Cross-organization shared generated code.
- Automatic production deployment of generated TSX changes before the deployment model is specified.

## Terminology

- **Organization**: The product-level owner of a custom dashboard. If the current codebase only has
  projects/workspaces at implementation time, organization should be introduced as a distinct domain
  concept or mapped explicitly to the chosen existing entity. Do not silently conflate them.
- **Panel**: The generated React component rendered on the organization main page.
- **Panel folder**: The organization-specific folder containing generated panel source.
- **Panel file**: The editable `Panel.tsx` file inside a panel folder.
- **Panel host**: Stable, hand-authored UI that loads and renders the panel.
- **Panel agent**: Provider session created for one organization panel. It may read approved context
  and write only the target panel file.
- **Panel turn**: One prompt-driven agent run that may update the panel file.

## Target File Layout

Initial MVP:

```text
apps/web/src/organization-panels/
  _shared/
    types.ts
    imports.ts
  acme/
    Panel.tsx
  ping/
    Panel.tsx
```

Recommended generated file shape:

```tsx
import type { OrganizationPanelProps } from "../_shared/types";

export default function Panel(props: OrganizationPanelProps) {
  return <section>{props.organization.name}</section>;
}
```

`_shared` is hand-authored and not editable by panel agents. It defines the public panel contract and
approved helpers. The generated `Panel.tsx` file is the only editable file in the first version.

Future expansion can add:

```text
apps/web/src/organization-panels/acme/
  Panel.tsx
  components.tsx
  queries.ts
  panel.json
```

Do not add multi-file generation until the one-file write boundary, rollback flow, and compile
failure handling are proven.

## Organization Slugs And Paths

Organization slugs are user-facing identifiers. Panel folder names are filesystem-safe slugs derived
from organization IDs, not raw display names.

Rules:

- resolve by stable organization ID first
- store `panelSlug` separately from display name
- allow only lowercase ASCII letters, numbers, and hyphen in `panelSlug`
- reject `.` `/` `\` whitespace, URL encoding escapes, and Unicode confusables
- never concatenate unvalidated user input into a filesystem path
- resolve final paths with `path.resolve`
- verify the resolved path is inside `apps/web/src/organization-panels/<panelSlug>`

Example resolver:

```ts
type OrganizationPanelPath = {
  organizationId: string;
  panelSlug: string;
  folderAbsolutePath: string;
  panelFileAbsolutePath: string;
  panelImportPath: string;
};
```

## Panel Type Contract

The generated file must default-export a React component with this initial prop contract:

```ts
export type OrganizationPanelProps = {
  organization: {
    id: string;
    slug: string;
    name: string;
  };
  viewer: {
    id: string;
    displayName: string | null;
    role: "owner" | "admin" | "member";
  };
  runtime: {
    now: Date;
    environment: "local" | "staging" | "production";
  };
};
```

Contract rules:

- Props are read-only from the panel's perspective.
- The panel does not receive secrets.
- The panel receives only data the viewer is allowed to see.
- Data-fetching helpers must enforce authorization server-side.
- The contract lives in a stable shared module imported by generated panels.
- Breaking prop changes require a migration path for all existing panels.

## Import Policy

Panels are TypeScript/TSX and may import approved client-side modules. This keeps dashboards useful
without turning generated code into unrestricted application code.

Allowed imports in the MVP:

- `react`
- approved UI components from `apps/web/src/components/ui/*`
- approved chart/data-view components if already present or introduced deliberately
- approved formatting helpers
- approved client API hooks
- approved Convex client hooks/functions, when available in this app
- `../_shared/types`
- `../_shared/imports`

Disallowed imports:

- Node builtins such as `fs`, `path`, `child_process`, `crypto`, `process`
- server package source such as `apps/server/*`
- local auth/session internals
- environment modules exposing secrets
- test helpers
- arbitrary relative imports outside the organization panel folder and `_shared`
- dynamic import paths built from user input

Enforcement should happen in two layers:

- lint/static validation for the generated panel file
- server-side agent write sandbox so invalid imports cannot be used to escape the edit boundary

For the MVP, prefer a small facade module over a broad allowlist:

```ts
// apps/web/src/organization-panels/_shared/imports.ts
export { Button } from "../../components/ui/button";
export { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
```

Generated panels can then import from `../_shared/imports` instead of discovering deep app paths.

## Rendering Architecture

The organization main page should be hand-authored and stable:

```text
OrganizationPage
  OrganizationHeader
  PanelPromptButton
  PanelAgentActivitySurface
  OrganizationPanelHost
    OrganizationPanelErrorBoundary
      Generated Panel
```

Responsibilities:

- `OrganizationPage` resolves the current organization and viewer.
- `PanelPromptButton` opens the prompt composer for this organization's panel agent.
- `PanelAgentActivitySurface` shows active turn state, patch stream, compile state, and rollback
  controls.
- `OrganizationPanelHost` dynamically loads the generated panel.
- `OrganizationPanelErrorBoundary` contains render failures and shows recover/rollback actions.

Dynamic module loading:

```ts
const panelModules = import.meta.glob("../organization-panels/*/Panel.tsx");
```

The host should resolve the key from server-provided metadata, not directly from the route param.

Missing panel behavior:

- create the panel folder and starter `Panel.tsx` on organization creation, or
- lazily create it the first time the organization page is opened

Starter panel should be valid, sparse, and useful:

```tsx
import type { OrganizationPanelProps } from "../_shared/types";

export default function Panel({ organization }: OrganizationPanelProps) {
  return (
    <section className="p-6">
      <h1 className="text-xl font-semibold">{organization.name}</h1>
    </section>
  );
}
```

## Agent Scope Model

Each organization has a dedicated panel agent identity:

```ts
type OrganizationPanelAgent = {
  id: string;
  organizationId: string;
  panelSlug: string;
  providerInstanceId: string;
  model: string;
  status: "idle" | "running" | "blocked" | "failed";
  lastTurnId: string | null;
  createdAt: string;
  updatedAt: string;
};
```

Agent sessions must be created with an explicit scope:

```ts
type OrganizationPanelAgentScope = {
  organizationId: string;
  panelFileAbsolutePath: string;
  writablePaths: [string];
  readablePaths: string[];
  disallowedPaths: string[];
  allowedImports: string[];
};
```

MVP write scope:

```text
writable:
  apps/web/src/organization-panels/<panelSlug>/Panel.tsx

readable:
  apps/web/src/organization-panels/<panelSlug>/Panel.tsx
  apps/web/src/organization-panels/_shared/**
  docs/organization-panel-agents.md
  selected UI component source files
  selected client API type files
  selected contract type files
```

The server should reject any patch, tool call, or file write outside the writable path before it is
applied. Prompt instructions are not sufficient isolation.

## Prompt Flow

User flow:

1. User opens `/organizations/:organizationId`.
2. The page renders the existing panel.
3. User clicks the prompt button.
4. User enters a request such as "Add monthly revenue, active users, and open tickets."
5. Web sends `organizationPanel.turn.start`.
6. Server resolves organization, panel path, current panel contents, and allowed context.
7. Server starts or resumes the org-specific panel agent.
8. Agent proposes edits.
9. Server validates every edit against path and import policy.
10. Server writes valid edits to `Panel.tsx`.
11. Server emits file-change, diff, validation, compile, and turn-complete events.
12. Web updates the activity surface.
13. Vite HMR refreshes the rendered panel in development.

Prompt composer requirements:

- Show which organization will be edited.
- Make the editable file visible.
- Do not expose a general workspace chat affordance in this surface.
- Include a stop button for the active panel turn.
- Include rollback to the previous saved version.
- Preserve prompt history per organization.

## WebSocket And Contract Events

Add contract-only schemas in `packages/contracts` for the panel domain. Keep runtime logic outside
the contracts package.

Suggested RPC methods:

```ts
organizationPanelGet: "organizationPanel.get";
organizationPanelTurnStart: "organizationPanel.turn.start";
organizationPanelTurnStop: "organizationPanel.turn.stop";
organizationPanelHistoryList: "organizationPanel.history.list";
organizationPanelRollback: "organizationPanel.rollback";
```

Suggested push channel:

```text
organizationPanel.event
```

Suggested event union:

```ts
type OrganizationPanelEvent =
  | {
      type: "panel.snapshot";
      organizationId: string;
      panelSlug: string;
      panelFilePath: string;
      versionId: string;
    }
  | {
      type: "turn.started";
      organizationId: string;
      turnId: string;
      prompt: string;
    }
  | {
      type: "turn.delta";
      organizationId: string;
      turnId: string;
      message: string;
    }
  | {
      type: "file.patch";
      organizationId: string;
      turnId: string;
      filePath: string;
      diff: string;
    }
  | {
      type: "validation.result";
      organizationId: string;
      turnId: string;
      status: "passed" | "failed";
      errors: string[];
    }
  | {
      type: "compile.result";
      organizationId: string;
      turnId: string;
      status: "passed" | "failed";
      errors: string[];
    }
  | {
      type: "turn.completed";
      organizationId: string;
      turnId: string;
      versionId: string;
    }
  | {
      type: "turn.failed";
      organizationId: string;
      turnId: string;
      reason: string;
    };
```

The web client should derive UI state from events, then reconcile with `organizationPanel.get` on
reconnect.

## Real-Time Update Model

Local development:

- Server writes `Panel.tsx`.
- Vite sees the file change.
- HMR reloads the module.
- `OrganizationPanelHost` re-renders the panel.
- Agent activity events show the exact diff and validation state.

Production:

- Do not assume HMR exists.
- A generated TSX panel must be compiled and deployed through a defined deployment path.
- Until that deployment model exists, production should support prompt/diff/history workflows only
  if writes happen in a repo-backed development environment.

If production live editing is required later, evaluate these options separately:

- generated declarative dashboard schema interpreted at runtime
- per-organization bundle build and signed artifact loading
- server-rendered panel previews with publish step
- branch/PR workflow per generated dashboard change

## Validation Pipeline

Every panel turn should run a focused validation pipeline before it is considered successful.

Fast validation after each accepted edit:

- path boundary check
- import allowlist check
- generated file exports a default component
- no server-only imports
- no obvious secret/env access

Completion validation:

- TypeScript check for the panel and shared panel types
- lint/static import policy
- optional preview render smoke test
- optional screenshot comparison if a browser target is available

Repo-level completion remains governed by root requirements:

```bash
bun fmt
bun lint
bun typecheck
```

For implementation tasks that change native mobile code, also run:

```bash
bun lint:mobile
```

Do not use `bun test`; this repo uses:

```bash
bun run test
```

## Versioning And Rollback

Every applied panel turn must create a version record:

```ts
type OrganizationPanelVersion = {
  id: string;
  organizationId: string;
  panelSlug: string;
  turnId: string;
  prompt: string;
  filePath: string;
  beforeHash: string;
  afterHash: string;
  diff: string;
  status: "applied" | "rolled-back";
  createdAt: string;
};
```

Rollback behavior:

- restore the previous file contents for the selected version
- create a new rollback version record
- emit `file.patch`, `validation.result`, and `compile.result`
- trigger HMR in development
- never delete historical records

Storage options:

- MVP: append-only metadata file under the T3 Code app data directory
- later: first-class server persistence if the app already has a durable store for orchestration
  state

Avoid storing version history inside the generated panel folder unless that is explicitly part of a
repo-backed audit strategy.

## Error Handling

First-class error states:

- organization not found
- panel folder missing and cannot be created
- panel file missing and cannot be created
- active turn already running
- provider session failed to start
- agent attempted to edit a disallowed path
- agent generated invalid import
- generated panel failed TypeScript validation
- generated panel failed runtime render
- HMR did not apply the update
- rollback failed
- websocket disconnected during a turn

UI behavior:

- Keep the stable organization page visible.
- Show the last known good panel when possible.
- If the current panel cannot render, show a contained error surface inside the panel host.
- Show the failed validation output in the activity surface.
- Offer rollback to the last passing version.
- Do not silently discard generated edits.

## Security And Permissions

Required checks:

- User must have permission to view the organization.
- User must have permission to edit the organization panel.
- Agent scope must be derived server-side from organization ID.
- Writable path must be exact, not a prefix provided by the client.
- Patches must be inspected before writing.
- Generated code must not receive secrets.
- Generated code must not import server-only modules.
- Generated code must not bypass authorization by calling internal APIs.

Threats to account for:

- prompt injection asking the agent to edit another organization's folder
- path traversal through a malicious slug
- generated import of server internals
- generated client code that leaks hidden data
- generated code that starts expensive polling loops
- generated code that breaks application routing or global CSS
- malicious or accidental edits to shared panel types

The server is the enforcement point. Client route guards and prompt instructions are only additional
defense-in-depth.

## Observability

Panel agent operations should be observable with structured spans and events.

Recommended span names:

- `organizationPanel.get`
- `organizationPanel.turn.start`
- `organizationPanel.turn.applyPatch`
- `organizationPanel.turn.validate`
- `organizationPanel.turn.rollback`

Recommended attributes:

- `organization.id`
- `organization.panelSlug`
- `organizationPanel.turnId`
- `organizationPanel.versionId`
- `provider.instanceId`
- `provider.model`
- `validation.status`
- `compile.status`
- `file.path`

Never log full prompts or generated source in telemetry unless the existing app privacy model
explicitly allows it. Prefer hashes, sizes, and event IDs for default traces.

## Implementation Plan

### Phase 1: Static Panel Host

- Add panel shared types.
- Add starter panel folder and starter `Panel.tsx`.
- Add organization page panel host.
- Load panels with `import.meta.glob`.
- Add error boundary.
- Add missing-panel fallback.

Exit criteria:

- Organization page renders a generated panel.
- Broken panel code is contained by the error boundary.
- TypeScript catches invalid panel prop usage.

### Phase 2: Server-Side Panel Domain

- Add panel path resolver.
- Add panel metadata schema.
- Add RPC methods for get/history/rollback.
- Add append-only version records.
- Add path and import validation helpers.

Exit criteria:

- Server can return current panel metadata.
- Server can create starter files.
- Server can reject invalid panel slugs and disallowed paths.

### Phase 3: Prompted Panel Agent

- Add prompt composer on organization page.
- Add org-specific panel agent session creation.
- Pass scoped context to provider.
- Intercept and validate file edits.
- Write only the target `Panel.tsx`.
- Stream turn events to web.

Exit criteria:

- Prompting updates only the target organization's panel.
- Attempted edits outside the allowed file are rejected and visible in UI.
- Concurrent turns for the same org are serialized or rejected.

### Phase 4: Real-Time UX

- Wire panel event stream into the activity surface.
- Show turn progress, diff, validation, compile status, and stop control.
- Confirm HMR updates the panel in local dev.
- Add rollback control.

Exit criteria:

- User can prompt, watch progress, see the panel update, and roll back.
- Reconnect reconciles active or completed turn state.

### Phase 5: Hardening

- Add import allowlist lint rule or focused static validator.
- Add tests for path resolution and write boundary enforcement.
- Add tests for websocket event decoding.
- Add browser smoke test for panel render/update if practical.
- Add observability spans.

Exit criteria:

- `bun fmt`, `bun lint`, and `bun typecheck` pass.
- Critical boundary tests cover path traversal, cross-org edit attempts, invalid imports, and rollback.

## Testing Strategy

Unit tests:

- slug validation
- path resolution
- path boundary checks
- import allowlist checks
- panel event schema decoding
- version record creation
- rollback record creation

Integration tests:

- start panel turn and apply valid edit
- reject edit outside panel file
- reject invalid import
- serialize concurrent turns
- reconcile event state after reconnect

Frontend tests:

- missing panel fallback
- panel render error boundary
- prompt composer disabled states
- activity surface for running/failed/completed turns
- rollback button behavior

Manual local verification:

- edit one org panel and confirm another org panel does not change
- prompt agent to intentionally edit another folder and confirm rejection
- break `Panel.tsx` and confirm the organization page remains usable
- restore previous version and confirm HMR updates the view

## Open Questions

- What is the exact organization domain model in the current product, and how does it relate to
  existing projects/workspaces?
- Should panel agent sessions reuse the normal conversation UI internally, or should they be a
  separate provider session type?
- Where should version history live once the app has durable persistence for more orchestration
  state?
- Should production support direct generated TSX edits, or should production use a publish/preview
  workflow?
- Which modules should be included in the first import facade?
- Should every organization panel have a dedicated provider instance/model preference?
- How should generated panels access organization-specific data: Convex hooks, existing API client,
  or a new typed panel data facade?

## Recommended MVP Decision

Build the MVP as a local-first, repo-backed feature:

- `Panel.tsx` is generated TSX.
- The organization page is stable hand-authored React.
- The agent can write only the target `Panel.tsx`.
- Imports come through `_shared/imports.ts`.
- The UI streams agent activity and relies on Vite HMR for live updates.
- Production publishing is deferred until the deployment model is explicit.

This gives useful behavior quickly while keeping the main risk, unrestricted code editing, contained
behind a small audited write boundary.
