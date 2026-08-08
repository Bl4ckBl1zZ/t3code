# Fork changes

This fork stays close to `pingdotgg/t3code` and carries only the following operational changes:

- Builds a macOS ARM64-only DMG with bundle ID `com.t3code.dev`; the desktop updater reads releases
  from `Bl4ckBl1zZ/t3code`. CI applies and deeply verifies a complete ad-hoc signature when Apple
  credentials are absent, then automatically switches to Developer ID signing, hardened runtime,
  notarization, and Gatekeeper validation when the production credentials are configured.
- Syncs `upstream/main` into the fork through a scheduled T3 Code agent task rather than a
  `sync-upstream` workflow: the task resolves conflicts on the merits, audits the fork invariants
  below, and opens a PR. Do not reintroduce `.github/workflows/sync-upstream.yml`.
- Runs threads on the fork's own orchestration V2 stack (`apps/server/src/orchestration-v2`) and has
  retired upstream's V1 orchestrator. `apps/server/src/orchestration` survives only as the project
  aggregate plus the legacy-import path, and V1 thread contracts live in
  `@t3tools/contracts/legacy-orchestration`. Consequences for every sync: upstream changes to V1
  thread deciders, projectors, provider adapters, reactors, ingestion, or `projection_threads`
  resolve to the fork; features upstream builds on the V1 orchestrator must be ported onto
  orchestration V2 rather than merged. The fork does not carry upstream's V1 subagent-observability
  bridge (`subagentRuntime`, `AgentsPanel`, `workflowScriptQuery`, `ThreadBackgroundLiveness`); its
  own subagent observability comes from orchestration V2's `SubagentProjection` and the V2 timeline.
  It likewise does not carry upstream's keyset thread pagination (`turnLimit`/`beforeCursor`,
  `threadDetailCursor`, `page` metadata, the `threadSnapshotPagination` capability), which reads V1
  `projection_turns`; the fork windows cold loads with `maxVisibleItems` /
  `truncatedVisibleItemCount` over the V2 projection instead (`threadSnapshotWindow`), and
  `requestThreadFullHistory` is its load-more path.
- Implements pinned-thread reordering on orchestration V2 rather than upstream's V1
  `thread.pin.reorder` command. `pinOrderKey` rides the fork's single `thread.metadata.update`
  command (alone to reorder, or with `pinned: true` to place a fresh pin) and is cleared when a
  thread is unpinned; the fractional-key math itself is upstream's shared
  `@t3tools/client-runtime/state/thread-sort`, so web and mobile compute identical orders. The
  server keeps advertising the `threadPinReorder` capability. Mobile uses this end to end. The web
  sidebar deliberately does not adopt upstream's pinned-block drag: it keeps the fork's
  client-local whole-list manual order (`applyManualThreadOrderForSidebarV2`), which already lets
  users arrange pinned threads and would otherwise fight upstream's DnD over the same
  `DndContext`.
- Owns SQLite migration numbers 36 and up (orchestration V2, Hermes, scheduled tasks). Upstream
  migrations that claim those numbers must be renumbered or dropped on sync — applying two different
  migrations under one number would corrupt existing fork databases. Upstream's
  `036_ProjectionThreadsPinned`, `037_ProjectionTurnsKeysetIndex`, and
  `038_ProjectionThreadsPinOrderKey` are dropped: they target the retired V1
  `projection_threads`/`projection_turns` tables, and the fork already implements thread pinning
  (and its ordering key) in orchestration V2, whose thread state is a JSON projection rather than
  those columns.
- Uses a provider-neutral PostgreSQL database on Dokploy instead of provisioning PlanetScale.
- Reaches private PostgreSQL through a Cloudflare Workers VPC service and an existing Hyperdrive
  binding while keeping the database's public port closed.
- Runs database migrations through an authenticated `cloudflared access tcp` listener in CI.
- Uses the authenticated Dokploy CLI on every `main` deployment to verify the dedicated PostgreSQL
  service is running before applying migrations. The database stays private and is deployed only
  when Dokploy reports it unavailable.
- Uses one least-privilege Worker credential for managed tunnels and DNS instead of attempting to
  mint API tokens from an OAuth deployment credential.
- Deploys the T3 Connect relay with APNs production credentials for `com.t3code.dev`, including push
  notification and Live Activity delivery support. Every push to `main` applies the Cloudflare
  Worker stack and verifies the public relay plus its PostgreSQL dependency through `/health`.
- Uses Cloudflare Worker logs for initial relay diagnostics, with no Axiom account or ingest tokens
  required.
- Carries a native SwiftUI iOS client at `apps/swift-ios`, vendored from upstream PR #5178
  (`t3code/rebuild-mobile-app-swift`, head `7b8bb94d5`) while that PR is still open and marked
  `DO NOT MERGE`. It is being migrated to replace the React Native client entirely: the fork ships
  iOS only, with no Android target. Consequences for every sync: upstream changes under
  `apps/swift-ios` merge normally, but the app is being re-targeted from upstream's V1 thread
  contracts onto the fork's orchestration V2, so upstream edits to its transport, `Core/Models.swift`,
  or `App/NativeFeatureClient.swift` resolve to the fork. Once `apps/mobile` is deleted, upstream
  changes under that path resolve to deletion.
- Uses the fork's iOS identifiers: `com.t3code.dev`, `com.t3code.dev.widgets`,
  `com.t3code.dev.sharing`, and `group.com.bl4ckbl1zz.t3code.dev`, supplied through the fork's iOS
  build variables. Local development signing uses the APNs sandbox; TestFlight exports use
  production APNs entitlements and dedicated App Store profiles for all three targets.
- Builds and uploads the production iOS app to the fork's App Store Connect/TestFlight app on an
  Apple Silicon macOS runner, driven by `mobile-ios-testflight.yml` (prebuild -> `xcodebuild`
  archive -> export -> upload, with no EAS service). It ships on every push to `main`, on `v*` and
  `fork-v*` tags, and on manual dispatch. An archive takes ~40 minutes, so the `ios-testflight`
  concurrency group cancels a run in flight when a newer merge lands: TestFlight only ever receives
  head of `main`. `mobile-eas-production.yml` stays as an `eas build --local` fallback. An internal group automatically receives every processed build, and the external group
  exposes a public TestFlight invitation after Apple's initial Beta App Review. The fork does not
  consume the upstream Expo project's OTA updates; TestFlight distributes signed updates to
  opted-in testers.
