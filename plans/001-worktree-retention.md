# Plan 001: Add guarded server-owned worktree retention and purge

> This is an implementation plan, not an authorization to enable deletion in production. The executor must keep the default mode disabled, must not broaden the path scope, and must stop at the conditions listed below.

## Status

- Priority: P1
- Effort: L
- Risk: High
- Category: direction
- Depends on: none
- Planned at commit: 5ec4aa862
- Planned on: 2026-08-16
- Implementation status: implemented locally; retention remains default-off and no production setting was changed.

## Goal

Add an opt-in, server-owned retention service that can report or purge T3-managed Git worktrees when one of these configurable rules matches:

1. the worktree is older than a configured age;
2. the worktree has had no qualifying activity for a configured duration; or
3. its associated pull request is freshly confirmed as merged and the merge rule is enabled.

The service must be conservative by construction. It must never force-delete dirty worktrees, delete a worktree while it is in use, treat an unavailable pull-request provider as proof of a merge, or leave a thread pointing at a path that no longer exists.

In this plan, “satur for X amount of time” is interpreted as “stale/inactive for X amount of time.” If that means something else, stop before implementation and resolve the product meaning.

## Discovery baseline

### Repository and working-tree state

Discovery was performed in /Users/dylan/.t3/worktrees/t3code/t3code-ed82e6d4.

Before creating this plan:

- the working tree was clean, including untracked-file inspection;
- the branch was t3code/ed82e6d4;
- HEAD was 5ec4aa862;
- the latest relevant history included worktree deduplication and auto-settle-on-merge changes, which are existing behavior to preserve;
- no source, configuration, migration, or documentation files were changed.

### Documentation reviewed

The repository documentation was surveyed broadly, with the worktree, source-control, orchestration, settings, server-runtime, testing, and operations documents read for this feature. The relevant contracts are:

- docs/internals/overview.md and docs/internals/remote.md: the server owns projects, threads, VCS operations, and filesystem access; remote clients do not own the filesystem.
- docs/internals/workspace-layout.md and docs/internals/glossary.md: a worktree is an isolated Git workspace associated with a thread through worktreePath.
- docs/user/source-control.md: source-control authentication and provider operations happen through the server, with GitHub, GitLab, Bitbucket, and Azure DevOps supported.
- docs/user/project-settings.md, docs/user/thread-sidebar.md, and the auto-settle settings UI: existing auto-settle behavior changes thread/sidebar visibility, not physical worktree deletion.
- docs/orchestration-v2/core-graph-and-data-model.md and docs/orchestration-v2/feature-lifecycles.md: thread metadata is event-sourced and includes branch, worktreePath, timestamps, archive state, and delete state.
- docs/orchestration-v2/testing-strategy.md: use real services with temporary files/databases, TestClock, deterministic receipts, and no sleep-based orchestration tests.
- docs/operations/observability.md: server diagnostics use structured logs and must not expose secret values.
- docs/internals/server-updates.md: long-running roots that can mutate user state must remain parked during the activation/trial boundary.
- docs/user/hermes-scheduled-runs.md, docs/user/background-commands.md, and docs/user/background-service.md: scheduled runs and background work are independent activity sources that must block physical cleanup while active.
- README.md, CONTRIBUTING.md, docs/README.md, and docs/internals/scripts.md: normal contribution and targeted validation conventions.

There is no existing retention or purge policy document. Add one as part of this work.

### Existing implementation constraints

The executor should re-check these excerpts immediately before editing. If the contracts have moved or changed materially, update this plan before continuing.

