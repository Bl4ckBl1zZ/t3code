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
  `DndContext`. Upstream's `animatePinnedLayoutChanges` (which stops dnd-kit replaying the
  committed layout move after the pointer is released) is carried and applied to the fork's
  whole-list `SortableSidebarThreadRow` instead of upstream's pinned-block row.
- Replaces upstream's web thread context menu stack (`threadActionMenu.logic.ts`,
  `useThreadActionMenu.ts`) with the fork's `apps/web/src/hooks/useThreadActions.ts` plus menu
  items built inline in `Sidebar.tsx`. Upstream changes to those retired modules resolve to the
  fork: port the menu feature itself (new items, handlers) into `Sidebar.tsx`/`useThreadActions.ts`
  instead of merging the files.
- Does not carry upstream's three large web-client redesigns that are written against the V1
  activity model: "collapse tool activity into one line" (`4a9edff4c1`, the `work-toggle` row,
  `deriveToolLifecycleCollapseKey`, and the `live-activity-focus` CSS) and "attach composer state
  drawers" (`792a1404f6`, the shoulder tabs, `ComposerTasksBadge`, `chat-composer-*-drawer`
  surfaces, and the micro approval actions). The fork's timeline renders orchestration V2
  `timelineEntries` and already collapses work rows through its own `work` group and
  `collapseWorkEntriesKeepingLiveBackground`; its composer has diverged in the same places.
  Follow-on upstream work on those files resolves to the fork, and upstream's companion fixes
  (`490f48ed98`'s `AgentSpawnCtaRow` inset, `68966c1e66`'s shoulder-tab spacing) have no fork
  counterpart. Carried out of those commits: `deriveActiveWorkStartedAt`'s
  `latestUserMessageAt` fallback, ported onto the V2 run shell. The third is "unify activity logs
  and composer banners" (`3d32797f6f`, reverted by `8dcb96314c`, re-landed as `30175a8af0`, then
  `9842518c9a` and `3f62e6fa65`): it deletes `ThreadSyncStatusPill`, rewrites `ComposerBannerStack`
  around a new `ComposerBanner`/`ComposerSurface`/`ComposerActivityStatus` trio, and rebuilds
  `MessagesTimeline` and `session-logic` on the drawer surfaces the fork already declined. The
  features that landed only inside those files are therefore not carried either: web video
  attachments in chat (`ac4aae101d`), expanded-preview playback for agent images (`8f525af5af`),
  the circle-alert treatment for failed tool calls (`8b817cbcaa`/`f1e6f0c9bb`), interim turn folding
  (`17c48f7fc1`), and the smoothed worktree setup status (`ef84bc9873`). Upstream's separate web
  file-attachment model (`bcb855a633`: a `files` array beside `images`, `composerFileNeedsReattach`,
  per-chip upload progress) is likewise not carried — the fork's composer already models
  image/file/pdf/video in one `images` array with its own upload queue.
- Does not carry upstream's Codex citations and artifact templates in web chat (`c1e70b5f8c`).
  The shared halves are carried and exported from `@t3tools/client-runtime`
  (`codexFileCitations`, `codexArtifactTemplates`, `codexMarkdownDirectives`), but the renderer
  half is written against upstream's inline `useMemo` component map, while the fork builds its
  through `createChatMarkdownComponents` and keeps the `MarkdownMedia` image path. The
  client-runtime modules stay so a later port has them; they have no fork consumer yet.
- Does not carry upstream's provider-settings list/editor split (`e2d4d12a81`, `f276e632c5`,
  `5e63aea2df`) or its `ProviderInstanceCard` `mode: "list" | "editor"` restructure. The fork keeps
  `EnvironmentProviderSettings` inline in `SettingsPanels.tsx` with the card's own expand/collapse.
