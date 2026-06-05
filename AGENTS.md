# AGENTS.md

## Maintaining This File

- Always update `AGENTS.md` when making changes that affect architecture, patterns, infrastructure, or design language.
- Always keep the "Product Overview" section current. When features are added, renamed, or removed, update their names and descriptions. When branding changes (app name, tagline, terminology), reflect it immediately. This section is the single source of truth for what the product is and does.
- Always keep `.env.example` up to date when adding/removing environment variables. This repo does not currently have a `.env.example`; create one before introducing new environment variables that should be documented for developers.
- If repeated corrections or pattern deviations are noticed, ask the user: "Should we update AGENTS.md to prevent this from recurring?"
- Keep entries concise. This file is a living reference for consistency across the project.

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `bun lint:mobile` must also pass.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## GitHub Pull Requests

- When creating pull requests from this workspace, target `origin` / `Bl4ckBl1zZ/t3code` unless the user explicitly asks for `upstream` / `pingdotgg/t3code`.
- Never infer the parent fork as the pull request target.

## Product Overview

Update this section as the product evolves. Keep feature names, descriptions, and branding current.

- **App Name**: T3 Code
- **Tagline / Description**: Minimal GUI for coding agents across web, desktop, browser, and mobile surfaces.
- **Core Purpose**: T3 Code helps developers run, organize, and supervise coding-agent sessions for local and remote repositories, with reliable orchestration, source-control workflows, terminals, diffs, workspace editing, and thread-scoped browser tooling.

### Features

- **Agent Threads**: Chat-style coding-agent sessions with turn state, streaming activity, approvals, user-input prompts, and resumable history.
- **Provider Instances**: Configurable Codex, Claude, Cursor, and OpenCode providers, including multiple instances per driver where supported.
- **Projects & Worktrees**: Project registry, repository identity, branch/worktree preparation, setup scripts, and per-project settings.
- **Source Control Workflows**: Git status, branch actions, commit helpers, pull request / merge request creation, review flows, and provider discovery for GitHub, GitLab, Bitbucket, and Azure DevOps.
- **Workspace Tools**: VS Code-style file explorer, Monaco editor, conflict-aware saves, checkpoint diffs, changed-file trees, terminal sessions, command palette, and workbench tabs.
- **Browser Agent**: Chrome extension runtime for preview tabs, thread-scoped browser workspaces, per-agent/sub-agent Chrome tab contexts, native side panels, default CDP-backed control, full-page screenshot tool artifacts in work logs, browser input/form forwarding, annotation screenshots, diagnostics, startup-synced unpacked extension installs, host-local control without manual pairing, popup self-reload/update, and remote browser control over reachable backend URLs.
- **Organization Panels**: Organization-scoped generated dashboard panels with prompt-driven panel agents, streamed activity, rollback history, and dynamic panel RPC.
- **Desktop App**: Electron shell that starts and supervises the backend, manages updates, SSH environments, Tailscale exposure, native menus, and secure local settings.
- **Mobile App**: Expo/React Native companion app in development for connecting to T3 Code environments, reviewing diffs, using terminals, and managing threads.
- **Marketing Site**: Astro site for product/download pages and release-facing assets.
- **Observability & Diagnostics**: Effect tracing, local NDJSON trace files, OTLP export, provider event logs, process diagnostics, and update/release smoke tooling.

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

- **Monorepo / Package Manager**: Bun `1.3.14` workspaces with Turbo `^2.3.3`; do not migrate this repo to pnpm or Next.js without an explicit architecture decision.
- **Language**: TypeScript `~6.0.3` with `@typescript/native-preview` `7.0.0-dev.20260527.2` and `@effect/tsgo` `0.11.4`.
- **Effect Runtime**: Effect `4.0.0-beta.73`, `@effect/platform-bun`, `@effect/platform-node`, and `@effect/sql-sqlite-bun` for typed services, config, HTTP, persistence, and tests.
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
  server/              Node/Bun-compatible T3 CLI and backend server.
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
scripts/               Dev runner, release/build scripts, static checks, and sync utilities.
.t3code/project.json   Project scripts surfaced in T3 Code, including pinned top-bar actions.
docs/                  Architecture, provider, observability, release, and feature documentation.
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
- Desktop/web typography uses DM Sans with system fallbacks; code uses SF Mono / system monospace.

### Navigation Layout

