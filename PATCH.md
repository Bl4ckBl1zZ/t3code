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
  sidebar keeps the fork's whole-list drag surface, but persists pinned and active positions
  through V2 metadata on capable servers. Client-local ordering remains only as a legacy
  fallback; see Web durable sidebar order below. Upstream's `animatePinnedLayoutChanges` (which stops dnd-kit replaying the
  committed layout move after the pointer is released) is carried and applied to the fork's
  whole-list `SortableSidebarThreadRow` instead of upstream's pinned-block row.
- Replaces upstream's web thread context menu stack (`threadActionMenu.logic.ts`,
  `useThreadActionMenu.ts`) with the fork's `apps/web/src/hooks/useThreadActions.ts` plus menu
  items built inline in `Sidebar.tsx`. Upstream changes to those retired modules resolve to the
  fork: port the menu feature itself (new items, handlers) into `Sidebar.tsx`/`useThreadActions.ts`
  instead of merging the files.
- Ports upstream's composer attachment surfaces onto V2: notices, task progress/list,
  approval and question drawers, plan follow-up and the stash shoulder tab share the
  existing composer form. The shell and context strip use one surface model and the
  fork's theme tokens. Tasks no longer occupy a notice slot that could obscure another
  notice. Approval actions keep the V2 live/non-resumable response gate. Swift keeps
  native task/approval surfaces outside its push-to-talk gesture hierarchy. Its stash tab
  and list also remain outside that hierarchy; an atomic local queue preserves legacy
  single-slot stashes and swaps unsent content into the queue during restoration.
  Web interim response folding (`17c48f7fc1`) now uses V2 run folds, retaining
  the final response, persistent resources and interruption evidence. Native
  transcript-level interim folding and live-activity focus remain separate ports.
  Ordinary failed tools use a muted circle alert on web and Swift, while typed runtime
  failures retain their severe presentation. Workspace setup feedback remains visible
  until a V2 run starts or fails; draft-route promotion waits for that same evidence.
  Swift distinguishes preparing the workspace from starting the provider. V1 setup
  activities and the continually repainting text shimmer are not imported.
  The fork's unified image/file/pdf/video upload queue replaces upstream's separate
  `files` array; per-attachment progress, retry and video playback are carried through it.
- Sidebar file drops are ported to both web sidebar layouts and search results using the
  fork's unified attachment queue. Deferred drops are scoped by environment and thread,
  survive repeated drops, and are cleared individually on navigation failure or when a
  thread is missing. No V1 thread runtime or separate upstream file array is introduced.
- Codex file citations and artifact-template cards are now ported to web's stable
  `createChatMarkdownComponents` wrappers, preserving the fork's MarkdownMedia/HTML embed paths.
  Swift parses the two directives inside its existing block/inline render cache, routes cited
  files into the native file viewer, and offers template prompts through the composer. Invalid
  directives remain literal and code blocks are not interpreted as directives.

- Selected assistant-text citations are now ported through V2 start and steering paths.
  The durable message retains the origin-independent link; providers receive the decoded
  quote and separately identified user comment. Web uses Lexical chips, bounded source
  navigation and the fork's run/attempt folding (no V1 keyset pagination). Swift uses native
  selection/comment sheets, draft chips outside the voice gesture surface, and its existing
  V2 earlier-turn loader. Its recycled item ID stays distinct from the durable message ID
  used by citations. The optional `assistantCitations` capability gates creation; Expo's
  frozen feed receives only a readable quote/comment compatibility renderer.

- Ports upstream's provider-settings list/editor split onto the fork's existing
  `SettingsPanels.tsx` and `ProviderInstanceCard`, preserving dedicated provider environment
  fields and the Hermes rollout gate. Environment tabs scope reads, writes, additions and
  updates; read-only sessions retain account navigation. Native Agents uses account navigation
  and per-environment model visibility editing. Custom model names and option descriptors are
  ported through the existing V2 providers, including fork-only providers, without adopting
  upstream's V1 Claude catalog. Built-in model IDs and capabilities remain authoritative.
  Web and Swift offer local draft editors, copied options, provider presets and explicit saves;
  the optional `customModelDefinitions` capability gates structured writes to older servers.
  Swift preserves unknown account configuration and other accounts when editing custom models.
  Setup terminals and the remaining native provider configuration controls are separate ports.

- Ports web drag-to-reorder onto the fork's existing sortable rows and V2 metadata instead
  of upstream's `optimisticPinnedOrder` / `handlePinnedDragEnd` implementation. The searchable project-filter
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
  `058_AuthSessionClientConnection`. Upstream’s `047_ProjectionProjectIcon` is carried as
  `059_ProjectionProjectIcon` on the retained project aggregate. Upstream's `042_ProjectionThreadLinkedPullRequest` and
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
- Ports upstream's chat-header title menu and double-click rename (`837f6b871`) through
  `useHeaderThreadActions`, using the fork's V2 `useThreadActions` mutations and capability
  checks. Settlement uses the same cached PR identity and age policy as the sidebar. Rename
  state is scoped to both environment and thread. Compact headers keep project tools in the
  details panel, preserving room for the fork's linked-PR and panel controls.
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
  - Cross-platform capture (`299404a754`) and native feedback follow-ups remain separate ports.
    Remote recording transfer, bounded/text-only snapshots, Electron 43 recording capture and
    floating-preview resize are now carried through the fork preview protocol, as detailed below.
    Windows terminal telemetry
    (`ea646c0834`) needs the fork's resource-monitor protocol and service fakes adapted together.
  - Effect rc.112, Alchemy beta.76 and TypeScript 7 upgrades (and their reference trees and native
    Headers patch) require validation of the fork-only V2/Swift-support/tooling consumers. The
    current pinned dependency versions and Electron 43 remain; Electron 44's drag-region fix is
    therefore not applied.
  - New minimap turn navigation, PR merge defaults/videos/link routing, sidebar file drops,
    composer focus/multiline/footer transitions, usage account layout,
    and their follow-ups need dedicated adaptation to the fork's timeline, inline settings,
    unified attachments and panel stores. Previously deferred shared settings,
    auto-balancing, galleries, reset credits and browser-profile import stay deferred.
    The removed settings section-navigation machinery was never adopted by the fork.
  - Expo-only UI, outbox, drag handles and Android appearance/notification changes stay excluded
    under the freeze. Fork release artwork, marketing, review workflows, public security-policy
    ownership and export-enforcement configuration remain unchanged. The devcontainer fix is
    carried independently with references adjusted to the fork's available contributor docs.
