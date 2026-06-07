# AGENTS.md

## Maintaining This File

- Always update `AGENTS.md` when making changes that affect architecture, patterns, infrastructure, or design language.
- Always keep the "Product Overview" section current. When features are added, renamed, or removed, update their names and descriptions. When branding changes (app name, tagline, terminology), reflect it immediately. This section is the single source of truth for what the product is and does.
- Always keep `.env.example` up to date when adding/removing environment variables. This repo does not currently have a `.env.example`; create one before introducing new environment variables that should be documented for developers.
- If repeated corrections or pattern deviations are noticed, ask the user: "Should we update AGENTS.md to prevent this from recurring?"
- Keep entries concise. This file is a living reference for consistency across the project.

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

## GitHub Pull Requests

- When creating pull requests from this workspace, target `origin` / `Bl4ckBl1zZ/t3code` unless the user explicitly asks for `upstream` / `pingdotgg/t3code`.
- Never infer the parent fork as the pull request target.

## Product Overview

Update this section as the product evolves. Keep feature names, descriptions, and branding current.

- **App Name**: T3 Code
- **Tagline / Description**: Minimal GUI for coding agents across web, desktop, browser, and mobile surfaces.
- **Core Purpose**: T3 Code helps developers run, organize, and supervise coding-agent sessions for local and remote repositories through an organization > project > workspace > sub-chat hierarchy, with reliable orchestration, source-control workflows, terminals, diffs, workspace editing, and thread-scoped browser tooling.

### Features

- **Agent Threads / Sub-Chats**: Chat-style coding-agent sessions with turn state, streaming activity, approvals, user-input prompts, resumable history, and compatibility shell data for the workspace-scoped sub-chat model.
- **Provider Instances**: Configurable Codex, Claude, Cursor, and OpenCode providers, including multiple instances per driver where supported, provider skill discovery, Codex skill creation/enablement/deletion, and future MCP server management.
- **Projects & Workspaces**: Project registry, repository identity, derived organization/project/workspace/sub-chat shell hierarchy, branch/worktree preparation, setup scripts, per-project settings, archived workspace cleanup, and unlinked worktree management.
- **Source Control Workflows**: Git status, branch actions, commit helpers, pull request / merge request creation and direct merge actions, review flows, and provider discovery for GitHub, GitLab, Bitbucket, and Azure DevOps.
- **Workspace Tools**: VS Code-style file explorer, Monaco editor, conflict-aware saves, checkpoint diffs, changed-file trees, workspace-associated terminal sessions, command palette, and workbench tabs.
- **Browser Agent**: Chrome extension runtime for agent-controlled browser tabs, collapsed Chrome tab groups for extension-created tabs, thread-scoped browser workspaces, per-agent/sub-agent Chrome tab contexts, agent tab cleanup/close, visible in-page agent cursor for browser control, native side panels, default CDP-backed control, full-page screenshot tool artifacts in work logs, browser input/form forwarding, annotation screenshots, diagnostics, startup/dev-synced unpacked extension installs, extension dev auto-reload, host-local control without manual pairing, popup self-reload/update, same-session remote extension setup, and remote browser control over reachable backend URLs.
- **Organization Panels**: Organization-scoped generated dashboard panels with prompt-driven panel agents, streamed activity, rollback history, and dynamic panel RPC.
- **Desktop App**: Electron shell that starts and supervises the backend, manages updates, SSH environments, Tailscale exposure, native menus, and secure local settings.
- **Mobile App**: Expo/React Native companion app in development for connecting to T3 Code environments, reviewing diffs, using terminals, and managing threads.
- **Marketing Site**: Astro site for product/download pages and release-facing assets.
- **Observability & Diagnostics**: Effect tracing, local NDJSON trace files, OTLP export, provider event logs, process diagnostics, and update smoke tooling.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures, including session restarts, reconnects, provider crashes, and partial streams.

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

- Long-term maintainability is a core priority.
- Before adding new functionality, check for shared logic that should be extracted to an appropriate package or module.
- Duplicate logic across multiple files is a code smell and should be avoided.
- Do not be afraid to change existing code when a broader change is the clean, reliable fix.
- Do not take shortcuts by adding local-only logic to solve a cross-cutting problem.
- This repository is a very early WIP. Sweeping changes that improve long-term maintainability are acceptable when they are clearly scoped and justified.

## TypeScript Rules