| Area                        | Current location                                                                                                              | Constraint to preserve                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server worktree root        | apps/server/src/config.ts:28-35,105-165                                                                                       | The server derives and creates ServerDerivedPaths.worktreesDir; retention must not scan or delete arbitrary filesystem paths.                      |
| VCS create/remove contracts | packages/contracts/src/git.ts:137-165, packages/contracts/src/rpc.ts, apps/server/src/ws.ts:1997-2003                         | Create/remove are typed RPC operations. Automatic deletion must use a server-side service and must not add a client-side filesystem shortcut.      |
| Worktree creation           | apps/server/src/vcs/GitVcsDriverCore.ts:3128-3184                                                                             | T3-created branches are marked with branch.<ref>.t3-worktree-owned=true; preserve this marker and existing branch cleanup behavior.                |
| Worktree removal            | apps/server/src/vcs/GitVcsDriverCore.ts:3368-3467                                                                             | Removal canonicalizes paths, prunes on failure, and deletes only an owned branch with git branch -d; never introduce -D for retention.             |
| Large-tree behavior         | apps/server/src/vcs/GitVcsDriverCore.ts:56-64                                                                                 | Worktree removal can take up to five minutes; use serial or bounded low-concurrency deletion and cancellation-aware effects.                       |
| Existing client cleanup     | apps/web/src/worktreeCleanup.ts, apps/web/src/hooks/useThreadActions.ts:300-368                                               | Current orphan cleanup is user-confirmed and uses force: true; it is not a template for unattended retention.                                      |
| Thread metadata             | apps/server/src/orchestration-v2/ThreadLaunchService.ts:230-330, apps/server/src/orchestration-v2/Orchestrator.ts:1160-1245   | Worktree path and branch are persisted through thread metadata events; a physical purge must emit a durable state transition.                      |
| Future thread use           | apps/server/src/orchestration-v2/ThreadManagementService.ts:465-540, apps/server/src/attachments/AttachmentMaterialization.ts | Existing send/terminal/attachment paths can use the retained worktreePath; leaving a stale path would create a broken thread.                      |
| Thread visibility           | apps/server/src/orchestration-v2/ProjectionStore.ts:2325-2380,2440-2650                                                       | Deleted threads are omitted from the visible shell, while archived threads remain relevant owners.                                                 |
| Subagent ownership          | docs/orchestration-v2/orchestrator-mcp-server.md:242-245                                                                      | Subagent threads inherit the parent project/branch/worktree; ownership checks must include the whole lineage.                                      |
| Server settings             | packages/contracts/src/settings.ts:864-968,1072-1129, apps/server/src/serverSettings.ts:1-180                                 | Retention configuration belongs in authoritative ServerSettings with validated patches, defaults, and update streaming.                            |
| Settings routing            | apps/web/src/hooks/useSettings.ts:154-174,298-338, apps/web/src/components/settings/SettingsPanels.tsx:2051-2117              | Web settings already distinguish server-authoritative settings from device-local settings; do not put retention policy in client-only preferences. |
| PR lookup                   | apps/server/src/git/GitManager.ts:1277-1345,1774+, apps/server/src/pullRequest/PullRequestProvider.ts                         | Existing status lookups may use cached/last-known data. Destructive retention must use a fresh provider query with an explicit unknown result.     |
| Provider boundary           | apps/server/src/pullRequest/PullRequestProviderRegistry.ts, apps/server/src/sourceControl/SourceControlProvider.ts:86-104     | Keep the provider-neutral lookup and support all registered providers without embedding GitHub-specific logic.                                     |
| Startup lifecycle           | apps/server/src/serverRuntimeStartup.ts:378-405,557-565, apps/server/src/server.ts:374-422,687+                               | A cleanup worker must be parked until ServerActivation; it must not delete during an update trial or before runtime readiness.                     |
| Existing scheduled tasks    | apps/server/src/scheduledTasks/ScheduledTaskService.ts:718-723                                                                | This is a global server policy, not a user scheduled task. Do not hide retention in the per-user scheduled-task loop.                              |
| Test style                  | docs/orchestration-v2/testing-strategy.md:3-5,27-52 and existing VCS/orchestration tests                                      | Use temporary repositories/databases, TestClock, receipts, and focused tests; do not rely on sleeps or a repository-wide check.                    |

## Product and safety decisions

Implement these as explicit contracts, not incidental conditionals.

### Configuration

Add a versioned, server-authoritative settings object following the repository’s existing ServerSettings schema conventions. The exact schema name may follow local naming, but it must represent at least:

    worktreeRetention:
      schemaVersion: 1
      mode: "off" | "report" | "delete"
      maxAge: duration | null
      staleAfter: duration | null
      deleteOnPullRequestMerge: boolean
      scanInterval: duration

Recommended defaults:

- mode: off;
- maxAge: null;
- staleAfter: null;
- deleteOnPullRequestMerge: false;
- a conservative scan interval that does not create frequent Git/provider load.

At least one rule must be configured before report or delete can produce candidates. Matching rules are ORed. Safety gates are always ANDed and are not user-configurable bypasses.

