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
- Codex file citations and artifact-template cards are now ported to web's stable
  `createChatMarkdownComponents` wrappers, preserving the fork's MarkdownMedia/HTML embed paths.
  Swift parses the two directives inside its existing block/inline render cache, routes cited
  files into the native file viewer, and offers template prompts through the composer. Invalid
  directives remain literal and code blocks are not interpreted as directives.

- Does not carry upstream's provider-settings list/editor split (`e2d4d12a81`, `f276e632c5`,
  `5e63aea2df`) or its `ProviderInstanceCard` `mode: "list" | "editor"` restructure. The fork keeps
  `EnvironmentProviderSettings` inline in `SettingsPanels.tsx` with the card's own expand/collapse.
- Does not carry upstream's pinned-block drag-to-reorder in the web sidebar (the
  `optimisticPinnedOrder` / `handlePinnedDragEnd` block) because the fork keeps its client-local whole-list manual order. The searchable project-filter
  combobox is now ported, including keyboard project settings and query reset on close. Upstream's toggleable unpin
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
- Ports upstream's 50 MB file limit through signed HTTP uploads in web/desktop and Swift.
  PDF/video/file discriminators are preserved in V2 message references. Images retain 10 MB;
  the OpenCode native part limit remains 20 MB (larger files use workspace materialization).
  Native share intake follows 50 MB, and older servers still enforce their advertised limit
  or the 20 MB inline fallback. Inline base64 limits are not widened. Web chips display upload
  progress and retry, preserving the fork's attachment keyboard and local-persistence behavior.
  The frozen Expo picker/share intake explicitly retains its 20 MB inline transport limit.
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
  server-allocated id has nothing to claim into yet. Signed uploads now handle all known attachment kinds, with per-chip progress and retry.
  Pending claims remain at the V2 command boundary; no V1 normalizer is restored.
- Ports Codex MCP app-access approvals (`7c6163c67`) onto `CodexAdapterV2`, with
  provider-labelled choices carried in the V2 JSON turn-item projection and web/Swift composers.
  The live adapter rejects decisions the provider did not offer. Session/permanent grants are
  returned as MCP form content and persistence metadata; unsupported input forms and URL
  elicitations remain declined, matching upstream. This imports only the isolated form helpers,
  never the V1 runtime. Ordinary Codex command/file approvals retain their session-only ceiling.
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
- Requests checkpoint summaries through Git numstat on orchestration V2
  (`c163d502dd`). `orchestration-v2/CheckpointService` asks the shared checkpoint/VCS layer for
  counts rather than constructing full patches, and numstat fails explicitly if its output limit
  is exceeded. Opening a diff still requests the full patch. No V1 runtime or migration is needed.
- Carries unsent-draft markers and discard actions (`f034732244`) in the fork's sidebar row
  variants using its unified attachment drafts. Bulk unpin (`c7bf3115f2`) uses V2 metadata updates
  and the existing per-thread confirmation. Both sidebars share sequential bulk deletion
  (`bd7f7ea093`, `dd64072917`): only successful deletions are excluded from shared-worktree
  ownership, ordinary failures do not abort the batch, and failed/unprocessed threads stay
  selected. Navigation and worktree-cleanup failures are reported separately from a completed
  deletion, including the fork's archived-thread deletion path.