- Use the shared strict settings from `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `erasableSyntaxOnly`, and `verbatimModuleSyntax`.
- Avoid `any`. Use `unknown`, explicit generics, Effect `Schema`, or narrow interop types. Test-only casts and framework interop should stay small and obvious.
- Prefer Effect `Schema` for runtime validation and wire contracts. Keep schemas in `packages/contracts` when they define shared protocol/data shapes.
- Keep `packages/contracts` schema-only: no runtime orchestration, I/O, persistence, or UI logic.
- Keep `packages/shared` for runtime utilities consumed by more than one package. Use explicit subpath exports such as `@t3tools/shared/git`; do not add a barrel index.
- In Effect-heavy code, follow the Effect language-service diagnostics from `tsconfig.base.json`: avoid unsafe global time/random/crypto/fetch/console usage inside Effect flows and prefer injected services.
- Prefer decoding at boundaries and typed domain models internally. Do not pass unchecked JSON or provider payloads deep into the app.
- Use `.ts` extensions in local TypeScript imports where the repo already does so.

## Code Grammar

- **Naming**: Use camelCase for variables/functions and PascalCase for components unless the framework or file type requires another convention.
- **Components**: React component files use PascalCase. Hooks use `useX`. Logic helpers and tests are commonly colocated as `*.logic.ts` / `*.test.ts(x)`.
- **Effect Services**: Server services generally live under `Services/` and concrete layers under `Layers/`. Preserve that separation when adding server capabilities.
- **Abstraction**: Avoid single-use abstractions. Prefer shared utilities only when they reduce meaningful duplication or clarify cross-cutting behavior.
- **Comments**: Keep comments minimal and focused on non-obvious flows, constraints, and future maintenance signals.
- **Imports**: Prefer existing aliases and package boundaries. Web code uses `~` for `apps/web/src`; shared package imports should use published subpaths.

### Code Annotation Markers

When editing code, add short, searchable comments to clearly identify sections that need future cleanup, compatibility support, or deeper review.

Use these exact labels:

- `LEGACY`: Code retained from an older implementation or pattern that should not spread to new work.
- `BACKWARD COMPATIBILITY`: Code required to preserve existing behavior, data shapes, APIs, migrations, or integrations.
- `TO BE REFACTORED`: Code that works but should be simplified, reorganized, or replaced when time allows.
- `REVIEW NEEDED`: Code that requires follow-up validation, domain review, security review, performance review, or product confirmation.

Marker rules:

- Place the marker directly above the relevant block or inline next to the specific line when the scope is narrow.
- Include a brief reason after the marker so future maintainers know why it exists.
- Keep the comment actionable and concise.
- Do not add markers to unrelated code while making a scoped change.
- Remove markers when the underlying issue has been resolved.

Examples:

```ts
// LEGACY: Preserves the pre-v2 payload format used by older imports.
const normalizedPayload = normalizeLegacyPayload(payload);
```

```ts
// BACKWARD COMPATIBILITY: Existing clients still send snake_case keys.
const userId = input.userId ?? input.user_id;
```

```ts
// TO BE REFACTORED: Split pricing rules into composable strategies.
const total = calculateTotalWithInlineRules(order);
```

```ts
// REVIEW NEEDED: Confirm retry limits with infrastructure before increasing.
const maxRetries = 5;
```

## Tech Stack

- **Monorepo / Package Manager**: pnpm `10.24.0` workspaces with Vite+ `0.1.24`; use `vp` for format/lint/test/build orchestration.
- **Language**: TypeScript `~6.0.3` with `@typescript/native-preview` `7.0.0-dev.20260604.1` and `@effect/tsgo` `0.13.2`.
- **Effect Runtime**: Effect `4.0.0-beta.78`, `@effect/platform-bun`, `@effect/platform-node`, `@effect/sql-sqlite-bun`, and `@effect/sql-pg` for typed services, config, HTTP, persistence, and tests.
- **Web App**: React `19.2.6`, React DOM `19.2.6`, Vite `^8.0.0`, `@vitejs/plugin-react` `^6.0.0`, TanStack Router `^1.160.2`, TanStack Query `^5.90.0`, Zustand `^5.0.11`.
- **Web Styling / UI**: Tailwind CSS `^4.0.0`, `@tailwindcss/vite` `^4.0.0`, Base UI `^1.4.1`, lucide-react `^0.564.0`, class-variance-authority `^0.7.1`, tailwind-merge `^3.4.0`.
- **Editors / Rich UI**: Lexical `^0.41.0`, Monaco Editor `^0.55.1`, xterm `^6.0.0`, `@pierre/diffs` `1.1.20`, Shiki `3.23.0` on mobile.
- **Backend**: Node-compatible CLI/server package `t3`, Effect HTTP/WebSocket RPC, SQLite persistence, `node-pty` `^1.1.0`, provider subprocess management, and static web asset serving.
- **Providers**: Codex app-server via `packages/effect-codex-app-server`, Claude via `@anthropic-ai/claude-agent-sdk` `^0.3.154`, Cursor Agent via ACP, OpenCode via `@opencode-ai/sdk` `^1.3.15`, plus internal ACP support.
- **Desktop**: Electron `41.5.0`, electron-updater `^6.6.2`, tsdown `^0.20.3`.
- **Mobile**: Expo `^56.0.0`, Expo Router `~56.2.7`, React `19.2.3`, React Native `0.85.3`, UniWind `^1.6.2`, native terminal/review-diff modules.
- **Marketing**: Astro `^6.0.4`.
- **Browser Extension**: Chrome extension assets and service worker in `apps/chrome-extension`.
- **Testing / QA**: Vitest `^4.0.0`, `@effect/vitest`, oxlint `^1.63.0`, oxfmt `^0.40.0`.

## Project File Structure

```txt
apps/
  server/              Node-compatible T3 CLI and backend server.
    src/auth/          Pairing, bearer sessions, WebSocket tokens, secret storage.
    src/browserAgents/ Browser-agent registry, WebSocket routing, workspace links, and thread-tab command routing.
    src/cli/           CLI flags, environment config, and startup resolution.
    src/orchestration/ Domain command/event engine for projects, threads, turns, and runtime ingestion.
    src/persistence/   SQLite repositories, migrations, and runtime state.
    src/provider/      Provider registry, drivers, adapters, session runtimes, browser dynamic tools, and provider logs.
    src/sourceControl/ GitHub/GitLab/Bitbucket/Azure DevOps provider integrations.
    src/terminal/      PTY-backed terminal session manager.
    src/vcs/           VCS driver abstraction and Git implementation.
    src/workspace/     Scoped workspace file APIs, paths, lazy tree loading, and file watching.
    src/organizationPanels.ts
                         Organization panel snapshots, turns, history, and rollback.
    src/organizationPanelDynamicRpc.ts
                         Dynamic RPC registry for generated organization panels.
  web/                 React/Vite frontend.
    src/components/    App shell, chat, sidebar, settings, workbench, workspace, and UI primitives.
    src/components/chat/
                         Thread chat, composer, preview controls, and timeline work-log rendering.
    src/components/ui/ Base UI/Tailwind primitives used by feature components.
    src/components/workspace/
                         Workspace explorer and Monaco file editor.
    src/environments/  Primary and remote environment connection/runtime state.
    src/hooks/         Shared React hooks.
    src/lib/           Client utilities, derived state wrappers, rendering helpers, and storage.
    src/observability/ Client tracing helpers.
    src/organizationPanel/
                         Organization panel host and generated-panel error boundary.
    src/routes/        TanStack Router route files.
    src/rpc/           WebSocket transport, connection, request latency, and server-state client logic.
    src/workbenchStore.ts
                         Workbench tab/store coordination for chat, file, diff, and terminal tabs.
  desktop/             Electron main/preload/window app, updater, SSH, Tailscale, settings, and backend supervisor.
  mobile/              Expo/React Native app, feature modules, native modules, state, and mobile components.
  marketing/           Astro marketing/download site.
  chrome-extension/    Unpacked Chrome extension for browser-agent pairing and preview control.