Do not reuse sidebarAutoSettleAfterDays or sidebarAutoSettleOnMerge: those settings are visibility/settling behavior, not deletion authority.

### Ownership and inventory

Add a durable server-side registry/inventory for worktrees. A registry record should identify, at minimum:

- canonical repository root and canonical worktree path;
- associated project/thread when known;
- branch/ref when known;
- creation timestamp for new T3-created worktrees;
- discovery timestamp for legacy paths;
- source/ownership classification such as t3-created, legacy-discovered, or unmanaged;
- last qualifying activity observed;
- current state and last removal reason/outcome.

Use a SQLite migration under apps/server/src/persistence/Migrations/. Keep registry state separate from the event-sourced thread projection, while recording the thread’s purged state through a normal orchestration event.

Only explicitly T3-managed worktrees should be eligible for automatic deletion. An explicit custom path, arbitrary manually-created worktree, project root, or path outside ServerConfig.worktreesDir must be report-only or skipped unless a later, explicit product decision adds an opt-in ownership mechanism.

On first enablement, reconcile Git’s worktree list with thread metadata and the registry. Backfill legacy paths as discovered now (or with another conservative lower-bound timestamp); do not infer an exact creation age from directory mtime or thread creation time. The first reconciliation must not mass-delete existing trees.

Every T3 creation path must register successfully before the operation is considered complete, or clean up the newly-created path and return the registration error. Audit and cover these current callsites:

- apps/server/src/orchestration-v2/ThreadLaunchService.ts;
- apps/server/src/git/GitManager.ts PR worktree preparation;
- apps/server/src/mcp/WorktreeMcpService.ts;
- apps/mobile/src/state/use-selected-thread-git-actions.ts;
- any shared vcs.createWorktree callers found by a fresh rg.

Every T3 removal path must mark the registry only after physical removal succeeds, with reconciliation repairing partial registry failures and preserving active removal claims when a present ref is re-registered.

### Candidate rules

Use:

- registry creation time for maxAge, never filesystem mtime;
- qualifying activity from durable user/run/workflow events for staleAfter, not thread viewing, a directory scan, or an arbitrary process timestamp;
- a fresh provider result for merge deletion.

The merge rule must distinguish:

- merged: eligible for the merge predicate;
- not_merged: not eligible;
- unknown: provider unavailable, unauthenticated, unsupported, ambiguous, or query failed; skip and retry later.

closed is not merged. Do not use GitManager’s cached or last-known status fallback as destructive proof.

### Immutable safety gates

Before deleting any candidate, all of these must hold:

- the retention mode is delete;
- the path is canonical, exists, is a Git worktree currently listed by Git, and is strictly inside the server’s managed worktreesDir;
- the worktree is explicitly managed by T3;
- no active provider session, active turn, approval/runtime request, background command, terminal, scheduled launch, or concurrent mutation owns or uses it;
- no active, archived, deleted, or subagent/lineage owner still requires the path, unless the event-sourced purge/reprovision transition explicitly handles every owner;
- Git reports a clean tree; no force flag is used;
- repository and Git state are readable; any error is a skip, never a destructive fallback;
- the candidate is not the project root, a configured custom external path, or a path reached through a symlink/prefix-confusion escape;
- the operation is idempotent and protected by a per-path lock.

If any gate is unknown, skip with a structured reason and retry on a later scan. Never convert “could not check” into “safe to delete.”

### Thread correctness and reprovisioning

A successful physical purge must emit an explicit thread metadata transition. Add an additive worktree status such as:

    worktreeStatus: "none" | "present" | "purged"

The exact name may follow local schema vocabulary, but the semantics must be equivalent:

- present means the recorded path is usable;
- none means the thread intentionally has no dedicated worktree;
- purged means the dedicated path was removed and the next dedicated-worktree use must reprovision or ask the user.

Clear or invalidate the stale worktreePath after purge. Preserve enough branch/registry information to attempt a safe branch-backed reprovision; do not silently claim the branch still exists. A merged or deleted branch must produce a typed “reprovision required” result rather than silently falling back to the project root.

Introduce a shared server-side provisioning/validation helper and use it from ThreadLaunchService, ThreadManagementService.sendToThread, terminal/attachment paths that need a dedicated worktree, and any other current reuse path discovered by rg. A retained thread must either:

1. transparently receive a newly-created worktree from its known branch; or
2. receive a clear, typed error/state that the user must choose how to reprovision.