- The 2026-09-10 sync (`e16b8b059c..0f602b3372`, 13 upstream commits) carries seven
  independent changes and retains the following boundaries:
  - Linked-PR search (`f0401c6290`) runs on the existing V2 `linkedPullRequest` in web's
    sidebar and command palette. The shared `threadPullRequestSearchTerms` exposes the PR
    number, repository and URL without host reads. It does not introduce the upstream
    multi-link projection, title snapshots or frozen Expo changes.
  - Image zoom/pan (`8d8189e67d`) uses the fork's `ExpandedImageDialog` gallery, keeping its
    original download handling. Zoom resets on navigation, arrow keys pan while zoomed,
    and modal presence blocks type-to-focus. The standalone image component tolerates SSR.
  - Composer model labels use available width (`b7b3ef1e6f`, web half); touch devices expose
    user-message copy controls (`385cc0a4c6`, assistant controls were already visible).
    PR list diff counts move to the title's trailing edge (`addfb1390e`) within the existing
    row layout; review/check metadata already lives on the second line.
  - Linux/BSD middle-click pastes the terminal's own selection (`d1eeb16247`) through the
    existing paste race/bracketed-paste path. VT mouse reporting keeps priority; the fork's
    modifier-click links, native copy, selection and split-pane activation remain intact.
    Zed remote SSH links (`0f602b3372`) use the shared editor catalog and the fork's Electron
    external-link validator. No new runtime capability or migration is needed.
  - Duplicate-command expansion (`50f918c57a`) is already covered by V2's
    `buildToolCallExpandedBody` / projected-item disclosure; the fork has no
    `commandMatchesVisibleLabel` expansion guard. Android feed positioning (`75e4ceb964`)
    and glass backing (`383cc40f4d`) remain excluded under the Expo freeze.
  - The approved native parity follow-up now supports multiple explicit PR links on V2:
    `thread.metadata.update` adds/removes one link atomically, with a 50-link limit and
    host/repository/number identity. The JSON projection carries `linkedPullRequests` while
    `linkedPullRequest` remains the primary for older clients. Legacy edits preserve other links.
    Swift gates collection editing on `threadPullRequestsV2`, searches every link, and requires
    every linked PR to read as terminal before settling. Link changes restart its observations.
    Web/Expo still render the primary and conservatively avoid automatic settlement for collections.
    Automatic discovery/linking after creation, stack-dismissal tombstones, cached snapshots and
    credential-scoped MCP link tools remain unported. Upstream's `threadPullRequests` flag and V1
    commands stay excluded; `050_ProjectionThreadPullRequests` is dropped, with no new migration.
  - GitHub stack navigation/merge/rebase (`de37964db2`) is now available to Swift through
    `pullRequests.stack` and `pullRequestStackActions`. The standalone GitHub action implementation
    retains reviewed-head checks, per-branch permissions, partial-rebase reporting and remote-only
    operations. Confirmation holds the reviewed stack immutable; mutations invalidate every
    reviewed PR's cached reads even after partial failure. Web stack controls now use the same V2 endpoint. Expo stack controls remain unported.
  - Restart-persistent PR summary/stack reads (`33242d0164`) remain excluded. Stack reads are
    on demand; the earlier V2 background PR-discovery/summary service is still missing. Carry a
    durable read cache with that service, including expiry and mutation/in-flight invalidation.
    Advancing this sync marker records review of deferred work, not full upstream feature support.
  - Swift's existing image galleries now support pinch/pan, double-tap zoom and an accessible
    fit action while retaining original-byte export and current/adjacent-page loading.
- The 2026-09-09 sync (`223ff4490f..e16b8b059c`, 185 upstream commits) manually carries
  independent correctness fixes while retaining the boundaries above:
  - `thread.stop` (`09e8de9c65`) uses web/desktop's existing V2 `interruptThreadTurn` path.
    It has no default binding, appears in Settings, ignores idle threads and key repeats, and
    honors preview/terminal shortcut context. The existing button still permits cancellation
    while a request is pending. No V1 thread command or new server capability is added.
  - Script-ID validation (`d8bc6831cd`) lives in the retained project decider. Newly introduced
    IDs must fit the project-script shortcut grammar; existing legacy IDs remain editable and
    the client declines to construct an invalid shortcut. Event replay (`08463e2c40`) releases
    consumed project-event pages via `Stream.paginate`; V2's application replay is unchanged.
  - Claude metadata calls disable tools, slash commands, MCP configuration, hooks and permission
    prompts (`95834d68aa`, server half of `bc4b006662`), and generate titles outside the checkout.
    JSON/verbose titles (`52b2bf77a9`) retain the fork's model resolver. Shared-settings model
    selection from `bc4b006662` remains with the previously deferred shared-settings stack.
  - The Codex protocol accepts policy/rate-limit errors (`95139254ba`). Its subscription probe
    selects the `codex` quota bucket and rejects model-specific fallback quotas (`1c1d38fcd4`)
    through the fork's `providerUsageLimits`, without restoring V1 quota ingestion/reset credits.
    OpenCode inventory commands run sequentially (`9ab0635db6`); its V1 adapter half is excluded.
  - Provider model bulk toggles (`e16b8b059c`) are in the existing inline models section; remembered
    Fast mode (`dadba6d95d`) uses the fork's option descriptors and draft store. The fork keeps its
    custom-model handling and unified attachment model.
  - Relay notification policy/race fixes (`fdf34c4018`, `3dfc134e6c`, `1862686f9e`) retain the
    fork's attention throttling and APNs credentials; queued jobs use current registration routing.
    Android FCM support is not carried. No deployment configuration or relay migration changes.