- The 2026-09-06 sync (`5f878d2a85..223ff4490f`) deliberately leaves the following stacks for
  dedicated human-reviewed ports. Advancing the squash-sync marker does not mean these features
  are supported. Do not import their client flags or schemas without implementing the matching
  V2/server behavior and auditing the hand-maintained Swift contracts:
  - Custom model names/option descriptors (`5a433244d0`, `d92dca74eb`) are now ported
    through the fork's existing provider snapshots and V2 option selection, as detailed above.
    Imported custom-provider selection still needs a dedicated importer audit.
  - Shared project defaults and scoped overrides (`9f40b2f563`) are ported through the retained
    project aggregate and Swift settings. Connection load balancing (`420fd76f60`) is ported
    through V2 draft selection and native execution targets; see the policy below.
  - The welcome wizard (`09aac71563`) is now ported onto the V2 importer and account-specific
    setup terminals, as detailed below.
    Server-side PR discovery (`223ff4490f`) and actual PR terminal timestamps (`050690d1bc`)
    need a V2 background service and JSON settlement projection. Upstream migration
    `048_ProjectionThreadBranchPullRequest` is not carried; existing client-driven V2 PR
    linking remains available through `threadPullRequestLinking`.
  - Streaming Markdown mounting (`887ece3071`) and recovery (`ce4712d5b0`) cross the fork's
    `MarkdownMedia` and component map. Only the renderer test dependencies from the former and
    static HTML cache correctness from the latter are carried. Its V1 stream/Expo changes are
    excluded; its worker and animation changes remain with their deferred prerequisites.
  - Lazy diff workers and Pierre editor fixes (`b3e1d88590`, `df8e0eb46b`, `6270a6f88b`,
    `2fa5ef4c7b`, `6b87ce3a0b`) are ported with the fork's file/media panels and existing
    dependency patches. Terminal stream cursors, hidden surfaces and keyboard focus
    (`da7e46d08e`, `5eab021a51`, `896fe82f2f`) need joint adaptation to fork replay/selection
    handling. The independent bounded server history and terminal metadata cache are carried.
  - PR hover cards, hydration, project-filter choices and panel precedence (`95103905f5`,
    `91c66ac43d`, `110bbe6b55`, `a0eb23993a`, `931d41f933`, `e5a87e8b9c`) need adaptation
    to the fork's PR data and panel stores. Header project settings, keyboard-accessible project
    actions (`cbe93e8dfb`, `7f8cf30ca4`) are now adapted to the fork's inline menus; navigation
    motion (`cd713679bb`) is covered by the opt-in panel-motion port below. The later V2 proactive-panels port supersedes
    the earlier deferral of empty-diff/manual-choice follow-ups (`d115a96763`, `bccad27046`).
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
  project icons (`f6c04c552c`) are carried on the project aggregate as described below;
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
  V2 background discovery, source/snapshot metadata, stack tombstones and MCP linking are now
  ported, as described in the V2 PR tracking entry below.

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

- Terminal replay uses upstream's bounded chunk buffer and per-attach cursors in
  client-runtime/web; Swift carries local byte cursors through its existing capped
  buffer. Repeated output and history rollover append without resetting live VT state.
  Hidden web surfaces continue parsing/replying but stop canvas work and cursor timers.
  Preserve the fork's narrow-pane font fitting, middle-click selection, and V2 terminal
  routing. Expo materializes text only at its existing native-surface boundary.

- Web pull-request list controls are remembered independently from the selected review.
  Merge-readiness sorting preserves involvement groups; duplicate repository checkouts
  collapse only within one environment. Review-tab identity includes the host when known,
  while the server still resolves reads through the selected project's repository identity.

- Native composers accept file representations dropped from other apps through the existing
  attachment processors and upload queue. Preparation reserves attachment slots, reads temporary
  provider files before their callback expires, and discards results after composer navigation.
  This does not yet add drop-to-open behavior to native sidebar rows.

- Ports upstream panel user-choice revisions (`bccad27046`) while retaining the fork’s
  independent thread-details visibility. V2 automatic plan panels respect choices made during
  their run; resource reconciliation never counts as a manual choice. The proactive panel API
  gives linked PRs precedence over automatic plan/diff panels. V2 linked-PR and completed-run
  diff opening are now integrated behind `proactivePanelsEnabled`; background PR discovery
  now runs on V2 and keeps its branch candidate separate from explicit links.

- Ports lazy diff workers (`b3e1d88590`, readiness follow-up `ce4712d5b0`) at code-view
  boundaries instead of wrapping the entire chat. Concurrent views share a pool, quick reopen
  retains its cache, and the last closed pool expires after 30 seconds. File reveals retain the
  fork’s mount-aware callbacks. All highlighter creation paths use upstream’s Oniguruma WASM
  preference (`feb3ea7ebf`) to avoid JavaScript-regex backtracking freezes.

- Ports clickable file breadcrumbs (`47a95332a2`) onto the fork’s scoped project-file queries.
  Folder menus refresh when opened, since V1 workspace-mutation notifications are not carried.
  Swift file previews offer a containing-folder menu using their existing native directory
  navigation, including the workspace root.

- Swift now folds completed-run interim responses and work behind a stable duration row,
  retaining terminal replies, attachment-bearing messages, lifecycle cards and live work.
  Expansion changes recycled collection rows instead of mounting a whole run in one cell,
  preserves the viewport anchor, and source-citation navigation expands the owning run first.
  Failed/interrupted/unknown runs remain fully visible; the always-expand preference wins.

- Custom project icons (`f6c04c552c`) and automatic colored defaults (`4e89d74436`) are
  carried through the retained project aggregate, its events/read models, and fork migration
  `059_ProjectionProjectIcon`. `projectIcons` advertises support; omitted update fields preserve
  the icon, explicit null clears it, and selecting a file clears the custom override. Web settings
  apply edits across every member of the selected project group only when all hosts support them.
  The native project-filter menu exposes the same searchable Lucide catalogue, emoji picker,
  colors and reset. Native rows use the full canonical project title and preserve cross-environment
  identity. Lucide vectors are converted at development time to cached native paths; no per-row
  SVG web view is used. Regenerate with `scripts/generate-swift-project-icons.mjs` after changing
  the pinned web Lucide version; see the contributor notes for its Python prerequisite.

- Returning to a desktop-sized browser or Electron window refocuses the composer (`ecf3716fd1`)
  after native focus restoration settles. Text fields, terminals, dialogs and popup controls retain
  deliberate focus; mobile viewports do not raise the software keyboard. The effect is keyed by
  the fork’s environment/thread identity and cleans up pending animation frames on navigation.