packages/
  contracts/           Shared Effect Schema contracts and TypeScript protocol types only, including browser-agent, workspace-file, organization-panel, and RPC schemas.
  shared/              Runtime utilities with explicit subpath exports.
  client-runtime/      Shared client-side state machines and WebSocket RPC utilities for web/mobile.
  effect-codex-app-server/ Typed client/schema wrapper for Codex app-server JSON-RPC.
  effect-acp/          Typed ACP protocol support and generated schema.
  ssh/                 SSH command, auth, and tunnel helpers.
  tailscale/           Tailscale Serve/status helpers.
scripts/               Dev runner, desktop build scripts, static checks, and sync utilities.
.t3code/project.json   Project scripts surfaced in T3 Code, including pinned top-bar actions.
docs/                  Architecture, provider, observability, operations, and feature documentation.
oxlint-plugin-t3code/  Local custom oxlint rules.
```

## Frontend Design Language

- Use the token system in `apps/web/src/index.css`: semantic colors (`background`, `foreground`, `card`, `popover`, `primary`, `muted`, `accent`, `border`, status colors), dark-mode variants, and `--radius`.
- The app should feel dense, calm, and operational. Prioritize scanability, predictable panels, compact controls, and resilient layout over marketing-style hero sections.
- Prefer existing primitives in `apps/web/src/components/ui` before creating new UI controls.
- Use lucide icons for icon buttons and actions when an appropriate icon exists.
- Buttons should use `Button` and `buttonVariants`; keep touch targets compatible with the existing pointer-coarse sizing behavior.
- Use semantic surfaces (`bg-background`, `bg-card`, `bg-popover`, `bg-muted`) and borders from tokens. Avoid one-off palettes unless the change introduces a documented design token.
- Keep cards for repeated items or contained tool surfaces. Avoid nested cards and avoid using cards as general page-section decoration.
- Use `cn` from `~/lib/utils` and existing variant patterns for class composition.
- Keep layout dimensions stable with explicit min/max sizes for sidebars, panels, tabs, toolbars, and virtualized lists.
- Use small, purposeful transitions. Dialogs/sheets currently use roughly 200ms transitions; respect `.no-transitions` during theme changes.
- Active work-log read-file rows may use shimmer text to indicate an in-progress file read; completed history should remain static.
- Desktop/web typography uses DM Sans with system fallbacks; code uses SF Mono / system monospace.

### Navigation Layout

- Desktop/web uses a left project/workspace/sub-chat sidebar (`AppSidebarLayout`), central chat/workbench area, top workbench tabs above the main action bar, and right-side sheets/panels for auxiliary workflows.
- The sidebar should present projects as compact workspace groups. Project and organization rows remain accordion triggers without persistent disclosure arrows. Workspace headers use branch/workspace names, use taller rectangular rows than legacy chat rows, support workspace rename/archive actions, and show active sub-chat status on the header. Child thread/sub-chat rows should stay visually subordinate and must not repeat redundant workspace/branch labels. Legacy thread rows may still back sub-chat data, but visible grouping should use `buildSidebarWorkspaceThreadGroups` and `workspaceId` when present.
- Workbench tabs are modeled in `packages/client-runtime/src/workbenchTabsState.ts` and currently support workspace-scoped `chat`, `file`, `diff`, `terminal`, and `actions` tab kinds. Add new tab surfaces through that model instead of inventing route-local tab state. Web workbench tabs use a floating rectangular treatment in `WorkbenchTabStrip`; preserve that shape, spacing, and active-tab elevation when adding tab kinds.
- Workspace-first chat links are available through `/w/:workspaceId/c/:subChatId` and `/orgs/:organizationId/projects/:projectId/workspaces/:workspaceId/chats/:subChatId`, with draft links under the same `/orgs/.../chats/draft/:draftId` hierarchy. Keep legacy thread routes working during the compatibility phase.
- Browser-agent tab interaction is provider-driven through browser tools and the extension runtime; do not add a user-facing browser workbench panel unless the architecture changes again.
- Settings are route-backed panels under `apps/web/src/routes/settings.*.tsx` and feature-specific components under `apps/web/src/components/settings`.
- Mobile uses Expo Router under `apps/mobile/src/app`, with connection, new-project/new-thread, thread, git, review, and terminal screens. Mobile flows should be stack-friendly and avoid desktop-only assumptions.
- Browser-agent tab flows should keep agent-controlled browser state owned by the backend/extension protocol, not by inferred Chrome tab-group UI. Routine thread browser control should not focus or foreground the real browser window; reserve real browser focus for explicit user actions such as "Open in browser" or annotation capture. Extension-created Preview tabs should stay outside the collapsed agent work tab group, while agent/browser-tool tabs should share one collapsed T3 Code agent group. Desktop startup syncs the unpacked browser-agent extension into the local app-data folder, for example `~/Library/Application Support/t3code-dev/Chrome Extension` on macOS dev builds, by fully replacing that folder from the repo/bundled `chrome-extension` source. Chrome should load that stable unpacked folder for local testing; `pnpm dev:desktop` keeps it synced during development and writes `dev-reload.json` so the extension reloads itself and reinjects the pairing content script into trusted T3 tabs. The extension should auto-connect to the host desktop backend by preferring the loopback-only local-control WebSocket, including advertised loopback backend URLs from the app, then falling back to saved/authenticated pairing only when local control is unavailable. App UI should surface protocol/runtime mismatches from the connected agent snapshot.
- Browser routing policy: provider/agent browser tabs use the browser-agent context. User-initiated Preview uses the browser-agent extension in the same browser where the user clicked Preview, after rewriting loopback preview URLs to a reachable active-environment host when needed. Same-origin Preview derives a browser-agent session from the current browser's authenticated host session, then targets the connected extension by `preferredAgentId`; when that session has not registered yet, the content-script-confirmed same-browser extension may be used through local-control or saved authenticated pairing. If an already-open app tab has no pairing content script, Preview may use a backend-visible connected extension instead of sending the user back through setup. Preview must not create manual browser-agent pairing tokens or use an unrelated host-paired extension. Remote app loads over non-loopback origins such as Tailscale/LAN must not use build-time loopback backend URLs; the primary environment target should fall back to the current app origin. Clicking the extension toolbar icon on a URL matched to a stored workspace link should open the native side panel on that tab with the link's workspace chat; clicking it on an unlinked URL should open the normal T3 Code app tab for the active host/local-control backend. Annotation activation should use the backend's linked workspace when present; if the backend link is missing, the extension may resolve the active tab by URL against stored workspace links, but it must retarget the annotation link to the side-panel chat/thread that requested annotation before annotation submission.
- Preview button visibility and click targets are workspace-scoped. The button should open only an explicit workspace/project preview URL or a verified `PreviewTarget` derived from the active workspace's running terminals. Script/framework defaults such as Next `3000` and Vite `5173` are hints for starting/discovery UI only and must not be used as openable targets unless verified. If multiple verified targets in the active workspace are equally likely, the UI should ask the user to choose instead of guessing.

### Popups & Modals

- Use `Dialog` primitives for focused confirmations/forms and `Sheet` primitives for side panels or mobile-friendly drawers.
- Dialogs should keep header/body/footer structure from `dialog.tsx`; sheets should use the side/variant behavior from `sheet.tsx`.
- On mobile, dialogs may bottom-stick by default. For right-side app panels, prefer `RightPanelSheet` and `RIGHT_PANEL_SHEET_CLASS_NAME`.
- Close buttons should be icon buttons with accessible labels. Avoid custom modal backdrops unless the existing primitives cannot support the interaction.

## Backend Infrastructure

- The `t3` server starts as a CLI (`apps/server/src/bin.ts`) and resolves runtime config from CLI flags, environment variables, persisted settings, and desktop bootstrap envelopes.
- HTTP and WebSocket routes are composed in `apps/server/src/server.ts`; WebSocket RPC lives in `apps/server/src/ws.ts`.
- Static web assets are served from bundled client output or proxied to a Vite dev server via `VITE_DEV_SERVER_URL`.
- Persistence uses SQLite through Effect layers under `apps/server/src/persistence`.
- The target navigation data model is organization > projects > workspaces > sub-chats, with actions and terminals owned by workspaces. During the compatibility phase, `ProjectionSnapshotQuery` derives local organization/workspace/sub-chat shell data from legacy `projection_projects` and `projection_threads`, while migration 37 backfills concrete `projection_organizations`, `projection_workspaces`, `projection_sub_chats`, and `projection_workspace_actions` tables for future first-class writers.
- Auth uses bootstrap credentials, bearer aliases, session credentials, and short-lived WebSocket tokens under `apps/server/src/auth`.
- Provider sessions are managed through `apps/server/src/provider`; Codex runs `codex app-server` per provider session through the typed wrapper package.
- Built-in provider drivers are registered in `apps/server/src/provider/builtInDrivers.ts`; keep driver additions there and make sure the runtime layer satisfies the driver's declared environment.
- Orchestration projects provider runtime events into domain events consumed by the web/mobile clients.
- Turn diff summaries use git checkpoint refs. Preserve the distinction between post-turn checkpoints (`checkpointRef`) and per-run start baselines (`baselineCheckpointRef`) so a turn diff only includes changes made during that agentic run.
- Shell snapshots and shell stream events include workspace and sub-chat slices alongside legacy project/thread slices. Live thread upserts should emit `workspace-upserted`, `thread-upserted`, and `sub-chat-upserted` together; delete/archive payloads remain thread-id-only, so workspace cleanup is snapshot/backfill-driven until richer workspace-aware events land.
- `thread.delete` is permanent destruction and must reject active `starting`/`running` sessions or threads with an active turn. UI flows that intentionally kill work must use an explicit stop-and-delete path (`thread.session.stop` first, then delete after the projected session is no longer active). Closing, hiding, or removing a sub-chat from view should use archive/visibility semantics instead of delete.
- Workspace file APIs live under `apps/server/src/workspace` and `packages/contracts/src/workspaceFiles.ts`. Clients address files by `(environmentId, cwd, relativePath)`; server code must resolve paths inside the active root and reject escapes, unsafe symlinks, binary/too-large edits, and stale-version writes.
- Terminal contracts and session metadata can carry `workspaceId`; server terminal sessions remain thread-keyed for backward compatibility but should preserve workspace metadata in snapshots/summaries, and web/client-runtime filters should use workspace-aware terminal lists where available. Workspace-backed terminal drawers and project-script run state are UI-keyed by workspace so terminals/actions persist across all sub-chats in the workspace; individual terminal attach/write/close requests must still use each session's recorded thread target.
- Browser-agent state is owned by `apps/server/src/browserAgents/registry.ts`. Provider browser commands route by `(environmentId, threadId, browserContextId)`, where provider root agents and sub-agents use provider-thread browser contexts so agent-created tabs do not replace the user preview/default side-panel context.
- Agent browser tools include `browser_open_tab` to create/link an agent tab and `browser_close_tab` to close and unlink it when the agent is done. Keep close separate from detach semantics: detach unlinks T3 state without closing the real tab, while close sends a browser-agent close command and waits for the extension result.
- Browser-agent host control should not require manual extension pairing. Same-machine desktop control uses unauthenticated `GET /browser-agent/local-ws`, which must stay desktop-mode and loopback-only. Authenticated remote/manual pairing remains on `GET /browser-agent/ws`; token auto-connect via `POST /browser-agent/auto-connect` is fallback behavior and must issue client bearer sessions through `ServerAuth`. Same-origin Preview asks the extension content script to derive a browser-agent bearer session from the browser's existing authenticated host session via `POST /browser-agent/session`; Preview must not mint separate extension tokens through the app websocket or put short-lived session tokens in manual setup URLs. If the browser is not authenticated to the host, the UI should tell the user to open/pair/sign in to the T3 Code host in that browser, after which the extension can auto-grab the host session. Preview RPCs target that extension with `preferredAgentId` / `preferredSessionId` instead of falling back to the host browser. Extension side-panel chat URLs use short-lived sidebar bearer tokens; keep tokens out of stored workspace-link URLs and use extension session storage for refresh/reopen reconstruction.
- Workspace preview targets use the shared `PreviewTarget` contract in `packages/contracts/src/previewTargets.ts`, web selection helpers in `apps/web/src/previewTargets.ts`, and the persisted workspace-scoped target store in `apps/web/src/workspacePreviewTargets.ts`. Current discovery is backed by terminal process-listener detection (`terminal.detectWebServers`) for active workspace terminals; keep future preview discovery keyed by environment/project/workspace/cwd/terminal/script instead of global project defaults or component-local preview state.
- Browser-agent screenshots use CDP `Page.captureScreenshot` with full-page capture, then `apps/chrome-extension/offscreen.html` / `offscreen.js` downscale and compress the image. Browser screenshot tool-call output should stay attached to work-log entries so users can inspect the exact captured artifact.
- Codex browser tools are exposed through `apps/server/src/provider/browserDynamicTools.ts`; do not expose unrestricted browser automation tools directly to providers without T3 thread-link authorization.
- App-wide Codex instructions include concise `t3-html-preview` guidance for visual examples; the renderer supports inline CSS and inline JavaScript in a sandbox, with external network requests blocked.
- Organization panel APIs live in `apps/server/src/organizationPanels.ts` and `apps/server/src/organizationPanelDynamicRpc.ts`; generated panel behavior must stay behind slug validation, approved imports, rollback/version history, and dynamic RPC boundaries.
- Desktop starts a child backend process with bootstrap config and clears conflicting backend env vars before launch. Desktop startup also syncs the Chrome extension source to the stable unpacked install folder under the local app-data directory for local extension testing. For active development, `pnpm dev:desktop` runs the web dev server, watched Electron app, watched server bundle, and watched browser-extension sync together.
- Remote access is supported through SSH helpers (`packages/ssh`) and Tailscale Serve helpers (`packages/tailscale`).

### Environment Variables

There is no checked-in `.env.example` at the moment. Add one when introducing documented developer-facing env vars.

**Server / CLI runtime**

- `T3CODE_HOME`: Base directory for state, logs, caches, worktrees, attachments, and secrets.
- `T3CODE_MODE`: Runtime mode, `web` or `desktop`.
- `T3CODE_PORT`: HTTP/WebSocket server port. Default is `3773`.
- `T3CODE_HOST`: Host/interface to bind.
- `T3CODE_NO_BROWSER`: Disable automatic browser opening.
- `T3CODE_BOOTSTRAP_FD`: Read one-time bootstrap secrets from a file descriptor.
- `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD`: Create a project for the current working directory on startup when missing.
- `T3CODE_LOG_WS_EVENTS`: Emit server-side logs for outbound WebSocket push traffic.
- `T3CODE_LOG_LEVEL`, `T3CODE_TRACE_MIN_LEVEL`, `T3CODE_TRACE_TIMING_ENABLED`, `T3CODE_TRACE_FILE`, `T3CODE_TRACE_MAX_BYTES`, `T3CODE_TRACE_MAX_FILES`, `T3CODE_TRACE_BATCH_WINDOW_MS`: Server logging/tracing controls.
- `T3CODE_OTLP_TRACES_URL`, `T3CODE_OTLP_METRICS_URL`, `T3CODE_OTLP_EXPORT_INTERVAL_MS`, `T3CODE_OTLP_SERVICE_NAME`: Optional OTLP export configuration.

**Web build/dev**

- `PORT`, `HOST`: Vite dev server bind settings.
- `VITE_DEV_SERVER_URL`: Desktop/server dev URL override; also used by the server to proxy or redirect to web dev assets.
- `VITE_HTTP_URL`, `VITE_WS_URL`: Client backend HTTP/WebSocket URL overrides in dev and remote contexts.
- `VITE_HOSTED_APP_URL`, `VITE_HOSTED_APP_CHANNEL`: Hosted app URL/channel branding and pairing configuration.
- `APP_VERSION`: Injected app version for web branding/version skew checks.
- `T3CODE_WEB_SOURCEMAP`: Web build sourcemap mode (`false`, `0`, `hidden`, or default true).
- `VERCEL_ENV`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL`: Vercel-provided hosted URL detection.