- This range leaves the following changes for human-reviewed ports; advancing the sync marker
  does not advertise them as supported:
  - Active-thread ordering (`2d645df474`) is now ported for native iOS through V2 JSON
    `activeOrderKey` metadata and `threadActiveOrderV2`. Upstream migration
    `049_ProjectionThreadsActiveOrderKey`, V1 `thread.active.reorder` and `threadActiveReorder`
    remain excluded. Web's local whole-list arrangement remains independent.
  - Async question dismissal (`7112697e8b`) and question attachments (`7220dfe2c9`,
    `12f5604442`) are now ported through V2 `runtime-request.respond` and native iOS,
    gated by `threadQuestionActionsV2`. Codex async agent-message questions use `responseMode:
"message"`, survive callback-session recovery, and resolve through normal queued message
    admission. Only message-mode questions can be dismissed. Callback answers with files
    retain their native response and queue the files as a follow-up. The V1 client commands and
    async-settlement implementation remain excluded; no SQLite migration is added.
  - Cross-platform capture (`299404a754`), native feedback follow-ups, remote recording transfer,
    text-only/saved preview snapshots (`29c5ecd0ee`, `061543e9e5`, `9e37f0c291`), recording
    encoding (`3941c2a1de`), floating-preview resize and remote media resolution cross the fork's
    desktop/preview protocols and attachment handling. Windows terminal telemetry
    (`ea646c0834`) needs the fork's resource-monitor protocol and service fakes adapted together.
  - Effect rc.112, Alchemy beta.76 and TypeScript 7 upgrades (and their reference trees and native
    Headers patch) require validation of the fork-only V2/Swift-support/tooling consumers. The
    current pinned dependency versions and Electron 43 remain; Electron 44's drag-region fix is
    therefore not applied.
  - New minimap turn navigation, PR merge defaults/videos/link routing, sidebar file drops,
    project-icon propagation, composer focus/multiline/footer transitions, usage account layout,
    and their follow-ups need dedicated adaptation to the fork's timeline, inline settings,
    unified attachments and panel stores. Previously deferred onboarding, shared settings,
    auto-balancing, citations, galleries, reset credits and browser-profile import stay deferred.
    The removed settings section-navigation machinery was never adopted by the fork.
  - Expo-only UI, outbox, drag handles and Android appearance/notification changes stay excluded
    under the freeze. Fork release artwork, marketing, review workflows, public security-policy
    ownership and export-enforcement configuration remain unchanged. The devcontainer fix is
    carried independently with references adjusted to the fork's available contributor docs.