This is a required part of the feature. A worker that deletes files while leaving ordinary launch/send behavior unchanged is not a valid implementation.

### Pull-request merge behavior

Extract or expose a fresh, provider-neutral branch-head lookup based on the existing GitManager head-selector logic. The retention evaluator must not call a UI cache or a status path with stale fallback. Query only after local safety/threshold gates make the candidate otherwise eligible, and bound provider work so a large scan cannot create unbounded network traffic.

The lookup must work through the existing GitHub, GitLab, Bitbucket, and Azure DevOps provider boundary. Provider/auth/network/ambiguous results are unknown and block deletion.

## Scope

### In scope

- A versioned server-authoritative retention setting and validation.
- A durable worktree registry/reconciliation model and migration.
- Registration/reconciliation for all supported T3 worktree creation paths.
- A dedicated activation-gated WorktreeRetentionService.
- Candidate evaluation for age, inactivity, and freshly confirmed PR merge.
- Immutable safety gates, structured skip/delete reporting, idempotency, and bounded deletion concurrency.
- Event-sourced thread state for a purged worktree and safe reprovision/typed failure on later use.
- Web/desktop settings UI. Desktop inherits the web UI; do not build a second Electron-only settings surface.
- Additive contract compatibility for Swift and React Native clients. If those clients do not currently expose a generic server-settings editor, they may ignore the new field initially; do not put the policy in mobile-local settings.
- Focused unit/integration tests with temporary Git repositories and databases.
- User, internals, and operations documentation for the new behavior.

### Out of scope

- Deleting projects, main checkouts, the T3 database, conversations, attachments, or arbitrary files by recursive directory traversal.
- Force-deleting dirty, unmerged, active, shared, or externally-owned worktrees.
- Automatically merging or closing pull requests.
- Reinterpreting existing sidebar auto-settle settings as physical cleanup.
- Managing manually-created or arbitrary custom worktrees without an explicit future ownership mechanism.
- A full orchestration-v2 rewrite, provider runtime cleanup, or unrelated refactor.
- Browser/computer-use QA in this implementation plan; the repository instructions require explicit user agreement before such verification.
- Enabling deletion by default, changing production settings, or deploying the feature.

## Implementation sequence

### 1. Lock the contract and add the registry migration

1. Re-read the current contracts and run the drift check below.
2. Add the retention settings schema, defaults, patch validation, and server-settings round-trip.
3. Add a SQLite migration and typed registry service. Define unique canonical repository/path identity, ownership, timestamps, state, and removal reason.
4. Define reconciliation behavior for missing/extra registry rows and legacy worktrees. Make the migration/backfill conservative and idempotent.
5. Decide and document the exact event name/payload for the thread worktree status transition before wiring physical deletion.

**Verify**

- Focused settings schema/default/patch tests pass.
- Migration tests pass on empty and representative preexisting databases.
- Re-running reconciliation produces no duplicate rows or new destructive actions.
- A registry write failure cannot report a newly-created worktree as successfully provisioned.

### 2. Centralize inventory and registration

1. Add a server-side inventory operation that obtains Git’s canonical worktree list for each configured project/repository without recursively scanning arbitrary disk paths.
2. Reuse the existing path canonicalization and worktreesDir boundary checks.
3. Register successful T3-created worktrees at every current creation path. Add an owner/thread parameter only where the existing callsite knows it; do not invent ownership for arbitrary VCS operations.
4. Mark successful removals and reconcile partial failures.
5. Include archived, deleted, and subagent/lineage records in owner detection. Do not assume the visible active shell is the complete ownership set.

**Verify**

- Existing GitVcsDriverCore create/remove tests remain green.
- New tests cover explicit paths, duplicate names, macOS canonical /var paths, missing paths, project-root paths, symlink/prefix escapes, and legacy discovery.
- A fresh worktree is not left unregistered when registration fails.
- Manual/unmanaged worktrees are reported as ineligible rather than silently adopted.

### 3. Build a pure candidate evaluator and fresh PR lookup