- Does not carry upstream's pinned-block drag-to-reorder in the web sidebar (the
  `optimisticPinnedOrder` / `handlePinnedDragEnd` block) or its searchable project-filter combobox
  (`48c176b3cf`, `filterSidebarProjectScopeItems`): both are written against upstream's sidebar
  shell, and the fork keeps its client-local whole-list manual order. Upstream's toggleable unpin
  confirmation (`22c311ddec`) _is_ carried — the setting, `requestThreadUnpinConfirmation`, and
  `useThreadActions` come across unchanged, and the fork's `Sidebar.tsx` `toggleThreadPin` gates its
  `thread.metadata.update` on it rather than upstream's `confirmAndUnpinThread`, which routes
  through the V1 `thread.unpin` command.
- Carries upstream's `ChatUnknownAttachment` forward-compatibility catch-all (`8f49132214`) onto the
  fork's richer `chatAttachment.ts`, whose known kinds are image/file/pdf/video rather than
  upstream's image/file. Consequences: `attachmentRelativePath` returns `string | null` and every
  writer skips a kind it cannot place, `uploadPaths`' extension switch gains a default, and web
  narrows through a new `ChatKnownAttachment`/`isKnownAttachment` pair in `apps/web/src/types.ts`
  because the union's open member is typed `type: string` and defeats literal narrowing. The
  composer's own attachment types are drawn from `ChatKnownAttachment`: composer attachments are
  always locally created and validated, so an unknown kind can never reach them.
- Keeps `PROVIDER_SEND_TURN_MAX_FILE_BYTES` at 20MB rather than upstream's 50MB (`8f49132214`).
  Upstream raised the cap alongside a streaming upload path for generic files; on this fork the
  composer still sends file/pdf/video attachments through the inline base64 path, whose
  `PROVIDER_SEND_TURN_MAX_DATA_URL_CHARS` cap tops out around 21MB, so advertising 50MB would
  promise a size the client cannot send. The signed-upload contract widening itself is carried
  (`assets.ts` accepts `type: "file"` uploads, `AssetAccess` mints download disposition and
  filename/mime claims, `attachmentStore` encodes the extension in the attachment id, and
  `http.ts` serves range requests for inline video).
- Does not carry upstream's "retry failed thread bootstraps with a fresh id" (`8824f8f24f`).
  It reports a deleted bootstrap thread through the V1 `OrchestrationDispatchCommandError`, which
  the fork does not define; the fork launches threads through V2 `launchThread`, which keeps the
  thread and explicitly permits relaunching an empty one, so there is no dead id to recycle.
- Does not carry upstream's startup `reconcileProviderSessions` (`0929907ff9`) or its V1 tool
  lifecycle identity fix (`b2e2ccfdb4`). Both read `ProviderService`/`ProviderSessionDirectory`
  and the V1 activity projection; orchestration V2's `ProviderRuntimeRecoveryService.recover`
  already settles runs orphaned by a restart from the `orchestration-v2.recovery` startup phase.
- Relocates `formatProviderSkillDisplayName` to upstream's
  `@t3tools/client-runtime/providerSkills` and keeps the fork's `formatProviderSkillInstallSource`
  there beside upstream's `resolveProviderSkillSourceKind`; the fork's composer command menu
  labels a skill's install source instead of drawing an icon for it.
- Carries a desktop "automatic updates" preference upstream does not have
  (`autoUpdateEnabled`, `autoInstallPending`, `autoInstallWhenIdle`). Because a queued
  auto-install only waits for the machine to go idle, `checkForUpdates` skips a check while
  `autoInstallPending` is set — upstream's `a354dd9ddc` otherwise re-checks from the `downloaded`
  state and the status change cancels the wait.
- Keeps upstream's `EnvironmentProviderSettings` inline in
  `apps/web/src/components/settings/SettingsPanels.tsx`; the fork carries no
  `ProviderSettingsPanel.tsx`. Upstream changes to that file resolve to the fork: port the behavior
  into `SettingsPanels.tsx` instead of restoring the module.
- Runs the shared settle rules (`packages/client-runtime/src/state/threadSettled.ts`) against the
  fork's orchestration V2 thread shell. Upstream types them on `OrchestrationThreadShell` and reads
  `latestTurn`; the fork uses structural shapes (`QueuedThreadShell`/`SettlementThreadShell`,
  `ThreadActivitySource`) and reads `latestRun`, and tolerates shells that carry no `createdAt`.
  Upstream edits here need translating rather than merging, including their test fixtures. The
  fork's `SidebarThreadRow` also resolves the row's PR after the Woke pill is computed, so
  upstream's `changeRequestAutoSettles` guard on `isWoke` has no fork counterpart.