- Desktop/web uses a left project/thread sidebar (`AppSidebarLayout`), central chat/workbench area, workbench tabs, and right-side sheets/panels for auxiliary workflows.
- Workbench tabs are modeled in `packages/client-runtime/src/workbenchTabsState.ts` and currently support `chat`, `file`, `diff`, and `terminal` tab kinds. Add new tab surfaces through that model instead of inventing route-local tab state. Web workbench tabs use a floating rectangular treatment in `WorkbenchTabStrip`; preserve that shape, spacing, and active-tab elevation when adding tab kinds.
- Browser-agent tab interaction is provider-driven through browser tools and the extension runtime; do not add a user-facing browser workbench panel unless the architecture changes again.
- Settings are route-backed panels under `apps/web/src/routes/settings.*.tsx` and feature-specific components under `apps/web/src/components/settings`.
- Mobile uses Expo Router under `apps/mobile/src/app`, with connection, new-project/new-thread, thread, git, review, and terminal screens. Mobile flows should be stack-friendly and avoid desktop-only assumptions.
- Browser-agent preview flows should keep browser state owned by the backend/extension protocol, not by inferred Chrome tab-group UI. Routine thread browser control should not focus or foreground the real browser window; reserve real browser focus for explicit user actions such as "Open in browser" or annotation capture. Desktop startup syncs the unpacked browser-agent extension into the local app-data folder, for example `~/Library/Application Support/t3code-dev/Chrome Extension` on macOS dev builds, by fully replacing that folder from the repo/bundled `chrome-extension` source. Chrome should load that stable unpacked folder for local testing; after startup sync, use the extension popup reload path so Chrome reloads changed service workers/content scripts. The extension should auto-connect to the host desktop backend by preferring the loopback-only local-control WebSocket, including advertised loopback backend URLs from the Preview flow, then falling back to saved/authenticated pairing only when local control is unavailable. App UI should surface protocol/runtime mismatches from the connected agent snapshot.

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
- Auth uses bootstrap credentials, bearer aliases, session credentials, and short-lived WebSocket tokens under `apps/server/src/auth`.
- Provider sessions are managed through `apps/server/src/provider`; Codex runs `codex app-server` per provider session through the typed wrapper package.
- Built-in provider drivers are registered in `apps/server/src/provider/builtInDrivers.ts`; keep driver additions there and make sure the runtime layer satisfies the driver's declared environment.
- Orchestration projects provider runtime events into domain events consumed by the web/mobile clients.
- `thread.delete` is permanent destruction and must reject active `starting`/`running` sessions or threads with an active turn. UI flows that intentionally kill work must use an explicit stop-and-delete path (`thread.session.stop` first, then delete after the projected session is no longer active). Closing, hiding, or removing a sub-chat from view should use archive/visibility semantics instead of delete.
- Workspace file APIs live under `apps/server/src/workspace` and `packages/contracts/src/workspaceFiles.ts`. Clients address files by `(environmentId, cwd, relativePath)`; server code must resolve paths inside the active root and reject escapes, unsafe symlinks, binary/too-large edits, and stale-version writes.
- Browser-agent state is owned by `apps/server/src/browserAgents/registry.ts`. Provider browser commands route by `(environmentId, threadId, browserContextId)`, where the main agent uses the default context and each sub-agent can own an isolated Chrome tab context in the same T3 thread.
- Browser-agent host control should not require manual extension pairing. Same-machine desktop control uses unauthenticated `GET /browser-agent/local-ws`, which must stay desktop-mode and loopback-only. Authenticated remote/manual pairing remains on `GET /browser-agent/ws`; token auto-connect via `POST /browser-agent/auto-connect` is fallback behavior and must issue client bearer sessions through `ServerAuth`. Extension side-panel chat URLs use short-lived sidebar bearer tokens; keep tokens out of stored workspace-link URLs and use extension session storage for refresh/reopen reconstruction.
- Browser-agent screenshots use CDP `Page.captureScreenshot` with full-page capture, then `apps/chrome-extension/offscreen.html` / `offscreen.js` downscale and compress the image. Browser screenshot tool-call output should stay attached to work-log entries so users can inspect the exact captured artifact.
- Codex browser tools are exposed through `apps/server/src/provider/browserDynamicTools.ts`; do not expose unrestricted browser automation tools directly to providers without T3 thread-link authorization.
- App-wide Codex instructions include concise `t3-html-preview` guidance for visual examples; the renderer supports inline CSS and inline JavaScript in a sandbox, with external network requests blocked.
- Organization panel APIs live in `apps/server/src/organizationPanels.ts` and `apps/server/src/organizationPanelDynamicRpc.ts`; generated panel behavior must stay behind slug validation, approved imports, rollback/version history, and dynamic RPC boundaries.
- Desktop starts a child backend process with bootstrap config and clears conflicting backend env vars before launch. Desktop startup also syncs the Chrome extension source to the stable unpacked install folder under the local app-data directory for local extension testing.
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
- `packages/client-runtime/src/workspaceTreeState.ts`: Shared lazy workspace directory state manager.
- `packages/client-runtime/src/workspaceDocumentState.ts`: Shared workspace document/editor state manager with conflict/deleted/unsupported states.
- `packages/contracts/src/workspaceFiles.ts`: Workspace file/tree/watch contract schemas and error codes.
- `packages/contracts/src/browserAgent.ts`: Browser-agent v2 runtime, workspace/tab, capture, diagnostics, command, input, and workspace-link schemas.
- `packages/contracts/src/auth.ts`: Auth policy, session, client metadata, and pairing schemas; `AuthSessionState.client` carries current-session device metadata.
- `packages/contracts/src/organizationPanel.ts`: Organization panel snapshot, turn, history, rollback, event, and dynamic RPC schemas.
- `apps/server/src/auth/utils.ts`: Auth request metadata derivation, including device type, OS, browser, and IP from request headers/source.
- `apps/server/src/browserAgents/registry.ts`: In-memory browser agent registry and thread workspace-link authority.
- `apps/server/src/browserAgents/ws.ts`: Browser-agent WebSocket routes; local desktop control uses loopback-only `/browser-agent/local-ws` without pairing, while `/browser-agent/ws` remains the authenticated remote/manual pairing path.
- `apps/server/src/provider/browserDynamicTools.ts`: Codex dynamic browser tools authorized through thread browser links, including v2 extension runtime diagnostics and default CDP-backed tools.
- `apps/chrome-extension/service-worker.js`: Browser-agent runtime, including loopback local-control auto-connect, web-triggered advertised loopback probes, saved-backend reconnect fallback, side-panel sidebar bearer token reconstruction, CDP control, tab commands, diagnostics, and extension-internal test hooks.
- `apps/chrome-extension/offscreen.js`: Offscreen extension document for screenshot downscale/compression.
- `apps/desktop/src/app/DesktopBrowserAgentExtension.ts`: Desktop startup sync for the stable unpacked Chrome extension folder under the local app-data directory, such as `~/Library/Application Support/t3code-dev/Chrome Extension` on macOS dev builds.
- `apps/server/src/provider/CodexDeveloperInstructions.ts`: T3-injected Codex developer instructions, including collaboration mode, chat preview rendering, and browser-runtime tool usage guidance.
- `apps/web/src/lib/storage.ts`: Web storage helper patterns.
- `apps/web/src/lib/diffRendering.ts`: Web diff rendering helpers.
- `apps/web/src/lib/workspaceFileState.ts`: Web bindings for workspace tree/document managers.
- `apps/web/src/workbenchStore.ts`: Web workbench tab state and file reveal/open helpers.
- `apps/mobile/src/lib/connection.ts`: Mobile connection helper logic.