**Desktop / backend child process**

- `VITE_DEV_SERVER_URL`: Required for desktop development.
- `T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH`: Dev override for remote T3 server entry path.
- `T3CODE_DESKTOP_WS_URL`, `T3CODE_DESKTOP_LAN_ACCESS`, `T3CODE_DESKTOP_LAN_HOST`, `T3CODE_DESKTOP_HTTPS_ENDPOINTS`: Desktop backend exposure and connection settings.
- `T3CODE_TAILSCALE_SERVE`, `T3CODE_TAILSCALE_SERVE_PORT`: Tailscale Serve enablement and HTTPS port.
- `T3CODE_DESKTOP_UPDATE_REPOSITORY`, `GITHUB_REPOSITORY`: Desktop artifact/update repository resolution.

**Mobile / EAS**

- `APP_VARIANT`: Mobile build variant: `development`, `preview`, or `production`.
- `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE`: `javascript` or `native` review diff highlighter.
- `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_DISABLE_CACHE`: Disable mobile review highlighter cache.
- `EXPO_NO_GIT_STATUS`: Used by local native prebuild/run scripts.

**Source control and provider tooling**

- `T3CODE_BITBUCKET_EMAIL`, `T3CODE_BITBUCKET_API_TOKEN`: Bitbucket API authentication.
- `CODEX_HOME`: Codex home/config root when passed to provider subprocesses or configured provider instances.
- `CODEX_BIN`: Test/probe override for Codex binary.
- `T3_SSH_AUTH_SECRET`: Internal SSH askpass secret passed to helper scripts.