- Owns SQLite migration numbers 36 and up (orchestration V2, Hermes, scheduled tasks). Upstream
  migrations that claim those numbers must be renumbered or dropped on sync — applying two different
  migrations under one number would corrupt existing fork databases. Upstream's
  `036_ProjectionThreadsPinned`, `037_ProjectionTurnsKeysetIndex`, and
  `038_ProjectionThreadsPinOrderKey` are dropped: they target the retired V1
  `projection_threads`/`projection_turns` tables, and the fork already implements thread pinning
  (and its ordering key) in orchestration V2, whose thread state is a JSON projection rather than
  those columns. Upstream's `039_ProjectionProjectsDefaultThreadEnvMode` targets the project
  aggregate the fork keeps, so it is carried but renumbered to
  `052_ProjectionProjectsDefaultThreadEnvMode`. Upstream's
  `040_ProjectionProjectFaviconPath` likewise targets the project aggregate and is carried as
  `053_ProjectionProjectFaviconPath`. Upstream's `041_AuthSessionClientConnection` targets
  `auth_sessions`, which the fork shares, and is carried as
  `058_AuthSessionClientConnection`. Upstream's `042_ProjectionThreadLinkedPullRequest` and
  `043_ProjectionThreadsUnsettledAt` are dropped: they add columns to the retired V1
  `projection_threads`, and the fork carries linked pull requests and the un-settle re-entry stamp
  on the orchestration V2 thread JSON projection instead (see below).
- Implements upstream's "un-settled threads return to the top of the list" (`3b86ef941c`) on
  orchestration V2. `unsettledAt` is an optional field on `OrchestrationV2AppThread` and
  `OrchestrationV2ThreadShell` (same shape as `pinOrderKey`, so no migration), stamped in
  `orchestration-v2/Orchestrator.ts` rather than upstream's V1 projector: the `thread.unsettle`
  mutation and `dispatchMessage`'s wake-a-settled-thread branch both stamp it, `thread.settle`
  clears it. V2 has no `reason` on the event, so upstream's "reason === user" test becomes V2's
  own distinction — the user path sets `settledOverride: "active"`, the activity path clears the
  override — and the "already pinned active keeps its stamp" rule is expressed against that.
  Upstream's `packages/client-runtime/src/state/threadReducer.ts` half has no fork counterpart:
  it applies V1 thread detail events, and the fork's shells come from the V2 server projection.
  The shared sort anchor (`activeThreadAnchorTimestampMs`) and both client halves are carried.
- Implements upstream's "link pull requests to threads" (`3c75eb1132`) on orchestration V2.
  `ThreadLinkedPullRequest` lives in `contracts/orchestrationV2.ts` rather than upstream's
  `orchestration.ts` (which the fork keeps for the project aggregate only), and `linkedPullRequest`
  rides the fork's single `thread.metadata.update` command onto `OrchestrationV2AppThread` and
  `OrchestrationV2ThreadShell` — the same shape as `pinOrderKey`. Absent leaves the link alone,
  null unlinks. The server keeps advertising the `threadPullRequestLinking` capability, and the
  whole client half (web sidebar, chat markdown context menu, Expo thread list) is carried. Two
  upstream call sites have no fork counterpart: `ChatMarkdown`'s components are built by
  `createChatMarkdownComponents`, so the link/unlink handlers are threaded through its context
  object, and upstream's `openProjectPullRequest` split is dropped because the fork's
  `ChatHeader.tsx` is a presentational breadcrumb with no pull-request menu.