1. Implement a pure evaluator over an inventory record, thread activity snapshot, runtime-ownership snapshot, Git cleanliness/path state, settings, current time, and PR tri-state.
2. Apply OR semantics to configured age/stale/merge predicates and AND semantics to safety gates.
3. Add a provider-neutral fresh branch-head query by extracting/reusing GitManager’s head-selector construction. Keep UI/status caches and last-known fallback out of this path.
4. Defer the PR query until the candidate passes local gates. Return unknown on all provider/auth/network/unsupported failures.
5. Emit stable reason codes such as active_owner, dirty_worktree, outside_managed_root, unmanaged, shared_owner, pr_unknown, and not_old_or_stale so report mode is actionable.

**Verify**

- Table-driven evaluator tests cover each gate independently, multiple matching rules, no-rule configuration, boundary timestamps, unknown PR state, clean/dirty Git state, shared ownership, and idempotent re-evaluation.
- Provider fixtures cover GitHub, GitLab, Bitbucket, and Azure DevOps through the existing provider-neutral boundary.
- Tests prove cached/last-known PR data cannot authorize deletion.
- No evaluator test needs sleep, network credentials, or a real provider.

### 4. Add purge state and safe reprovisioning

1. Add the additive thread worktree status contract and projection support, with backward-compatible defaults for old events/rows.
2. Add the event/decider/projector path for a successful purge: clear or invalidate the path, retain the branch/registry relationship needed for reprovision, and record the purge reason.
3. Add a shared provisioning helper that validates a path before use and reprovisions a purged dedicated worktree from a known branch when safe.
4. Route launch, send, terminal, and attachment use through that validation boundary. Ensure root-mode threads remain root-mode and are not accidentally converted to dedicated worktrees.
5. Make repeated purge notifications and already-missing paths idempotent without fabricating success for an unknown Git state.

**Verify**

- Orchestration tests prove purge updates the event-sourced state and future sends do not use the deleted path.
- Tests cover branch-present reprovision, merged/deleted branch requiring user action, root-mode threads, archived threads, subagents, and stale client projections.
- Terminal and attachment materialization tests prove they reject or reprovision a purged path instead of writing into a missing/stale location.
- Existing thread launch/reuse/PR-worktree tests remain green.

### 5. Implement the activation-gated retention worker

1. Add a dedicated WorktreeRetentionService rather than placing this policy in ScheduledTaskService.
2. Start its loop only after server activation/readiness; park it during update trials using the existing startup lifecycle pattern.
3. On each scan, reconcile inventory, snapshot active runtime ownership, evaluate candidates, and run report/delete behavior.
4. Use serial or small bounded concurrency for Git/provider checks and deletion. Add per-path locking and cancellation.
5. For delete mode, re-check mutable safety gates immediately before removal. Remove with the non-force VCS path, then emit the thread transition and update the registry.
6. Log structured candidate, skip, delete, and failure outcomes without secrets. Expose enough reason information for operations without adding noisy external notifications.

**Verify**

- TestClock tests prove exact scan timing and threshold boundaries.
- Startup tests prove no scan/delete occurs before activation and that cancellation cleans up the worker.
- Integration tests run against temporary Git repositories with clean, dirty, active, shared, missing, and outside-root paths.
- Report mode never mutates the filesystem.
- Delete mode never passes force: true, never deletes a dirty tree, and remains safe after a restart or repeated scan.
- A provider outage produces skips and retryable diagnostics, not deletion.

### 6. Add settings UI and client compatibility

1. Add a clearly server-scoped retention section to apps/web/src/components/settings/SettingsPanels.tsx using the existing primary/server settings hooks.
2. Explain that deletion happens on the server, applies to managed worktrees, skips active/dirty/shared/unknown states, and is irreversible at the filesystem level.
3. Provide off, report, and delete modes, age/stale thresholds, PR-merge toggle, and scan interval. Make delete an explicit opt-in confirmation and keep the default disabled.
4. Do not add retention to the current mobile-local auto-settle preference.
5. Keep the wire change additive for Swift and React Native. If the clients decode a fixed server-settings snapshot, update their fixtures/models only as needed to preserve decoding and generated-contract checks; do not claim a mobile settings editor unless one is actually implemented.
6. Prefer report-mode logs and a future read-only report surface over a “run now” destructive button in the first version. If a preview RPC is added, define it in contracts, enforce read scope, and keep execution separate with operate scope.

**Verify**

- Contract tests cover defaults, invalid durations, null thresholds, mode transitions, and additive unknown-field decoding.
- Web typecheck and focused settings tests pass.
- Swift contract fixture generation/check passes if the server snapshot is changed.
- Mobile typecheck/tests pass if mobile models or shared contracts are touched.
- No browser/computer-use check is performed without explicit user approval.