**Script/test-only variables**

- `T3_ACP_*`, `ACP_MOCK_*`, `CURSOR_*`: Mock/probe variables for ACP and Cursor scripts.
- `PYTHON`, `npm_config_python`, `LOCALAPPDATA`: Build helper inputs used by desktop artifact scripts.

## i18n (Internationalization)

- No formal i18n system is present today.
- Keep user-facing strings centralized when a feature already has a local metadata/helper module.
- If translations are introduced, document the dictionary structure, lookup hooks, fallback behavior, and add-language workflow here.

## Codex App Server

T3 Code supports multiple providers, but Codex integration is still a critical path. The server starts `codex app-server` through `packages/effect-codex-app-server` and the provider runtime layers, then projects structured provider events into orchestration state for clients.

Key files:

- `apps/server/src/provider/Drivers/CodexDriver.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`
- `apps/server/src/provider/browserDynamicTools.ts`
- `packages/effect-codex-app-server/src/client.ts`
- `packages/effect-codex-app-server/src/protocol.ts`
- `packages/contracts/src/providerRuntime.ts`

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete reference implementation): https://github.com/Dimillian/CodexMonitor
- Paseo: https://github.com/getpaseo/paseo

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Dynamic Memory

Dynamic Memory is a living section of this file used to store reusable knowledge discovered during development: key file paths, helper functions, component names, patterns, and conventions that come up repeatedly. It eliminates redundant searching and helps agents write efficient, consistent code faster.