- Carries the Claude "Auto-compact after" setting (upstream `c7222ca4df`) onto orchestration V2:
  `autoCompactWindow` reaches Claude through `ClaudeAdapterV2`'s `makeClaudeQueryOptions`, and the
  shared `/compact` slash command comes with it. The commit's resume-compaction dialog is not
  carried — it is written against the retired V1 `ClaudeAdapter`'s `onUserDialog`/ask-user-question
  path, which `ClaudeAdapterV2` does not have, so `@t3tools/shared/claudeCompaction` (question copy
  shared by that adapter and web) would be dead code. Its `autoCompactThreshold` reporting is
  likewise dropped: `ThreadTokenUsageSnapshot` gains the field for wire compatibility, but the
  fork's `deriveLatestContextWindowSnapshot` reads V2 `compaction` turn items and never sees it.
  `autoCompactWindow` rides the SDK's `settings` bag (the same bag as `alwaysThinkingEnabled` and
  `fastMode`), not the top-level query options: the SDK types it on `Settings` and drops an unknown
  top-level key without complaint, so a misplaced one compiles and does nothing.
- Replaces the Claude 200k/1M "Context Window" model option with an auto-compaction slider, and
  always runs Claude at the model's largest window. Upstream keeps the picker; on this fork it is
  gone. The picker could not work as labelled: Claude Code's model registry marks Fable 5, Opus
  5/4.8/4.7 and Sonnet 5 `context.native_1m`, so the bare model id already carried a 1M window and
  selecting "200k" changed nothing — 496 recorded sessions on a bare `claude-opus-5` all report
  `contextWindow: 1000000`. `resolveClaudeApiModelId` now appends `[1m]` only for the models that
  need the suffix to reach 1M (Opus 4.6, Sonnet 4.6 — the genuinely-200k Opus 4.5 and Haiku 4.5
  have no 1M form and stay bare), and the replay fixtures' outbound frames were re-pinned to
  `claude-sonnet-4-6[1m]` to match. In its place every 1M-capable model carries an
  `autoCompactWindow` select (250K/500K/750K/1M, default 1M) that the composer draws as a slider —
  Claude Code resolves the compaction threshold as `min(model window, autoCompactWindow)`, so a
  stop below 1M is a real cap. The slider composes with the provider-wide "Auto-compact after"
  setting by taking the smaller of the two. Two contract notes: `autoCompactWindow` rides the SDK's
  `settings` bag, not the top-level query options (the SDK drops an unknown top-level key, which is
  how the first port of upstream `c7222ca4df` silently did nothing), and the slider is a `select`
  carrying an optional `presentation: "slider"` hint rather than a third descriptor kind, so the
  SwiftUI and Expo clients keep rendering their radio lists instead of failing to decode.
- Does not carry upstream's V1 `ProviderCommandReactor` interrupt recovery (`17822fab70`). It stops
  the session and writes `thread.session.status = "stopped"` plus a `provider.turn.interrupt.failed`
  activity, none of which orchestration V2 models. V2 covers the same ground its own way:
  `ProviderTurnControlService.load` treats a missing or dead session as already stopped,
  `isNonRetryableProviderTurnControlFailure` succeeds the outbox item on "not active" races,
  `ProviderSessionManager.detach` tolerates a failing `interruptTurn`, and
  `ProviderRuntimeRecoveryService.recover` settles runs orphaned by a dead runtime.
- Does not carry upstream's V1 subagent-model buffering (`6a2608292d`) or its routine-event
  projection skip (`c034f51bb7`). Both edit modules the fork deleted with the V1 thread runtime
  (`provider/Layers/ClaudeAdapter.ts`, the thread half of
  `orchestration/Layers/ProjectionPipeline.ts`); `ClaudeAdapterV2` seeds a subagent's model from the
  parent selection and never refines it from assistant snapshots, so there is no race to fix.
- Ports upstream's "recreate a thread's worktree before starting a turn" (`01fc7d228d`) onto
  `orchestration-v2/ThreadWorktreeService.ts`. Upstream recreates the exact path from the V1
  reactor; the fork's `ensureWorktreeForThread` already runs ahead of every send, so a
  `worktreeExists` probe (injected from `ThreadManagementService`, so the factory keeps returning
  context-free effects) now treats "registry says present, directory is gone" like a removed
  registration and reprovisions at a fresh path after `git worktree prune`. The
  `GitWorkflowService.pruneWorktrees` / `GitVcsDriver.pruneWorktrees` halves are carried as-is, and
  `GitVcsDriverCore`'s existing best-effort prune helper is renamed `pruneWorktreesQuietly` to make
  room for the service method.