### Key Component Paths

- `apps/web/src/components/AppSidebarLayout.tsx`: Main desktop/web sidebar shell.
- `apps/web/src/components/Sidebar.tsx`: Project/thread sidebar content.
- `apps/web/src/components/ChatView.tsx`: Main chat surface.
- `apps/web/src/components/chat/ChatComposer.tsx`: Composer UI.
- `apps/web/src/components/chat/MessagesTimeline.tsx`: Thread message/activity timeline.
- `apps/web/src/session-logic.ts`: Thread timeline/work-log derivation, including persisted tool activity collapse and browser-action metadata.
- `apps/web/src/components/chat/ProviderModelPicker.tsx`: Provider/model picker entry point.
- `apps/web/src/components/chat/PreviewButton.tsx`: Preview open/focus control and browser-agent pairing entry point.
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
- Provider-specific runtime details should be adapted into shared provider/orchestration contracts before reaching clients.
- Built-in providers currently include Codex, Claude, Cursor, and OpenCode. New first-party providers should implement `ProviderDriver`, join `BUILT_IN_DRIVERS`, and keep adapter/text-generation/snapshot concerns bundled per instance.
- New provider drivers should follow the `ProviderDriver` / `ProviderInstance` model and keep per-instance environment/config isolated.
- Server layers should compose with Effect `Layer` and keep dependencies explicit in service environments.
- Source-control operations should go through provider registry/services and VCS abstractions instead of shelling out locally in UI code.
- Workspace file operations must stay scoped to the active project/worktree root. Preserve conflict detection with `WorkspaceFileVersion`; do not blindly overwrite external/agent edits.
- Browser-agent state should be backend-owned and streamed through the browser-agent protocol; do not infer durable state from Chrome tab groups.
- Provider browser tools must be thread-scoped and browser-context-scoped. Providers should not receive or supply raw browser `tabId` authority; the server resolves `(environmentId, threadId, browserContextId)` to the authorized workspace link, with isolated contexts for sub-agents.
- Organization panels are generated-code surfaces. Keep generated edits within the organization panel boundary, validate panel slugs/imports, preserve rollback history, and expose data/actions through approved dynamic RPC methods.
- Project scripts are configured through `.t3code/project.json`; pinned scripts can appear in the T3 Code top bar.
- Desktop backend launch should use bootstrap envelopes and clear conflicting inherited backend env vars as done in `DesktopBackendConfiguration`.
- Mobile native code changes require `bun lint:mobile` in addition to the standard completion checks.