- The native Code sidebar now opens a cross-environment pull-request workspace using existing
  `pullRequests.list`/`listStats` contracts. It persists filters/sort, assigns shared repositories
  to one environment, distinguishes hosts, paginates with opaque cursors, and fetches authored and
  review-requested partitions independently. Four concurrent listing requests bound fan-out;
  diff counts enrich visible results without treating an unavailable count as zero. Stale responses
  cannot replace a newer search. Native detail, label and stack screens accept project context
  without creating a thread, and reject a project whose repository changed since the list was read.
  Responsive label pills, update times and diff palette roles use native theme tokens. Native PR
  checkout actions remain separate parity work.

- Native PR details expose a capability-gated Code tab from both thread links and the global
  workspace. Host-backed slices retain opaque cursors, per-commit scope, reported omitted-file
  counts and partial-read errors. A native collapsible file tree, path filter/copy and lazy line
  diff use the fork’s diff color tokens. The shared unified-patch parser now decodes Git C-quoted
  paths and distinguishes file metadata from code beginning with `---`/`+++`. Local working-tree
  hydration and agent-prompt comments are not used for host PR code. Full-file context uses the host-backed comparison described below.

- Native PR reviews use `pullRequests.submitReview` with private persisted summary/line drafts.
  Offered verdicts intersect host capabilities with viewer permissions; line comments are available
  only against the whole PR, never a commit-specific diff. Added/deleted/context coordinates and
  renamed paths follow the contracts. Submission clears only the exact snapshot acknowledged by
  the host, preserving failed drafts and concurrent edits. These are host reviews, separate from
  working-tree comments sent to the coding agent. Existing review conversations support paginated replies and reversible resolution.

- Native host review conversations are shown in Timeline and on matching Code lines. Placement
  requires the same file, side and line in the whole-PR diff; outdated, withheld and commit-scoped
  conversations stay separate. Replies and resolution intersect host/viewer permissions and
  revalidate repository identity. Failed replies retain their text; refreshing merges loaded comment
  pages and preserves other unsent replies. Repeated cursors stop rather than looping.

- Native PR full-file context calls `pullRequests.diffFileContents` with the selected commit and
  rename sides after repository-identity validation. Expanded contents must match the visible hunk
  coordinates before they are joined; a changed revision asks for refresh. Files without supplied
  hunks show labelled old/new snapshots instead of fabricated unchanged lines. Added context does
  not acquire review targets that were absent from the original patch. No local checkout reads.

- Native PR management offers merge, ready/draft, close/reopen, branch update and auto-merge only
  where host capabilities and viewer permissions agree. Merge methods are narrowed by repository
  settings, including reviewed stack merges; branch-update methods also intersect viewer access.
  Conflicts, base freshness and auto-merge state are visible. Unknown auto-merge state is not treated
  as off. Merge/close/update/auto-merge use concrete review sheets; reverse actions remain reachable.
  Explicit workspace/detail/Code refreshes invalidate the appropriate server cache, while normal
  browsing retains cache sharing. Identity preflight invalidates before reading current host metadata.

- Native PR title/description editing follows upstream host/ownership rules; each save sends only
  the opened field, and an empty description explicitly clears it. Comment editing requires the
  viewer’s own issue/review remark and never rewrites a review summary. Timeline and paginated
  review-conversation comments share the editor; loaded-page edits survive the subsequent refresh.
  New top-level comments use the host comment endpoint. Failed saves keep editor text and show the
  error, and every write validates current repository identity before submission.

- Native reaction pills cover PR descriptions, timeline remarks and review-conversation comments.
  Eight host reaction types have a native picker, selected state, counts and accessible actor names.
  Optimistic changes are scoped per reaction; failures restore the preceding acknowledged state,
  and in-flight presses cannot race the same reaction. Description requests omit `subjectId`;
  comment requests carry the host ID. Mutation availability follows the host reaction capability.

- Native reviewer management lazily reads host candidates, searches their displayed login/name,
  renders avatars/team identity and distinguishes user/team rows even when their opaque IDs match.
  Requests and withdrawals send the host ID and kind unchanged; failures keep the previous state,
  and a failed candidate refresh retains the acknowledged request. Truncated lists explicitly limit
  search to loaded candidates. Host/viewer permissions gate mutations; hosts without candidate
  listing direct reviewer management to the host. Editors and method pickers lock during writes.

- Native PR checkout and agent handoff use the existing host Git operation and V2 thread metadata.
  The thread is created before worktree preparation so setup scripts have an owner; failed
  preparation/attachment keeps an empty recoverable thread and never stages or sends an agent task.
  Ask/Explain avoid checkout, existing-thread tasks preserve the live composer, and stale reused
  worktrees retain their changes with an explicit warning. No V1 launch path is imported.

- Live tool focus is derived from V2 run ownership and projected item status on web and Swift.
  Running foreground work wins over concurrent completions; the last success remains between
  messages. Background processes keep separate visible rows, and failures/compaction cannot claim
  the live focus. Native running rows remain visible before a result arrives.

- Composer loading polish reads the V2 shell/projection, rather than V1 sessions or activities.
  Provider discovery carries the optional `reportsContextWindow` presentation hint (Codex/Claude
  true; unspecified drivers remain unknown). A started thread reserves its meter while loading,
  and session-local Git identity prevents non-repository branch-strip flashes. Multiline browser
  drafts stay expanded; the collapsed editor remains inert but measurable for restored wrapping.

- Opt-in proactive panels (`fb93902ee2`, `8588d7f63b`) observe V2 run completion and checkpoint
  summaries, never V1 turns. They defer until checkpoint/Git state is definitive, ignore empty,
  failed and stale diffs, retain the user's revision across loading, and refresh the revision once
  per new run. A selected linked PR can follow its replacement, but unrelated/manual selections
  win. The setting is searchable, resettable, off by default and restricted to inline desktop
  panels; native/compact clients keep explicit navigation rather than opening modal sheets.

### Native provider account configuration

The native Agents settings support add/edit/disable/remove for provider accounts,
including server connection fields, account colors and redacted environment credentials.
`generate-swift-provider-settings.ts` generates the native form catalogue from the same
pure field annotations and driver definitions as web; CI checks freshness. Native writes
re-read server settings, preserve unknown fields and other accounts, and reject conflicts
in edited fields. Built-in account IDs remain stable. The custom-model-definition capability
conservatively gates this editor on older paired servers, matching the native provider-map
write boundary. No V1 runtime behavior is introduced.

### V2 historical tool-group summaries

Web and native Swift summarize successful completed tool groups with V2 item types,
unique edited-file counts and bounded expanded histories. Single tools keep their own
labels; failed/declined calls form separate groups, and live work, compaction and persistent
resource cards stay visible. This ports upstream completed-group presentation without
V1 work-log ingestion or subagent observability. Full upstream integration-specific group
labels remain separate work; bounded history persistence is described below.

### Native targeted PR handoffs