- Carries upstream's HEIC composer support (`bd9ed2b4bb`) through the fork's shared attachment
  validator instead of upstream's inline image loop. `apps/web`'s `composerFileDescriptor` reports
  a HEIC/HEIF file as the `image/jpeg` it is converted to, so
  `@t3tools/shared/composerAttachments` (which mobile and the SwiftUI client also read, and which
  rejects `image/heic` on purpose) is left alone, and `composerAttachmentIntake.logic.ts` moves onto
  web's adapter so a pasted iPhone photo is recognised as attachable.
- Carries upstream's macOS PR preview workflow (`c6b8bb8257`) on `macos-15`; the fork has no
  Blacksmith macOS pool.
- Records the connecting client's surface and app version on its auth session and on the
  `client.connected` / `client.thread.started` / `client.turn.requested` analytics events
  (upstream `11f051373`), but does not stamp `metadata.origin` onto persisted events. Upstream
  stamps it in the V1 engine, which the fork keeps only for the project aggregate; orchestration
  V2's domain events carry no metadata bag, and a thread already records its own `createdBy` /
  `creationSource` provenance. The V2 dispatch handler maps `thread.create` and `message.dispatch`
  (and `launchThread`) onto upstream's analytics event names.
- Implements upstream's "submit thread feedback to OpenAI" (`3db38b881`) on orchestration V2.
  Upstream routes `provider.uploadFeedback` through the retired V1 `ProviderService`; the fork adds
  an optional `uploadFeedback` to `ProviderAdapterV2SessionRuntime`, implements it in
  `CodexAdapterV2` against the app-server's `feedback/upload` request, and resolves a thread to its
  live session through a new `orchestration-v2/ThreadFeedbackService.ts` (same shape as
  `RuntimeRequestServiceV2`). The web client carries the whole feature; the Expo client does not —
  upstream's mobile half rewrites `use-thread-composer-state.ts` around V1 thread details, and
  `apps/mobile` is being retired. `codexFeedbackMessage` returns a structural
  `CodexFeedbackMessage` rather than upstream's V1 `OrchestrationMessage`, and the fork's web
  timeline renders the pair through its optimistic-message slot.
- Carries upstream's signed attachment upload path (`e9f50c3ef`) alongside the fork's existing
  `assets.persistChatAttachments` RPC, which the SwiftUI client uses. Upstream claims pending
  uploads into the thread inside the V1 `Normalizer`; the fork claims them in `ws.ts` on the V2
  `dispatchCommand` (`message.dispatch`) and `launchThread` handlers, releasing the claimed copies
  when the dispatch fails. `launchThread` can only claim when the caller named the thread id — a
  server-allocated id has nothing to claim into yet. The upload contract accepts image mime types
  only, so the composer's file/pdf/video attachments still ride the inline base64 path, and the
  fork does not carry upstream's per-chip upload progress UI (it belongs to the composer drawer
  redesign the fork already declined).
- Does not carry upstream's Codex MCP-elicitation approvals end to end (`7c6163c67`). The contract
  widening (`ProviderRequestKind`'s `mcp-elicitation`, `ProviderApprovalDecision`'s `acceptAlways`,
  `ProviderApprovalOption`) lives in the fork's `providerPolicy.ts` rather than upstream's
  `orchestration.ts`, and `CodexSessionRuntime` carries upstream's handler — but that module is
  V1 leftovers the fork's V2 stack does not run, and `CodexAdapterV2` registers no
  `mcpServer/elicitation/request` handler. Codex app-access prompts therefore do not reach the
  fork's clients yet; the approval panels only label the kind. `acceptAlways` collapses to
  `acceptForSession` on the wire, which is the widest grant Codex's command/file-change approval
  responses can carry.
- Keeps the fork's `MarkdownMedia` path for chat markdown images instead of upstream's
  `classifyMarkdownImageSource` renderer (`77c9d1eb5`, `5a7a7cf29`, `55c909334`). The fork's path
  already resolves workspace files through signed asset URLs and additionally handles browser
  artifacts and video, which upstream's image-only renderer does not.