- The 2026-09-06 sync (`5f878d2a85..223ff4490f`) deliberately leaves the following stacks for
  dedicated human-reviewed ports. Advancing the squash-sync marker does not mean these features
  are supported. Do not import their client flags or schemas without implementing the matching
  V2/server behavior and auditing the hand-maintained Swift contracts:
  - Custom model names/option descriptors and imported custom-provider selection
    (`5a433244d0`, `d92dca74eb`) need a V2 provider-option/adapter audit.
  - Shared project defaults and scoped overrides (`9f40b2f563`) need the retained project
    aggregate, fork-owned migration numbers, and Swift settings parity. Connection load balancing
    (`420fd76f60`) needs V2 launch selection and an explicit multi-machine workspace policy.
  - The welcome wizard (`09aac71563`) depends on upstream's V1 importer/provider setup.
    Server-side PR discovery (`223ff4490f`) and actual PR terminal timestamps (`050690d1bc`)
    need a V2 background service and JSON settlement projection. Upstream migration
    `048_ProjectionThreadBranchPullRequest` is not carried; existing client-driven V2 PR
    linking remains available through `threadPullRequestLinking`.
  - Streaming Markdown mounting (`887ece3071`) and recovery (`ce4712d5b0`) cross the fork's
    `MarkdownMedia` and component map. Only the renderer test dependencies from the former and
    static HTML cache correctness from the latter are carried. Its V1 stream/Expo changes are
    excluded; its worker and animation changes remain with their deferred prerequisites.
  - Lazy diff workers and Pierre editor fixes (`b3e1d88590`, `df8e0eb46b`, `6270a6f88b`,
    `2fa5ef4c7b`, `6b87ce3a0b`) need integration with the fork's file/media panels and existing
    dependency patches. Terminal stream cursors, hidden surfaces and keyboard focus
    (`da7e46d08e`, `5eab021a51`, `896fe82f2f`) need joint adaptation to fork replay/selection
    handling. The independent bounded server history and terminal metadata cache are carried.
  - PR hover cards, hydration, project-filter choices and panel precedence (`95103905f5`,
    `91c66ac43d`, `110bbe6b55`, `a0eb23993a`, `931d41f933`, `e5a87e8b9c`) need adaptation
    to the fork's PR data and panel stores. Header project settings, keyboard-accessible project
    actions and navigation motion (`cbe93e8dfb`, `7f8cf30ca4`, `cd713679bb`) likewise need
    the fork's inline menus/sidebar layout. The fork has no upstream proactive-panels controller,
    so its empty-diff and manual-choice follow-ups (`d115a96763`, `bccad27046`) are excluded.
  - Connect HTTP credential refresh and network-blocking diagnosis (`363cde4114`,
    `2dca7a1edd`) need the fork's auth/reconnect lifecycle. Installer ownership and mise shims
    (`2fb99a7a66`, `c7dc3cbd06`, `2271a27dad`) need a Cursor SDK/native-updater audit.
    Resolved executable paths and shell quoting are carried independently.
  - Prompt recall (`fd773172e7`) needs the fork's unified attachments, injected context and
    push-to-talk composer. Unified loading/usage refresh (`f12d39359f`) crosses the retained
    inline settings, timeline and native client. The existing project-scope/settings shell is
    retained instead of upstream's filter persistence, segmented controls and section-tracking
    changes (`1963ca0abe`, `5a2f3ebf6e`, `2e61301b13`, `4d3907f63d`).
  - Public t3.codes marketing redesign/assets (`8e3aa324b5`, `4ee2a9d046`, `010d6bb1b5`,
    `fc1f543d6c`, `b2e15185ae`, `d924fe2664`, `e5d086c262`) are held for human branding
    review rather than changing the fork's release surfaces.
    V1 thread-stream lifecycle and pending-request reconstruction stay excluded. V2 reads request
    entities with `status: "pending"`, so completed historical requests do not reopen; the fork
    already has the working-row opacity and accurate editor-picker label from this range.