Native comments/checks and selected diff ranges can be handed to the existing V2
agent-thread preparation flow. Selected findings do not pull in unrelated review items;
original side/line, outdated/resolved state and optional revision remain explicit, and
bounded excerpts disclose truncation. Tasks stay unsent and preserve existing composer
text and attachments. Native checkout-command copy uses the reported source-control
provider, with no host guessing. Structured review-context chips now preserve these findings
through draft, stash, send, and transcript rendering; see Native PR review context below.

### Native citation source highlighting

Native source navigation resolves the shared normalized UTF-16 quote selector back to
rendered text and briefly marks the exact inline/code ranges without mutating cached
Markdown documents. List/table separators match native citation capture. Ambiguous
repeated text is never guessed; unique text can recover after offsets shift. Highlights
expire after three seconds without continuous animation and remain scoped to the source
message and transcript coordinator.

### Web durable sidebar order

Web carries `activeOrderKey` through its V2 shell projection and writes pinned/active positions
with `thread.metadata.update`, using existing `threadPinReorder`/`threadActiveOrderV2` capabilities.
The shared base-26 order preserves Swift's keyless-active-first and keyed-pin-first behavior;
first-time materialization supports large histories and reserves hidden thread keys. Optimistic
keys remain until projection acknowledgement, with concurrent-change/failure release. Resetting
an active position sends null without changing lifecycle state. Legacy keyless servers retain
local ordering; mixed durable/legacy sections require upgrading before a reorder. Pin entry
points share the existing top-of-pinned-run placement. No V1 reorder command or migration is used.

### Tool-history reading state

Web retains per-group/per-entry expansion and measured row-plus-offset anchors outside
virtualized rows, scoped to a conversation and bounded to 1,000 entries. Only appended calls
follow an already-visible end; status/output replacements do not re-arm following. Native
transcript coordinators own a bounded observable history cache and restore a stable tool-row
anchor with SwiftUI scroll targets, preserving expansion across recycled cells. Native
intra-row text offsets are not yet restored. This uses V2 item IDs, not the retired V1 work log.

### Native sidebar file drops

Native Home's UIKit collection accepts external file drops into thread rows across Code,
Work, Chat and search, opens the scoped thread, and queues providers until draft restoration.
The composer acknowledges each prepared file only after appending it; cancellation retains
unconsumed providers for that destination, while late callbacks cannot skip files. Existing
text/attachments and signed upload behavior are preserved. Eight-file batches, at most eight
pending destinations, file-size validation and visible overflow/errors bound the handoff.
Archived rows, links and selection mode reject drops. Queue state is session-local; received
attachments use the existing persisted composer draft. No provider or V1 runtime changes.

### Native PR review-context chips

Native PR identity, selected code and inline findings use the existing web `review_comment`
message format. Draft/stash/send keep the original readable blocks; the composer separates them
from editable prompt text into inspect/edit/remove chips, and sent messages render context cards.
Ask leaves an empty question field. Original diff sides, revision, outdated status and excerpt
bounds are preserved; fileless findings/checks stay in general context. Bounded parsing leaves
malformed blocks visible, escaping reserved host tags prevents nested forged chips, and longer
backtick fences preserve code. Swift↔web serialization was exercised in both directions. No new
server capability, schema or V1 runtime is required.

### Desktop resting composer

Deliberate wheel and timeline keyboard reading gestures compact eligible single-line composers.
The Lexical editor stays mounted; model/mode controls move into the existing context strip,
attachment/voice/send controls stay reachable, and measured footer width reserves editor space.
The expanded timeline inset is retained to avoid covering the last message on reopening.
Explicit editing, logical-end arrival, voice, requests/errors and thread changes restore the
expanded layout; trackpad momentum cannot immediately undo explicit expansion. The shared
`composerCollapseOnScroll` preference defaults on and is exposed in desktop General settings.
Native voice gestures and mobile layouts are unchanged. Upstream's full geometry animation
is not yet ported; the layout change currently has no motion interpolation.

### PR reads across restarts

Upstream `33242d0164` persistence is adapted to the fork's PR detail and stack APIs rather
than its V1-linked summary reader. Details retain their 15-second freshness limit and stacks
expire after 60 seconds, measured from the original host read across restarts. Keys include
operation, provider, host, repository, project and workspace identity; persisted filenames
are hashes. Schema validation, corrupt-file fallback, failed-read exclusion and unavailable
storage fallback keep the host authoritative. Refreshes and mutations clear persisted entries;
partial failed writes invalidate memory epochs too. Clearing waits for in-flight readers,
and a failed clear disables persistence for the process. No migration or V1 service is used.

### Opt-in web panel motion

Ports upstream `91c8d4771c`/`cd713679bb` panel duration (0–400ms, default zero), appearance
preview/reset/search, reduced-motion suppression and first-painted-route restoration. Retained
closing content is scoped to the thread or PR workspace and becomes inert immediately; terminal
visibility still stops painting when closed. The fork's resizable shell and V2 plan/agent panels
are retained, rather than importing upstream V1 panel data. Sidebar, terminal drawer, right
panel, sheet, header/footer breakpoint fades and PR workspace use the shared setting. Resize
and maximize changes suppress width transitions. This is a web/desktop layout preference;
native Swift keeps its own platform transitions and push-to-talk gesture tree.

### Welcome setup and CLI history import (2026-09-10 parity port)

Web/desktop now offer the reviewed upstream three-step welcome wizard, available again in
Settings. Fresh-workspace detection uses explicit startup provenance and waits for durable
client settings and live V2 shells; an existing workspace is never inferred to be fresh from
its folder name alone. Failed settings reads and completion writes remain retryable.
Swift has a native Computers / Agents / Projects setup flow after first pairing and in Settings,
using its existing navigation shell and terminal renderer. Neither client runs install/login
commands until the user presses Enter. Terminals resolve the selected provider account's
current environment and home on the server, including secret-backed values and Codex shadow
homes. Each wizard terminal owns and cleans up only its unique terminal ID.

The bounded upstream Codex/Claude transcript scanner is carried with project lookup adapted
to the retained project aggregate. History import is implemented directly with V2 events and
provider native references, without starting a provider or importing V1 runtime services.
Imported conversations begin settled and resume through V2. A native session already owned
by another thread/project/account is never reassigned. Retries and copied transcript files
reuse the original conversation rather than overwrite history the user has continued.
Fork migration **060** stores only import ownership and source fingerprints; conversation
state remains the V2 JSON projection. Import receipts, events and fingerprints commit atomically.
The migration-journal reconciliation marker is registered alongside this fork-owned number.

`agentSessionImport` and `providerTerminalEnvironment` advertise these implementations;
clients gate the new operations against older servers. Swift decodes real schema-generated
fixtures for scan results, import counts and capability flags. Expo remains on its existing
onboarding UI and can decode the additive contracts; its V1 importer is not introduced.