- Does not carry upstream's `useThreadActionMenu`-based "double-click chat header title to rename"
  (`837f6b871`): the fork replaced that module with `useThreadActions.ts` plus inline menu items,
  and its `ChatHeader.tsx` is a presentational breadcrumb with no menu of its own.
- Runs CI as one self-hosted `verify` job, so upstream's test sharding, split Rust job, and
  macOS-gated `apps/mobile` native lint (`d7b9a689f`, `8f7da3b99`) have no fork counterpart. The
  PR-assets guard from `9f12eab38` is carried. `release.yml` adopts upstream's split
  `quality` job (`25dcee00a`) on the fork's runner and its resource-monitor cache, but keeps the
  fork's full `run-install` in the build matrix. Upstream's release parallelization (`a3a8cbd605`)
  is carried without its cron shift — the fork has no `schedule:` trigger — and its move of
  `relay_public_config` / `build_wsl_node_pty` off `preflight` restates the
  `github.repository == 'pingdotgg/t3code'` guard those jobs would otherwise inherit through
  `preflight`, so they stay inert on the fork instead of reaching for production secrets.
- Does not carry upstream's V1 draft-bootstrap retry (`a40aef4ccb`) or the
  `OrchestrationEventStore.hasEventAfter` probe it added. Its only consumer is the V1
  `ProjectionPipeline` deletion-cleanup drain, and the fork's V2 `launchThread` already permits
  relaunching an empty thread, so the method would be dead weight on a shared interface every fake
  event store has to satisfy. The `metadata.origin` half of `2921050c69` is likewise dropped —
  the fork's `ApplicationEventMetadata` carries no origin bag — but its `ClientSurface` widening
  to accept `"cli"` is carried.
- Has no `apps/server/src/server.test.ts`; the fork's server-router seam tests live beside the
  modules they cover, and `apps/server/src/ws.test.ts` holds the `server.getConfig`
  discovery-timeout cases. Upstream additions to `server.test.ts` need rehoming rather than
  merging, and its `Layer.mock(ExternalLauncher)` fixtures have no fork counterpart to update.
- Fetches the provider model manifest (upstream `badae6a5cc`) from **upstream's** `main`
  (`pingdotgg/t3code`), not the fork's. The fork adds no models of its own, so pointing at the
  source of the catalog keeps legacy classification current without a fork release.
- Does not carry upstream's "nest mobile task settings in bottom sheets" restructure of the Expo
  client (upstream `85389b988`: `ExistingThreadSettingsRouteScreen`, `thread-settings-options`,
  `NewTaskContextPickerScreens`, `legacy-plan-mode`, the `ComposerToolbarTrigger` ->
  `ComposerToolbar` rename, and the `@react-navigation/native-stack` /
  `react-native-screens` patches it needs). It rewrites `ThreadComposer.tsx` and
  `NewTaskDraftScreen.tsx` around a composer layout the fork has already diverged from — the fork's
  composer carries voice input, its own attachment menu, and a push-to-talk gesture whose stability
  depends on the pill never swapping view branches mid-hold. `apps/mobile` is being retired in
  favour of `apps/swift-ios`, so the fork keeps its own composer, `thread-settings-menu.ts`, and
  `ThreadSettingsSheet.tsx`. Follow-on upstream work on those files resolves to the fork — upstream
  `89c52a331` (swap `AndroidSheetHeader` for `AndroidScreenHeader` so the sheet's actions clear the
  status bar) is dropped for exactly this reason: it targets that restructure's
  `ThreadSettingsModelsScreen`/`ThreadSettingsChoiceScreen`, which the fork's `Modal`-based sheet
  does not have, and the fork ships no Android target.