- The 2026-09-04 sync (`6d15c5bbc3..5f878d2a85`) leaves several new upstream feature stacks for
  dedicated human-reviewed ports instead of guessing across the fork boundary: Google Antigravity
  (`06336460c9` and follow-ups) needs an orchestration V2 ACP adapter and capability audit;
  subscription reset credits (`1641b4aba5`) and CLIProxy usage sources still need dedicated ports.
  The native parity follow-up ports the read-only part of `19d8ab2ae9` through optional per-instance
  `usageLimits` snapshots: bounded Codex/Claude probes, explicit failures, and Swift account pooling.
  It does not restore V1 ingestion or turn-driven quota events; Limits refreshes the existing
  provider registry and timestamps its reports. No migration is needed. Web and desktop now expose the same reports in Usage → Limits, including
  account deduplication, equal-weight pools separated by window kind, reset ordering,
  aligned account columns, and explicit unavailable/stale reports;
  automatic clean-default-branch pulls (`ba3cb07738`) and customizable
  project icons (`f6c04c552c`) need project-aggregate ports plus fork-owned migration numbers;
  desktop browser-profile import (`134d51096e`, `39449e53e3`, `ff5843410d`, `498ab9c399`) conflicts
  with the fork's desktop/browser shell; and media-preview consolidation (`beae2147a9`, `922bd69225`)
  crosses the frozen Expo client and the fork's existing `MarkdownMedia` path. The range's V1
  projection/settlement/performance work and all `apps/mobile` changes remain excluded under the
  standing rules above. These are intentionally flagged for follow-up, not represented as
  supported server capabilities.
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
- Native iOS additionally carries the approved upstream-parity follow-up: independent persistent
  new-task drafts; durable optimistic task creation with an outbox/retry/cancel list; V2 active
  arrangement; per-question files and async dismissal; provider model visibility bulk controls;
  explicit Fast on/off memory per environment/account; account labels without email addresses;
  quota columns aligned by window; previous/next user-turn navigation over loaded and earlier
  history; and message image galleries that load only the current page and neighbours. Gallery
  exports keep original bytes, and workspace media uses freshly signed URLs on presentation/export.
  These native ports do not unfreeze Expo or adopt the upstream V1 commands. Capability fields,
  JSON projections and hand-maintained Swift models are covered by the generated contract fixture.
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

- Carries upstream diff navigation and appearance controls: a changed-file tree and path copy
  buttons in web review, plus red/green or blue/orange diff roles on web/desktop and native Swift.
  Native stores the preference in FeatureSettings and applies it through T3ThemeStore; semantic
  success/error colors remain independent of the diff palette.
- Web prompt recall is adapted to the fork's unified attachment queue and V2 message projection.
  Up/down only recall when the composer has no attached context and its caret is at the visual
  edge; generated plan/attachment prompts and appended context are excluded. Native already
  implements its own prompt recall.
- Desktop release notes use the upstream focusable popover and bounded newest-first excerpts.
  Omission counts cross IPC as optional fields for older consumers. Links point at the fork's
  release feed, and the fork's automatic download/install state machine remains intact.

- Web/desktop now edit explicit PR collections through V2 `linkPullRequest` /
  `unlinkPullRequest`, including command-palette entry and cross-project links resolved within
  the same environment. A host read validates additions; unlinking uses the saved identity
  without requiring the host or project to remain available. Stack detail controls use the
  native parity RPC and capture immutable reviewed heads before submitting merge/rebase.
  Automatic discovery, source/tombstone metadata and persistent PR caches remain separate ports.

- GitHub PR labels are editable in web/desktop and Swift detail screens. Optional
  host capability and viewer permission flags gate lazy candidate reads and mutations;
  the server checks triage access and invalidates detail/list caches after attempted
  updates, including partial failures. This host API port has no V1 runtime dependency.

- Web PR code review also carries the paged changed-file tree; chat PR links load hover
  details on demand and use atomic V2 collection actions from their context menu.
- Inline video recovery uses the fork's asset URLs and range streaming. Web previews
  preserve an active playhead across URL renewal, prepare a first frame only while idle,
  and provide explicit save/copy actions. Swift offers retry and pauses when backgrounded.

- Custom usage prices are server-authoritative, keyed by exact model ID, with sparse
  per-model replacement/deletion. Usage scans capture price settings and reprice cached
  transcript records, including provider-reported costs. Web supports multi-environment
  edits with per-environment retry; Swift exposes per-environment model-price editing.

- Composer task summaries derive only from the current V2 run's todo list. Web's
  attached banner stack keeps task activity in front and retains urgent fork notices;
  Swift adds an expandable task row beside, outside, the voice composer's gesture tree.
  Approval controls use compact web styling while preserving V2 non-resumable guards.

- Web minimap previous/next-turn navigation uses the V2 timeline row positions.
  Keep the fork’s transform/opacity strip animations and skip unchanged scroll
  attributes; upstream width/background animations would regress scroll performance.

- Environment machine icons use upstream's best-effort hardware detection and nullable
  server setting, with a capability gate for older servers. Web/desktop and Swift show the
  resolved glyph in environment selectors and thread context. Swift has a per-environment
  settings screen; Automatic deletes the override. V2 thread state and migrations are untouched.