### Markdown image gallery (2026-09-10 parity port)

The upstream lazy, document-ordered Markdown gallery is adapted to the fork's `MarkdownMedia`
renderer and existing zoom dialog. PR descriptions share a gallery across their Markdown/media
segments. Linked badges remain links; remote image links open their full-size target. Weak DOM
keys release signed URLs when images unmount. Repeated images retain the clicked occurrence,
and navigation wraps correctly after any number of backward steps. The native Markdown
renderer already supplies a paged gallery with adjacent-page loading and needs no duplicate UI.

### File and document previews (2026-09-10 parity port)

The reviewed upstream file-preview behavior is integrated with the fork's file surfaces and
unified image/pdf/video/file attachments. Web/desktop show PDF/HTML attachments in distinct
ID-keyed tabs, even without an active workspace, and render workspace videos, PDF/HTML pages
and source toggles. Absolute host paths are read-only. Markdown images resolve relative to
the file's directory. Native iOS gains video/document file previews, HTML/source switching,
a document-attachment sheet, load/retry states, and signed-URL renewal, using its existing
navigation shell and video renderer. Native file previews refresh explicitly with Reload.

Host-media access uses an exact, canonical file capability bound to device/inode and an open
descriptor. Renaming/replacing a path cannot change an in-flight full or ranged response;
atomic replacements require a fresh URL. Existing workspace sibling-asset capabilities,
V2 purged-worktree checks and the fork's browser-artifact route remain. Explicit absolute
text-file reads are bounded to 1 MiB and never enable out-of-workspace writes. Inline document
attachments require a stored PDF/HTML extension; a supplied MIME type cannot make an archive
render as HTML. Served HTML receives an opaque-origin sandbox policy.

`fileDocumentPreviews` gates the new host/document operations and is mirrored in Swift with
schema-generated wire fixtures. V2 completed file-change/command items drive web refreshes,
including failed commands and out-of-order completions. Local pending saves defer refreshes;
no V1 activity import or observer is used. Existing native media galleries are retained.

## Automatic project pulls

Upstream clean-default-branch pulling is ported through the fork's VCS broadcaster
and ProjectService, with no V1 thread query or migration. Server settings carry an
off-by-default machine preference and sparse project overrides; null removes one
override without replacing others. The fork’s project aggregate supplies the policy.
Canonical-workspace locks serialize refreshes and pulls, and existing fast-forward-only
Git operations preserve local commits. Web/desktop and Swift expose defaults plus
on/off/inherit, guarded by `projectAutoPull` on older servers. Upstream's turn-end
PR refresh and discovery remain separate ports. Startup refreshes enabled projects
once after managed-update activation and before the V2 effect worker drains recovered
provider work; no checkout mutation runs in an uncommitted update trial.

## Project browser access overrides

Upstream project-scoped agent browser access resolves through V2 thread shells and
fresh server settings. Missing project identity or unreadable settings cannot bypass
an override. The session manager receives a thread-scoped policy and retains its MCP
credential reuse/rotation checks; only preview access changes. No V1 ProviderService
or snapshot query is imported. Sparse null patches restore inheritance. Web/desktop
project settings and Swift Project defaults expose on/off/inherit, guarded by
`projectBrowserAccess`; the machine-wide preference is preserved.

## Machine-scoped project defaults

Server settings carry a nullable default model selection, replaced atomically so
options from a previous model cannot leak into a new selection. The `projectDefaults`
capability gates machine-scoped editing on web/desktop and Swift. New threads resolve
explicit choices, project defaults, then the destination machine's default; legacy
servers retain their existing fallback. Existing draft reuse and navigation-race
guards remain fork-owned. Settings → Projects supports project and machine scope,
with grouped settings rows; project model fan-out checks target catalog availability.
Shared action defaults are a separate port and are not advertised by this capability.

## Shared project action defaults

Machine actions and sparse project action overrides resolve through the shared
project-script helper. Missing overrides preserve nonempty legacy/t3.json actions;
null explicitly inherits machine actions; an empty array disables them. Writes replace
one array instead of merging removed entries. V2 launch, MCP worktree creation and
Git PR preparation share the standalone setup runner; fork teardown resolves the
same settings through ProjectService. No V1 thread query or migration is introduced.
Web/desktop settings and action controls, and native action editing/execution lists,
use the effective actions behind `projectActionDefaults`. Inherited actions are never
written to t3.json. Native preserves teardown and single-run wire flags; its existing
terminal runner still does not provide desktop single-run toggle semantics.

## Provider picker setup paths

Web/desktop picker and banner setup links preserve target environment/account IDs
through provider settings. Account setup reuses the reviewed Codex/Claude terminal
flow and `providerTerminalEnvironment`; it pretypes without submitting and owns
cleanup/retry. Swift model pickers and account settings push a machine-scoped setup
screen using the same native terminal protocol, preserving the composer voice
gesture surface. Small picker controls and floating-layer event scope match upstream.
Antigravity setup is not advertised until its V2 adapter exists.

## Remote model catalogs on V2

The provider manifest now carries model presentation, aliases, new badges, defaults,
CLI compatibility gates, and allowlisted Claude runtime profiles. Invalid references
or adapter metadata retain the last good catalog; an older disk manifest cannot hide
newer bundled models. Claude discovery, V2 turns, and structured text generation read
that same cached source. Each turn keeps its compiled prompt options through steering.
Custom model aliases stay opaque and use their own descriptors.

The fork deliberately transforms upstream's Claude `contextWindow` descriptor into
its real `autoCompactWindow` slider. Models run at their largest supported window;
known natively-1M models retain bare identifiers, while suffix-based profiles select
the largest window. Provider-level and thread-level compaction ceilings still compose
in the V2 SDK settings. This preserves the existing working Context control instead
of restoring upstream's ineffective 200k selector on natively-1M models. No V1 runtime
or migration is introduced. Web/desktop and Swift render manifest-driven New badges;
the frozen Expo client accepts the additive contract fields.

## Explicit draft model choices

Web/desktop draft persistence distinguishes a human model/trait choice from a
project, machine, or sticky seed. Reopening an empty draft refreshes seeds without
replacing explicit picks, including picks made while workspace defaults load.
Moving typed draft content between projects carries an explicit model choice.
The browser storage migration removes only model seeds on empty local draft
sessions; invested drafts, real threads, and instance-scoped sticky preferences
remain intact. V2 persisted thread selections still outrank browser composer state.
Swift already records `selectionIsExplicit` and persists only explicit draft model
choices, so this port aligns web behavior without changing its native composer.

## Settings availability and navigation