- Has frozen the Expo client (`apps/mobile`) against upstream as of the 2026-09-01 sync. It stays on
  Expo SDK 56 and its own theming, and this sync carries none of upstream's mobile work: the SDK 57
  upgrade (`3e6ab36f6e`, with `react-native` 0.86 and the reshuffled `patchedDependencies` set), the
  Uniwind semantic-theme compilation (`018d7f2775`, `generated-uniwind-themes.css`,
  `withUniwind`/`tintColorClassName`, and its `no-mobile-uniwind-theme-escape-hatches` oxlint rule),
  the file/video composer work (`86c9a9288b`, `e3dcc1615c`, `31c1c5996f`), offline voice input
  (`352710d497`), the Expo-glass swap (`9b2d04317c`), and the header/tool-summary fixes on top of
  them. Reason: the fork's Expo client is wired to orchestration V2, so upstream's tree cannot be
  taken wholesale, and its composer/theming shells have diverged far enough that a hunk-level merge
  produced a client that neither typechecked nor linted. `apps/swift-ios` is the fork's mobile
  client and is where mobile parity work belongs; `apps/mobile` is kept building, not evolving.
  Consequence for every sync: changes under `apps/mobile` resolve to the fork unless the maintainers
  decide to revive or delete the client. Shared-package changes still reach it — this sync added
  Grok to `usageProviders` because `UsageProviderKind` gained the kind.
- Carries upstream's mobile built-in themes (`85389b988`'s successor `d23b181da`:
  `lib/mobileTheme.ts`, `@t3tools/shared/themePalettes`, `ThemeAppearanceSection`,
  `ThemedSwitch`, `useMobileNavigationTheme`) ported onto the fork's own composer, sheet, and
  settings shells rather than merged. Consequence: the theme system replaces React Native's
  `useColorScheme` with `useAppearancePreferences().themeAppearance` everywhere, so the fork also
  converted its own sites — `ControlPill`, `InlineUnifiedDiff`, `VoiceComposerControls`,
  `HtmlEmbedView` — and moved its three remaining raw `Switch`es (`ThreadSettingsSheet`,
  `AutomationRow`, `AutomationEditSheet`) onto `ThemedSwitch`, because the theme commit deleted
  `--color-switch-active`. `AppearancePreferencesProvider` now writes `Partial<Preferences>`, which
  exposed that `alwaysExpandActivity` was written but never parsed back; it is now persisted.
  `Stack.tsx` drops its hardcoded `SHEET_BACKGROUND_COLOR` in favour of the navigation theme.
- Implements upstream's "withhold browser access from agents" setting
  (`enableAgentBrowserAccess`) on orchestration V2 rather than upstream's retired V1
  `ProviderService.prepareMcpSession`. Upstream withholds the whole MCP credential; the fork's
  `t3-code` server also carries orchestration and worktree tools that have nothing to do with
  browsing, so `orchestration-v2/ProviderSessionManager.ts` instead drops only the `preview`
  capability from the credential it mints. Every `preview_*` tool already checks that capability,
  and the manager's credential-reuse check treats a capability-set change as a mismatch, so
  toggling the setting rotates the credential on the next session prepare. Known difference from
  upstream: the fork's MCP toolkits are registered process-wide, not per credential, so the
  `preview_*` tools stay in `tools/list` and are denied at call time rather than disappearing.
  Dropping the browser prompt block is what keeps a Codex agent from trying them. The reader is injected
  through `ProviderSessionManagerV2LayerOptions.agentBrowserAccessEnabled` and wired to
  `ServerSettingsService` in `orchestration-v2/runtimeLayer.ts`, keeping the manager's layer
  requirements narrow. The prompt half rides `CodexAdapterV2`'s existing `hasT3Mcp` plumbing as a
  companion `hasBrowserTools`, read off the credential's own capability list.