How to use it: When you discover something reusable, such as a utility, a pattern, or a key file location, add it here. When something becomes outdated or irrelevant, remove it. Keep entries concise and long-term relevant only. Do not include temporary notes or one-off context.

### Reusable Utilities & Helpers

- `apps/web/src/lib/utils.ts`: `cn` class merge helper for Tailwind/class composition.
- `packages/shared/src/schemaJson.ts`: Strict JSON encode/decode helpers for Schema-backed data.
- `packages/shared/src/git.ts`: Git remote/ref normalization helpers.
- `packages/shared/src/sourceControl.ts`: Source-control provider presentation and URL helpers.
- `packages/shared/src/toolActivity.ts`: Provider tool activity path/summary extraction, including browser-agent action labels for dynamic browser tools.
- `packages/shared/src/projectScripts.ts`: Project script normalization and metadata helpers.
- `packages/shared/src/keybindings.ts`: Keybinding parsing/normalization utilities.
- `packages/client-runtime/src/wsTransport.ts`: Shared WebSocket transport state machine.
- `packages/client-runtime/src/threadDetailReducer.ts`: Shared thread detail projection logic.
- `packages/client-runtime/src/reconnectBackoff.ts`: Reconnect backoff helper.
- `packages/client-runtime/src/workbenchTabsState.ts`: Shared workbench tab model/reducer.
- `packages/client-runtime/src/shellSnapshotReducer.ts`: Shared organization/project/workspace/sub-chat/action shell snapshot reducer.
- `packages/client-runtime/src/terminalSessionState.ts`: Shared terminal session manager; storage remains thread-keyed for compatibility, while `workspaceId` metadata supports workspace-owned terminal filtering.
- `packages/client-runtime/src/workspaceTreeState.ts`: Shared lazy workspace directory state manager.
- `packages/client-runtime/src/workspaceDocumentState.ts`: Shared workspace document/editor state manager with conflict/deleted/unsupported states.
- `packages/contracts/src/workspaceFiles.ts`: Workspace file/tree/watch contract schemas and error codes.
- `packages/contracts/src/orchestration.ts`: Organization/project/workspace/sub-chat/action shell schemas, legacy thread compatibility fields, and shell stream event contracts.
- `packages/contracts/src/browserAgent.ts`: Browser-agent v2 runtime, workspace/tab, capture, diagnostics, command, input, and workspace-link schemas.
- `packages/contracts/src/auth.ts`: Auth policy, session, client metadata, and pairing schemas; `AuthSessionState.client` carries current-session device metadata.
- `packages/contracts/src/organizationPanel.ts`: Organization panel snapshot, turn, history, rollback, event, and dynamic RPC schemas.
- `apps/server/src/auth/utils.ts`: Auth request metadata derivation, including device type, OS, browser, and IP from request headers/source.
- `apps/server/src/browserAgents/registry.ts`: In-memory browser agent registry and thread workspace-link authority.
- `apps/server/src/browserAgents/ws.ts`: Browser-agent WebSocket routes; local desktop control uses loopback-only `/browser-agent/local-ws` without pairing, while `/browser-agent/ws` remains the authenticated remote/manual pairing path.
- `apps/server/src/provider/browserDynamicTools.ts`: Codex dynamic browser tools authorized through thread browser links, including tab open/close, v2 extension runtime diagnostics, and default CDP-backed tools.
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`: Derives the compatibility organization/workspace/sub-chat shell hierarchy from legacy projection rows and exposes targeted workspace/sub-chat lookup helpers for live shell streams.
- `apps/server/src/persistence/Migrations/037_ProjectionWorkspaceHierarchy.ts`: Creates and backfills organization/workspace/sub-chat/action projection tables using the same legacy workspace id derivation as runtime snapshots.
- `apps/chrome-extension/service-worker.js`: Browser-agent runtime, including loopback local-control auto-connect, web-triggered advertised loopback probes, saved-backend reconnect fallback, same-session bearer pairing from `/browser-agent/session`, pairing-time content-script reinjection into already-open trusted T3 tabs, dev reload marker polling/reinjection, collapsed Chrome grouping for extension-created tabs, side-panel sidebar bearer token reconstruction, CDP control, tab commands, diagnostics, CDP cursor overlay forwarding, and extension-internal test hooks.
- `apps/chrome-extension/transfer-content.js`: Page-side browser-agent bridge for annotation, side-panel prompts, thread-tab DOM input, snapshots, and the visible in-page agent cursor overlay.
- `apps/chrome-extension/dev-reload.json`: Source placeholder for dev extension reload state; `scripts/dev-browser-extension-sync.mjs` writes an enabled copy into app-data extension folders during development.
- `apps/chrome-extension/offscreen.js`: Offscreen extension document for screenshot downscale/compression.
- `apps/desktop/src/app/DesktopBrowserAgentExtension.ts`: Desktop startup sync for the stable unpacked Chrome extension folder under the local app-data directory, such as `~/Library/Application Support/t3code-dev/Chrome Extension` on macOS dev builds.
- `scripts/dev-desktop.mjs`: Local desktop development supervisor used by `pnpm dev:desktop`; runs the desktop/web dev loop, server bundle watch, and browser-extension sync watch together.
- `scripts/dev-browser-extension-sync.mjs`: Copies `apps/chrome-extension` into stable app-data extension folders and writes enabled `dev-reload.json` markers for extension self-reload.
- `scripts/build-desktop-artifact.ts`: Desktop artifact packaging script; macOS `dir` targets must flatten `.app` directory artifacts into the output directory and use `ditto` so bundle symlinks/xattrs survive replacement.
- `apps/server/src/provider/CodexDeveloperInstructions.ts`: T3-injected Codex developer instructions, including collaboration mode, chat preview rendering, and browser-runtime tool usage guidance.
- `apps/server/src/provider/AppProviderInstructions.ts`: Provider-neutral T3 developer instruction builder for collaboration modes, browser tools, HTML previews, future in-app tools, MCP-backed integrations, and T3 skill guidance; provider-specific instruction files should wrap this instead of duplicating app-level prompt text.
- `apps/web/src/lib/storage.ts`: Web storage helper patterns.
- `apps/web/src/lib/diffRendering.ts`: Web diff rendering helpers.
- `apps/web/src/lib/workspaceFileState.ts`: Web bindings for workspace tree/document managers.
- `apps/web/src/environments/primary/target.ts`: Primary environment HTTP/WS target resolver; remote non-loopback app origins override configured loopback backend URLs for Tailscale/LAN loads.
- `apps/web/src/browserAgentPairing.ts`: Browser-agent setup helpers; same-origin Preview asks the content script to derive `/browser-agent/session` from the browser's host session, then returns a connected `preferredAgentId`, allowing content-script-confirmed local-control fallback when the issued browser session has not registered yet and backend-visible connected-extension fallback when the app tab is missing the content script.
- `apps/web/src/previewUrls.ts`: Preview URL normalization, dev-server inference, and current-browser reachability rewriting for loopback URLs.
- `apps/web/src/workspacePreviewTargets.ts`: Persisted workspace-scoped preview target store used by scripts/actions, Preview, and browser-agent side-panel routing.
- `apps/web/src/workbenchStore.ts`: Web workbench tab state and file reveal/open helpers.
- `apps/web/src/store.ts`: Web shell state slices for organizations, workspaces, sub-chats, and workspace actions.
- `apps/web/src/components/Sidebar.logic.ts`: `buildSidebarWorkspaceThreadGroups` groups visible sub-chat/thread rows under workspace headers.
- `docs/architecture/organization-project-workspace-subchat-spec.md`: Product/architecture spec for organization > projects > workspaces > sub-chats/actions/terminal.
- `docs/architecture/sidebar-workspace-navigation-spec.md`: UI/UX spec for compact sidebar workspace navigation, including hidden implicit default workspaces and active status rollups.
- `apps/mobile/src/lib/connection.ts`: Mobile connection helper logic.

### Key Component Paths

- `apps/web/src/components/AppSidebarLayout.tsx`: Main desktop/web sidebar shell.
- `apps/web/src/components/Sidebar.tsx`: Project/thread sidebar content.
- `apps/web/src/components/ChatView.tsx`: Main chat surface.
- `apps/web/src/components/chat/ChatComposer.tsx`: Composer UI.
- `apps/web/src/components/chat/MessagesTimeline.tsx`: Thread message/activity timeline.
- `apps/web/src/session-logic.ts`: Thread timeline/work-log derivation, including persisted tool activity collapse and browser-action metadata.
- `apps/web/src/components/chat/ProviderModelPicker.tsx`: Provider/model picker entry point.
- `apps/web/src/components/chat/PreviewButton.tsx`: User-initiated Preview button; performs same-session extension setup, opens preview URLs in the current browser, and targets the connected extension by agent/session preference.
- `apps/web/src/components/CommandPalette.tsx`: Command palette shell.
- `apps/web/src/components/DiffPanel.tsx`: Checkpoint/diff panel.
- `apps/web/src/components/GitActionsControl.tsx`: Git action controls and PR/review state actions.
- `apps/web/src/components/ThreadTerminalDrawer.tsx`: Thread terminal drawer.
- `apps/web/src/components/workbench/WorkbenchTabStrip.tsx`: Workbench tabs with floating rectangular visual treatment.
- `apps/web/src/components/workspace/WorkspaceExplorer.tsx`: Workspace file explorer.
- `apps/web/src/components/workspace/WorkspaceFileEditor.tsx`: Workspace file editor.
- `apps/web/src/organizationPanel/OrganizationPanelHost.tsx`: Stable host/error boundary for generated organization panels.
- `apps/web/src/routes/organizations.$organizationId.tsx`: Organization panel route, prompt surface, history, rollback, and dynamic panel rendering.
- `apps/web/src/components/settings/SettingsPanels.tsx`: Settings panel composition.
- `apps/web/src/components/ui/`: Shared Base UI/Tailwind primitives.
- `apps/mobile/src/app/`: Expo Router routes.
- `apps/mobile/src/components/`: Shared mobile components.
- `apps/mobile/src/features/`: Mobile feature screens and logic.

### Patterns & Conventions

- Web route files live in `apps/web/src/routes` and use TanStack Router file routing.
- Web/mobile clients should consume shared runtime state from `packages/client-runtime` when behavior overlaps.
- Workbench tabs should go through `packages/client-runtime/src/workbenchTabsState.ts` and `apps/web/src/workbenchStore.ts`. File tabs must track dirty state; browser-agent interaction should stay provider/extension-driven instead of adding a browser tab surface.
- Server domain state flows through orchestration commands/events instead of direct UI-specific mutations.
- New navigation/domain work should prefer workspace/sub-chat/action terminology at boundaries. Keep legacy `thread` compatibility explicit with `BACKWARD COMPATIBILITY` comments when the old shape is still required for persisted data, routes, or provider integrations.
- Provider-specific runtime details should be adapted into shared provider/orchestration contracts before reaching clients.
- Built-in providers currently include Codex, Claude, Cursor, and OpenCode. New first-party providers should implement `ProviderDriver`, join `BUILT_IN_DRIVERS`, and keep adapter/text-generation/snapshot concerns bundled per instance.
- New provider drivers should follow the `ProviderDriver` / `ProviderInstance` model and keep per-instance environment/config isolated.
- Server layers should compose with Effect `Layer` and keep dependencies explicit in service environments.
- SQLite migration ids are permanent once any alpha/dev build may have run them. If an id collision ships, repair it with a newer forward migration instead of reusing or renaming the collided id.
- Source-control operations should go through provider registry/services and VCS abstractions instead of shelling out locally in UI code.
- Workspace file operations must stay scoped to the active project/worktree root. Preserve conflict detection with `WorkspaceFileVersion`; do not blindly overwrite external/agent edits.
- Browser-agent state should be backend-owned and streamed through the browser-agent protocol; do not infer durable state from Chrome tab groups.
- Provider browser tools must be thread-scoped and browser-context-scoped. Providers should not receive or supply raw browser `tabId` authority; the server resolves `(environmentId, threadId, browserContextId)` to the authorized workspace link, with isolated provider-thread contexts for root agents and sub-agents.
- Organization panels are generated-code surfaces. Keep generated edits within the organization panel boundary, validate panel slugs/imports, preserve rollback history, and expose data/actions through approved dynamic RPC methods.
- Project scripts are configured through `.t3code/project.json`; pinned scripts can appear in the T3 Code top bar.
- Desktop backend launch should use bootstrap envelopes and clear conflicting inherited backend env vars as done in `DesktopBackendConfiguration`.
- Mobile native code changes require `vp run lint:mobile` in addition to the standard completion checks.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vp run sync:repos`; use `vp run sync:repos --repo <id>` to sync one configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for idiomatic usage, tests, module structure, and API design.