The grouped settings shell now uses upstream's tighter page spacing, explicit
scroll targets, optional destination highlighting, and a common unavailable-group
presentation. Primary-server controls are inert with a keyboard-reachable explanation
on hosted clients that have no primary. Attempted primary-only writes report that
nothing was saved. The fork's machine-targeted settings continue to write to their
explicit environment; no arbitrary remote becomes the primary fallback. The same
rule covers fork-owned worktree-retention controls. Legacy auto-settlement preferences remain client-local for old servers; capable V2 servers own
their environment settings and persisted automatic decisions.

### Image header metadata (2026-09-11 parity port)

Signed asset responses include optional PNG/GIF/WebP/JPEG dimensions from at most 256 KiB
of header data. Host-file dimensions use the same identity-checked descriptor as URL minting;
malformed, unreadable or unsupported headers omit metadata without breaking previews. The fork's
MarkdownMedia renderer reserves the natural aspect ratio within its existing height cap, with
authored HTML dimensions taking precedence. Host-file previews are capability-gated. Swift
mirrors the optional contract and keeps its fixed transcript media frame to avoid collection-view
remeasurement. No V1 runtime or database migration is involved.

### Live subscription limits through V2 (2026-09-11 parity port)

Codex account/rateLimits/updated and Claude rate_limit_event now feed instance-owned provider
snapshots directly from V2 adapters. Sparse updates preserve other windows and reset metadata;
unchanged notifications do not broadcast. Claude scoped events reuse the first model bucket
reported by that account's probe, never a guessed model name. Cached Claude probes retain their
original sample timestamp. Failed or older probes do not erase newer live bars; unsupported
accounts remain unsupported. This uses the existing provider snapshot contract on web/desktop,
Expo and Swift, with no V1 provider bridge or migration.

### Native tool-history reading offset (2026-09-11 parity port)

Swift retains an offset within the first visible tool row in its bounded, thread/group-scoped
history cache. Restoring a recycled or reopened group first materializes the lazy row, then uses
its measured frame to restore the reading position; changed row heights clamp safely. A passive
iOS 17-compatible observer reads only the inner scroll view and leaves SwiftUI's delegate intact.
User dragging cancels pending restoration. Measurements are transient and do not invalidate the
whole transcript on every scroll. No simulator or browser was launched for verification.

- T3 MCP activity intent labels, PR/browser icons and completed-group summaries are ported
  onto projected V2 items on web and native Swift. Labels follow item status, including
  failure/cancellation, and recognize provider namespace aliases. The shared URL parser
  supports GitHub, GitLab, Bitbucket and Azure change-request routes; Swift mirrors those
  rules for tool labels. This presentation does not advertise new PR MCP capabilities.

- Codex browser/computer tool-source metadata is normalized at the V2 adapter boundary
  into independent `toolActivity` contracts and optional V2 item fields. It survives JSON
  projection persistence and reaches web/Swift icons and source-aware group summaries.
  V1 item-lifecycle events are not reintroduced. Native app references resolve through
  signed asset URLs and a bounded macOS icon cache; clients never receive application
  bundle paths. Other host platforms retain glyph fallbacks, as upstream does. Swift
  decodes older items without metadata and scopes native-icon requests by environment.

### V2 pull-request discovery and persisted link snapshots

Upstream PR discovery/snapshot workers and MCP linking are ported to V2 metadata commands,
not the retired V1 decider or `projection_threads`. `pullRequests` stores host-level identity,
source, snapshots, native stacks and dismissal tombstones; legacy fields stay derived and
preserve Azure selectors. Atomic link-version/anchor and branch/worktree guards reject stale
reads. Background-only updates do not create activity. The fork keeps explicit links authoritative.

Workers start after recovery, share branch/status caches and host-error backoff, and use the
fork's persistent read cache for cheap summaries and separate lightweight/hydrated stack reads.
MCP PR tools are credential-thread-scoped. Web linked badges and the web/Swift collection views
use cached snapshots and ordered chains, with source/check/diff signals. Native fixtures mirror
the optional wire fields. Full cross-repository detail routing remains follow-up parity work; no V1 thread imports or new migrations are introduced.

### PR indicator parity

Saved V2 branch candidates feed web sidebar/chat/command-palette status and native thread details
and sidebar observations without becoming explicit links. Native explicit links use pushed V2
snapshots; legacy and branch-only references retain scoped host reads. Web draft/closed/merged
icons share the detail presentation, and cached draft changes invalidate row snapshots.

PR stack counts now use the fork’s web collection popover from sidebar/header controls and
native sidebar chain presentation. Native draft metadata survives both VCS/detail and pushed
V2 snapshot mappings. The upstream standalone hydrated collection panel remains unported.

### Automatic settlement on V2 (2026-09-11 parity port)

Upstream server-side settlement is implemented with V2 shell state and serialized dispatch, not
V1 deciders/projectors. The worker evaluates persisted PR snapshots and inactivity before host
lookups, preserves activity timestamps and pins, and rejects stale decisions using the thread event
sequence. Runs, blocking requests, queued messages, V2 background work, snoozes and explicit active
state govern eligibility. Actual merge/close timestamps prevent re-settling resumed work.

Environment preferences and `threadAutoSettlement` keep web, Expo compatibility and Swift on the
same persisted classification. Legacy servers keep device-local rules. Native Thread organization
settings expose machine selection, merge opt-out and nullable inactivity periods. Pending request
summaries now distinguish message-mode questions; blocking requests win summary selection. No
SQLite migration or retired V1 runtime import is needed. Confirmed host merges immediately
request linked snapshot refresh and invalidate matching checkout caches before settlement. Queued
merges remain open, and host timestamps are preserved. Cross-machine shared preference propagation
remains separate parity work; periodic sweeps run each minute.

### Created PR links on V2 (2026-09-11 parity port)

Git stacked-action thread attribution is carried from web, Expo compatibility and Swift. The
upstream created-link hook is implemented through V2 metadata, with originating-checkout and
serialized context guards; it does not import V1 snapshot queries or thread dispatch. PR URLs
identify fork-target repositories, with a validated configured-host fallback for self-hosted GitHub.
Existing links retain their source and failures preserve the successful Git result. No migration
is required. Full hosted-reference detail routing remains separate parity work.

### Codex resume metadata on V2 (2026-09-11 parity port)

The metadata-only resume fix from upstream `1abc717f0d` is carried in `CodexAdapterV2`.
Resume requests exclude historical turns and validate only the native thread identity and optional
update timestamp used by V2. Unknown historical error enums cannot prevent a valid resume; malformed
identity metadata remains an error and never starts a fresh thread silently. Automatic restart
continuation itself remains separate work.

### Opt-in restart continuation on V2 (2026-09-11 parity port)