- Serves one Settings -> Integrations page from `apps/web/src/components/settings/`
  `IntegrationsSettings.tsx` holding both halves: upstream's Browser defaults section
  (`949feb61e`) first, then the fork's OpenRouter credential row and its
  `OpenRouterIntegrationSettings` sub-page. The fork keeps exporting `IntegrationsSettings` (not
  upstream's `IntegrationsSettingsPanel`) because its route and nav entry already point there, and
  the fork already registers `/settings/integrations` in `SettingsSidebarNav`, `settingsSearch`,
  and `routeTree.gen.ts` — upstream's registrations of the same path resolve to the fork to avoid
  duplicate keys.
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
- Gives the SwiftUI client three features upstream only built for web and the Expo client, because
  it is the fork's primary client and upstream has no SwiftUI half to merge:
  - **Linked pull requests.** Web links one from a right-click on a transcript link, which has no
    gesture equivalent over rendered inline text on a phone, so the entry point is Thread Details ->
    Version Control -> "Linked pull request" and the sheet accepts a number or a pasted host URL
    (`ThreadLinkedPullRequestInput`). Only the number travels: `NativeFeatureClient` resolves the
    repository from the project's identity and reads `pullRequests.detail` before pointing the
    thread at it. A linked thread leaves the workspace VCS-status subscription and is polled every
    30s instead (`pollLinkedChangeRequest`), which is what makes settle-on-merge work for a request
    no open worktree points at. Gated on `threadPullRequestLinking`.
  - **Claude's "Auto-compact after".** `Settings -> Agents`, the client's first provider-settings
    screen. Web renders the whole provider tree from the settings schema; almost none of it is
    reachable from a phone, so this carries the one field that is. Read from
    `providers.claudeAgent.autoCompactWindow` on the server-config subscription and written as that
    single leaf so the deep merge leaves Claude's other settings alone.
  - **Un-settle ordering.** Upstream's `activeThreadAnchorTimestampMs` has no SwiftUI half, so
    `DailyUXSidebarIndex.activeAnchor` is the port: the pinned and active shelves sort on the later
    of `createdAt` and `unsettledAt` instead of `createdAt` alone. `FeatureRootModel.setSettled`
    also stamps the field optimistically, mirroring the server's "already pinned active keeps its
    stamp" rule, because the shelves are rebuilt from local state before the shell stream lands and
    a reopen that only hoists on the round trip reads as a dropped tap. Needs no capability flag:
    `unsettledAt` is absent on older servers and nil degrades to the previous creation order.
  - **Connection identity.** `ClientConnectionIdentity` puts `clientSurface`, `clientAppVersion`,
    `clientOs`, `clientOsMajorVersion` and `clientDeviceModel` on the `/ws` upgrade URL, so SwiftUI
    sessions stop being unlabeled rows in Settings -> Connections and anonymous `client.connected`
    events. Deliberate difference from the Expo client: the device model is the raw hardware
    identifier (`iPhone17,2`) rather than `expo-device`'s marketing name, which needs a lookup table
    that goes stale every release.
- Uses the fork's iOS identifiers: `com.t3code.dev`, `com.t3code.dev.widgets`,
  `com.t3code.dev.sharing`, and `group.com.bl4ckbl1zz.t3code.dev`, supplied through the fork's iOS
  build variables. Local development signing uses the APNs sandbox; TestFlight exports use
  production APNs entitlements and dedicated App Store profiles for all three targets.
- Builds and uploads the production iOS app to the fork's App Store Connect/TestFlight app on an
  Apple Silicon macOS runner, driven by `mobile-ios-testflight.yml` (prebuild -> `xcodebuild`
  archive -> export -> upload, with no EAS service). It ships on every push to `main`, on `v*` and
  `fork-v*` tags, and on manual dispatch. An archive takes ~40 minutes, so the `ios-testflight`
  concurrency group cancels a run in flight when a newer merge lands: TestFlight only ever receives
  head of `main`. `mobile-eas-production.yml` stays as a manual-only `eas build --local` fallback:
  upstream's push-to-main EAS auto-release and OTA reconciliation (and its companion
  `mobile-fingerprint-check.yml`) are not carried, because the direct TestFlight pipeline already
  ships every merge and the fork does not consume the upstream Expo project's OTA channel.
  Upstream's label-gated `web-preview.yml` (Vercel hosted-web previews) is likewise not carried —
  the fork has no access to that Vercel project or its secrets. An internal group automatically receives every processed build, and the external group
  exposes a public TestFlight invitation after Apple's initial Beta App Review. The fork does not
  consume the upstream Expo project's OTA updates; TestFlight distributes signed updates to
  opted-in testers.