### 7. Document and stage rollout

1. Add docs/user/worktree-retention.md covering configuration, modes, thresholds, ownership, remote behavior, PR provider/auth failures, safety skips, and how to recover/reprovision a purged thread.
2. Update docs/internals/workspace-layout.md or docs/internals/glossary.md with managed, legacy, purged, and reprovisioned worktree semantics.
3. Add an operations section/runbook describing structured logs, reason codes, activation behavior, registry reconciliation, and safe diagnosis.
4. Link the new user document from docs/README.md and keep user-facing docs free of source-path/tooling language.
5. Roll out in stages: schema/registry with mode off; report-only observation; explicitly configured delete mode in a test/dev environment; only then consider any production enablement as a separate approval.

**Verify**

- Documentation links resolve and terminology matches the implemented contract.
- The staged rollout can be exercised without changing production settings.
- The final diff contains only the feature, focused tests, docs, and required generated contract fixtures.

## Targeted verification

Run only checks proportional to the files changed. Do not run vp check, vp run -r test, or vp run -r typecheck unless separately requested.

Suggested commands after implementation:

    git status --short --untracked-files=all
    git diff --check

    ./node_modules/.bin/vp test run packages/contracts/src/settings.test.ts packages/contracts/src/orchestrationV2.test.ts packages/contracts/src/terminal.test.ts packages/shared/src/serverSettings.test.ts apps/server/src/serverSettings.test.ts apps/server/src/persistence/Migrations/036_037_OrchestrationV2.test.ts apps/server/src/persistence/Migrations/054_WorktreeRetentionRegistry.test.ts apps/server/src/persistence/Migrations/055_WorktreeRetentionLifecycle.test.ts apps/server/src/persistence/UpstreamJournalReconciliation.test.ts apps/server/src/orchestration-v2/ProjectionStore.test.ts apps/server/src/orchestration-v2/RuntimePolicy.test.ts apps/server/src/orchestration-v2/ThreadLaunchService.test.ts apps/server/src/orchestration-v2/ThreadManagementService.test.ts apps/server/src/orchestration-v2/runtimeLayer.test.ts apps/server/src/worktree/WorktreeOperationCoordinator.test.ts apps/server/src/worktree/WorktreeProvisioningService.test.ts apps/server/src/worktree/WorktreeRegistry.test.ts apps/server/src/worktree/WorktreeRetention.test.ts apps/server/src/worktree/WorktreeRetentionExecutor.test.ts apps/server/src/worktree/WorktreeRetentionService.test.ts apps/server/src/terminal/Manager.test.ts apps/server/src/mcp/WorktreeMcpService.test.ts apps/server/src/git/GitManager.test.ts apps/server/src/vcs/GitVcsDriverCore.test.ts apps/server/src/serverRuntimeStartup.test.ts apps/server/src/serverActivation.test.ts
    cd apps/server && ../../node_modules/.bin/tsgo --noEmit
    cd apps/web && ../../node_modules/.bin/tsgo --noEmit
    node scripts/generate-swift-contract-fixtures.ts --check

Add the relevant apps/mobile tests/typecheck and Swift fixture check only if those surfaces are changed:

    cd apps/mobile && vp run typecheck
    node scripts/generate-swift-contract-fixtures.ts --check

Use the repository’s actual test file names if new files are placed under a different local convention. The executor must report any skipped check and why.

## Implementation record

The local implementation adds the server-authoritative settings and bounds, the durable registry
with per-lifetime generations and compare-and-set removal claims, a canonical inventory facade, and
an explicit operation-based provisioning seam. Retention re-checks candidates under repository/path
coordination, blocks active scheduled work, uses a fresh provider-neutral GitManager pull-request
lookup, reconciles missing refs and stale claims, and records a purged thread state before later
reprovisioning or a typed branch-unavailable/removal-in-progress result. Reconciliation remains
active in policy Off mode so interrupted removals cannot strand recovery. Recovery rollback removes
the newly-created worktree but preserves an existing branch. The recovery and repository-locking
flow is isolated in `ThreadWorktreeService.ts`, keeping the existing thread-management module below
the repository's 1,000-line maintainability threshold.