The restart preference and lifecycle intent from `5b7d72aad1`, `b906ce2d73` and `1abc717f0d` are
ported to V2 persisted run markers and serialized continuation commands. V1 provider directories,
adapters and projectors are not carried. Current native provider references and the latest V2 run
own recovery; duplicates, completed/archived/settled work, newer messages and changed contexts do
not resume. Explicit stop/organization changes retire pending markers. Codex resumes without a
synthetic prompt, other adapters receive a continuation instruction, and recovery never creates a
fresh provider conversation as a fallback. No SQLite migration is required.

Web and native machine preferences use `threadRestartContinuation`, default false; Swift mirrors
settings, capabilities and optional run/message fields. All newly added PR/settlement/recovery roots
are registered before update activation. Cross-environment shared preferences and per-update
handoff integration remain distinct parity work; the persisted machine opt-in covers normal updates.

### Linked pull-request collection panel

The upstream hydrated collection panel uses V2 shell snapshots and the fork's metadata
link/unlink commands. It opens from the thread header/sidebar collection and right-panel
launcher, retains independent PR detail tabs, and shows stack structure, host checks,
review decisions, conflicts, author, branch direction and sync age. Unknown host fields
stay unknown. The native linked-PR sheet already consumes the same snapshots.

### Native tool logos

Swift tool rows render HTTP(S) and inline raster/SVG logos through a bounded bitmap cache,
with theme-specific URLs and existing signed native-app icons. SVGView is pinned to revision
`fd9f0303bc2da37e5d1ea98f42835c8273361c7b`; parsing has no external-resource linker and
rejects excessive depth, size and recursive references. Transcript rows retain only a 48-pixel
raster; they do not embed web views or repeatedly parse SVG while scrolling.

### Shared server preferences

Web and Swift share restart continuation, automatic settlement, worktree origin, generated-text
model and source-control writing preferences across connected, capable environments. Other
server settings keep their explicit machine scope. The V2 capability gates retain legacy-client
fallbacks; account selections propagate only when the target enables the same instance/driver.
Disconnected targets are not overwritten with defaults. Mismatch notices offer an explicit
apply-to-all action using loaded settings; Swift reports individual failed target names.

### Whole-host resource sampling

`server.getHostResources` measures machine CPU and available memory independently of V2 provider
or process history. Sampling is on demand, deduplicates concurrent callers and expires after
five seconds; no idle polling is introduced. Shared TypeScript and Swift routing policies use
client receipt timestamps, reject saturated/stale machines and apply user weights. The RPC uses
orchestration-read authorization. Automatic draft UI integration is a separate client concern.

### Automatic selection for new tasks

Web/desktop and Swift expose client-local automatic balancing and per-machine preferences
(default off, weight 50; zero means manual only). Only connected machines with the same
repository identity, ready matching provider instance/driver, and selected model can compete.
Fresh whole-host capacity decides once per draft; busy, unknown, stale, or unreachable hosts
cannot win. Failure leaves an explicit retry/manual path and blocks automatic submission.
Queries mount only while selecting; native capacity requests time out after five seconds.

Web persists the choice on its V2 draft session and carries the selected model/options when
changing project scope. Branch selection overrides Auto. Attachments and machine-scoped context
prevent a fresh automatic move; late query responses recheck live draft state before moving it.
Native keeps the draft's storage key anchored to its original project and persists a separate
execution project, so routing cannot overwrite another machine's draft. Branches, uploads, file
search and provider controls follow the execution project. Manual workspace choices freeze that
project. Neither implementation imports a V1 thread runtime, and no migration is needed.
The frozen Expo client retains compatible defaulted contracts without a new balancing screen.

### Native file refresh after agent edits

Swift's open file browser and previews now use the same V2 terminal file-change/command
revision policy as web (`e09b88b6a5` intent). The revision is computed only for the open Files
surface, includes inherited source identity, and invalidates directory, text and media reads.
Reload and revision changes cancel/ignore older loads. Previous content stays visible with an
explicit refresh error; images bypass old cached bodies and document URLs retain signed query
bytes while carrying a cache revision. Document retries cannot resurrect an old signed URL after
navigation or agent edits. This is event-driven; no additional polling or V1 subscriptions.

### Editable file highlighting and wrapped geometry

The Pierre dependency patch retains the fork's controlled comment selection and exports while
adding upstream stale-worker/cache eviction (`df8e0eb46b`), editor grammar readiness
(`2fa5ef4c7b`), and measured-prefix preservation during edits (`6270a6f88b`). Width changes and
line-number digit boundaries still invalidate affected measurements; hidden zero-width layouts
wait for a visible resize. The reviewed tests execute the actual installed tokenizer, workers,
editor and virtualizer. Native source previews use Swift's read-only highlighting/layout and do
not instantiate this editor. Reselect-to-reveal in the diff tree was already present.

### Loading feedback and live activity motion

The loading/refresh treatment from `f12d39359f` keeps refresh glyphs stable while requests
run and uses a shared spinner throughout web/desktop. Usage history refresh waits for the
selected machines' rescans; disconnects abort waiting without hanging healthy machines.
Pricing refresh was subsequently ported below. Live V2 activity uses the masked text
highlight from `ce4712d5b0`; one shared observer pauses web motion offscreen, in hidden tabs
and for reduced motion. Swift uses a native masked highlight that stops when its row leaves
the view, the app becomes inactive, or reduced motion is enabled. No V1 runtime is imported.

### Usage history and current native contracts

Reviewed `2b745efe57` rate refresh and `394e8470c8` settings consistency now run independently
of V1: rate loads are single-flight with a one-minute manual floor and daily normal TTL;
custom prices and transcript homes use one settings snapshot. Failed fetches retain cached
rates. Web/desktop and Swift refresh pricing before rescanning, with older-server fallback.
The read-authorized RPC changes no provider credentials or transcript contents.

Web's permanent environment filter and incremental totals follow `7ee52b0773`; preferences
follow `add8c3a55a` while preserving the fork's separate Limits screen. Swift now decodes usage
v5, accepts compatible v4, excludes older/future versions, and carries hourly bucket starts.
It adds exact rolling 24-hour charts, selected-machine histories, progressive coverage and the
full model list. A generated server-schema fixture checks current native decoding and totals.
Expo remains frozen; its existing daily/hourly usage RPC is backward compatible.

### Codex reset credits on V2 provider instances

`1641b4aba5` is ported onto the fork's account-owning provider instances, retaining the V2
adapter and no V1 setup/runtime services. The scoped probe and reset action share app-server
initialization. An account-directory coordinator serializes attempts, keeps the idempotency key
on failure and bounds the request to 20 seconds. Registry hydration owns the coordinator across
instance rebuilds. Disabled/missing/non-Codex instances cannot redeem. The operate-authorized
RPC returns a warning, rather than an error inviting another redemption, if only the subsequent
limits probe fails. Live V2 window notifications retain banked credits (`f1a08116f9` intent).