The web settings section is decomposed into its own module. User, internals, and operations docs
describe report-first rollout, the one-hour-to-seven-day scan bound, claim/reconciliation behavior,
and branch/recovery semantics. Retention remains default-off; no production setting or deployment was
changed. No browser/computer-use pass or hosted CI/deployment proof is claimed because the repository
instructions require explicit user approval for that validation surface.

The final verification record below must contain only checks actually run in this checkout.

## Final verification record

- Focused server/contract suite: 26 files, 515 tests passed, including migration journal continuity and lifecycle regressions for both explicit paths and legacy null updates that must preserve `purged` state, plus active removal-claim preservation during reconciliation and registry re-registration.
- Server TypeScript check: passed; only non-blocking existing-style suggestions were emitted.
- Web TypeScript check: passed.
- Focused formatter check: passed for the changed retention/worktree modules.
- Swift contract fixtures: up to date.
- Planned source drift check against `5ec4aa862..HEAD`: completed successfully before the final ship review; the changed upstream paths were inspected against the current contracts.
- `git diff --check`: passed.
- Browser/computer-use validation, hosted CI, deployment, and production behavior were not
  checked; no production setting was changed.

## Done criteria

The feature is complete only when all of the following are true:

- Settings, registry, evaluator, worker, event-sourced purge state, and reprovisioning behavior are implemented and covered by focused tests.
- Default mode is off; enabling delete is explicit; no production setting is changed by the implementation.
- Automatic deletion is limited to explicitly managed worktrees under the canonical server worktree root.
- No automatic path uses force: true; dirty, active, shared, outside-root, unmanaged, and uncertain candidates are skipped.
- PR merge deletion requires a fresh provider-neutral merged result; closed, cached, stale, unauthenticated, and unknown results do not authorize deletion.
- A successful purge cannot leave ordinary launch/send/terminal/attachment flows pointing at a missing path.
- Existing auto-settle, manual orphan cleanup, VCS branch safety, remote execution, and provider behavior remain intact.
- Server startup/update lifecycle, cancellation, restart/reconciliation, and idempotency are tested.
- Web/desktop settings behavior is documented. Shared contract compatibility for mobile/Swift is verified for any touched models.
- User, internals, and operations documentation explain the irreversible filesystem behavior and recovery path.
- Targeted tests/typechecks and git diff --check pass, and the final diff is reviewed for unrelated changes.

## Stop conditions

Stop and report instead of guessing if:

- “stale/inactive” has a different product meaning than assumed here;
- current source no longer has a trustworthy server worktree boundary or canonical Git worktree listing;
- ownership cannot be determined without adopting arbitrary manual/custom paths;
- the implementation cannot atomically or durably transition a thread away from a purged path;
- branch-backed reprovisioning would silently destroy user work or fall back to the project root;
- a provider cannot distinguish fresh merged, not_merged, and unknown;
- active runs, approvals, terminals, background commands, scheduled work, or shared/subagent ownership cannot be checked fail-closed;
- migration/backfill would assign unsafe creation times or make existing trees immediately eligible;
- a proposed change requires force deletion, recursive filesystem traversal, production mutation, or unrelated refactoring;
- targeted tests fail twice for the same unresolved cause or require edits outside this scope;
- a user asks to enable or deploy deletion without explicit production approval.

## Maintenance notes

- Re-run the drift check against 5ec4aa862 before implementation:

  git diff --stat 5ec4aa862..HEAD -- packages/contracts/src/settings.ts packages/contracts/src/git.ts packages/contracts/src/rpc.ts apps/server/src/config.ts apps/server/src/git apps/server/src/orchestration-v2 apps/server/src/persistence apps/server/src/serverRuntimeStartup.ts apps/server/src/server.ts apps/server/src/scheduledTasks apps/server/src/vcs apps/server/src/ws.ts apps/web/src apps/mobile/src apps/swift-ios docs

- Preserve unrelated user changes and inspect untracked files before any review.
- Keep retention logic on the server because local, remote, relay, tunnel, desktop-hosted, and web-connected clients share the server’s filesystem boundary.
- Keep fresh-activity semantics explicit. Do not broaden activity to page views or broad cache hydration merely to avoid deleting a stale-looking tree.
- If a future UI adds manual “delete now,” reuse the same candidate evaluator and safety gates; never create a second, weaker deletion path.
- If a future feature supports externally-owned custom worktrees, add an explicit ownership/consent contract and tests before allowing retention to manage them.