Web/desktop and native Swift show banked counts/expiry and require explicit confirmation. The
redemption target follows the instance that supplied the displayed account snapshot, including
deduplicated multi-environment accounts. Web additionally respects known operate permissions;
the server is authoritative for every client. No real credit was redeemed during verification.
External quota hubs are now carried below; the frozen Expo client ignores optional credit data.

### External quota hubs (2026-09-12 parity port)

CLIProxyAPI quota sources (`19d8ab2ae9`, `0a89364f15`, `1641b4aba5` intent) use a
standalone UsageLimitSources service, separate from V2 runnable provider instances.
Background policy gates polling; configuration edits and explicit refresh update sources.
The opt-in `usageLimitSourcesUpdated` config event protects older clients. Web/desktop
project live sources without persisting them; Swift reads a bounded subscription for each
selected environment. Known account identities deduplicate local and hub reports, keeping
the reset target with the freshest displayed quota. Hub redemption pins both account and
credit with a stable request ID; a cooldown-clear failure is a successful result with warning.

Both maintained clients manage environment-local hubs, including edit, disable, re-enable,
and remove. Management keys live in the server secret store, are redacted on every client
settings path, survive redacted edits of legacy inline keys, and are deleted with sources.
Swift mirrors the new settings, capability, stream event, and credit contract, checked by a
schema-generated fixture. No V1 runtime or SQLite migration is introduced. Frozen Expo keeps
its existing UI and does not opt in to source events.

### Native project-action Run/Stop parity

Swift now uses the fork's existing terminal `scriptId` write attribution and
`activeScriptId` metadata to match web/desktop project actions. Single-run actions
interrupt their exact running session with Ctrl-C; a short pending-launch record
bridges metadata latency. Other busy shells are never reused for launches. The native
terminal opens the actual destination session, and the details sheet observes metadata
only while visible to render Run/Stop. Commands receive project/worktree environment
variables. A generation/workspace guard rejects stale launch destinations. Native
contract fixtures and pure routing tests cover attribution and session selection.

- Desktop browser profiles and cookie import are ported through the retained preview service.
  The existing per-environment default partition keeps its exact digest, preserving logins;
  named profiles use a separate namespace and Incognito uses memory-only partitions. The
  profile stays on snapshots across navigation and reports. Browser defaults are client-local;
  file links, terminal links, and agent-created tabs resolve them after settings hydration.
  The settings import wizard supports Chromium-family browsers, Firefox, and Safari with
  explicit source/target selection and OS permission recovery. It snapshots source databases,
  retains cookie domain scopes, skips partitioned/container cookies, and never bypasses Windows
  app-bound encryption. Native keyring bindings load only during an explicit import. Linux
  uses the bundled libsecret helper; no V1 runtime or database migration is introduced. Swift
  does not host Electron browser partitions, so these controls remain desktop-local.

### Browser recording and floating preview parity

Reviewed upstream `061543e9e5`, `9e37f0c291`, `ef7014d851`, `3941c2a1de`,
`12e8997e58` and `f57d3832c0` are adapted to the retained browser services. MCP snapshots
support image omission and bounded text while retaining complete structured metadata and the
fork's V2 workspace-safe screenshot saving. Evaluate results wrap arbitrary values in an object.
Agent recordings upload through the existing signed attachment transport and are claimed by
the invoking V2 thread; desktop-only paths are never presented as remote environment artifacts.
Transfers are size/deadline bounded, concurrent stops share an upload, and failures retain the
desktop copy. Old desktop clients return an explicit update-required error.

Electron 43 recording uses a short-lived frame-bound display-media grant and serializes only
capture startup. Active capture keeps hidden guests paintable and disables background throttling;
cleanup restores throttling and releases streams before upload. H264 is preferred when available,
with bounded resolution/frame-rate-based encoding quality. Floating previews resize from all
edges with their source aspect ratio, retain size through temporary container changes, and return
when their full browser panel closes. Agent activity honors explicit background-only opens and
the desktop-local automatic floating preference. Dialogs remain above floating browser content.
No V1 thread runtime or migration is introduced. Swift uses the existing authenticated artifact
renderer; Electron capture/profile controls remain desktop-specific.

### Local desktop CLI project opening

Upstream `04efa7907e` is manually ported through the desktop's local socket/named pipe,
renderer readiness broker, retained project aggregate and V2 shell/draft flow. `t3 app [path]`
uses the running desktop on the same machine, waits for project creation to reach the live
store, and reads current projects when opening the draft. Custom homes have isolated hashed
socket addresses; default home can fall back to the development desktop only before a
connection succeeds. SSH and Windows/WSL path mismatches fail explicitly. Requests are bounded,
serialized, and canceled on disconnect or renderer loss. Existing desktop focus behavior is
retained. No server startup, browser launch, V1 thread command or Swift wire change is added.

### Headless Connect diagnostics

Upstream `99e3b721c5` is ported into the fork's existing startup gate and service installer.
Linux status checks user-manager availability, lingering, enabled state and running state;
installation verifies prerequisites before replacing artifacts or stopping a working service.
Connect authorization is distinguished from live reachability. Typed relay failures retain
safe reason/trace information, permanent rejections stop retrying, and transient failures retain
the bounded startup retry. Tests mock service commands and relay responses. V2 activation and
restart continuation ordering remain intact; no provider or native contract changes are needed.

### Request-time Connect credential refresh

The final upstream `363cde4114` behavior supersedes the intermediate socket-replacement
approaches in `9e646ad84c` and `39abb9d1d6`. Web and Expo share one account-bound authorization
service for HTTP and connection setup; refreshes coalesce per environment, reject stale account
results, preserve newer tokens after late rejections, and cannot repopulate removed connections.
V2 shell/detail HTTP loaders retain `maxVisibleItems` and V2 projections; upstream V1 keyset
pagination stays excluded. Live sockets no longer reconnect solely because an HTTP token expires.
Session management retains unrevoked connected sessions without extending credential validity.

Swift already performs request-time renewal, shares in-flight work and reuses newer credentials.
Its session-permission check now also renews on an unauthenticated HTTP 200 response, once only,
and reports continued rejection. Cookie/bearer behavior is preserved. No SQLite migration or V1
runtime is added. Authentication tests use synthetic credentials and mocked transports.

- Carries upstream T3 Connect network guidance through the fork’s shared authorization, relay, and V2 RPC connection paths. Only relay transport failures and timeouts suggest DNS/firewall troubleshooting; authentication and server response errors retain their own messages. Swift already provides native network/VPN guidance and retry actions.
