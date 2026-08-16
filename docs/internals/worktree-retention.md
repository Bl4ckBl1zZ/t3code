# Worktree retention architecture

Worktree retention is a server-owned, activation-gated maintenance service. It is deliberately
separate from orchestration: the registry and candidate evaluator provide durable inventory and
pure decisions, while the service performs fresh filesystem, Git, activity, and source-control
checks before an optional removal.

## Data flow

```text
worktree creation/removal
        │ register / claim / finalize
        ▼
worktree_retention_registry
        │ generation-aware reconciliation with fresh local Git worktree refs
        ▼
candidate snapshot ──► pure retention evaluator ──► report or safe Git removal
                                                    │
                                                    ├─ registry state = removed
                                                    └─ thread.metadata.update(worktreeStatus=purged)
```

`apps/server/src/worktree/WorktreeRegistry.ts` records the repository root, path, branch, owning
project/thread, ownership class, creation/activity timestamps, and the last observed state. T3
creation paths register immediately. Reconciliation also records legacy Git worktrees, but does not
invent a creation timestamp for them; legacy rows remain ineligible until an explicit ownership
policy exists. Explicit paths supplied by a user or MCP are `unmanaged` and are never eligible for
automatic deletion.

The inventory facade canonicalizes repository and worktree paths before persistence. A repository
lock serializes creation, recovery, removal, and reconciliation for one repository; a nested
worktree-path lock narrows the purge critical section. The registry generation identifies one
physical worktree lifetime. Delete mode first claims that generation with a compare-and-set update,
then removes the worktree, then finalizes the claim. A competing scan or a reused path cannot
finalize the old generation. If the process stops between those steps, reconciliation marks missing
Git refs removed and releases stale claims for refs that are still present.

`evaluateWorktreeRetentionCandidate` in `WorktreeRetention.ts` is pure. Age, inactivity, and merged
pull-request rules are ORed; every safety predicate is ANDed. A `true` candidate requires known
managed ownership, a canonical path inside the configured worktree directory, an exact Git
worktree ref, a non-root path, clean Git status, no active use, and no shared owner. Unknown state
returns a skip reason rather than an eligible candidate.

The service refreshes local refs and source-control state. In Delete mode it repeats the candidate
evaluation immediately before calling `GitWorkflowService.removeWorktree` without `force`. The
existing Git driver may then remove a T3-owned local branch with `git branch -d`; it never
force-deletes that branch, and retention never directly deletes a branch. The service dispatches an
optimistic-concurrency-protected metadata update with `worktreePath: null` and
`worktreeStatus: "purged"`. If the metadata update fails after Git removal, the registry still
records the removed path and warning logs retain the evidence; the next dedicated-worktree use
repairs the thread metadata before reprovisioning. An active removal claim blocks recovery until
the removal is reconciled, so a crashed purge cannot cause a replacement worktree to race the old
one. It must not silently substitute the project root.

## Recovery contract

`ThreadManagementService.ensureWorktreeForThread` is called before follow-up sends. It acts on a
thread explicitly marked `purged`, or on a removed registry record whose purge event has not reached
the thread projection. In the latter case it first clears the stale path with an expected-path
metadata update. It then creates a new worktree from the recorded branch, registers it as T3-created,
and atomically rebinds the thread with an expected-null path. Recovery never deletes the recorded
branch when reprovisioning metadata fails; that branch may contain user work. If the branch was
removed by Git's safe cleanup after a merged pull request, recovery returns the typed
`branch-unavailable` error. Terminal open/attach uses the same recovery path. Workspace-file asset
URLs return a typed purged error instead of resolving against the repository root.
`RuntimePolicyV2` also rejects a purged/null path so a race cannot materialize uploads or checkpoints
in the wrong workspace.

Pull-request checks go through `GitManager.findFreshPullRequestState`, which resolves the branch head
and asks the provider-neutral source-control boundary for current change-request state. The retention
service does not select a provider or reuse a UI/status cache. Provider, authentication, network, or
ambiguous results are `unknown` and fail closed.

Running scheduled tasks are part of the ownership snapshot. A task with a known thread protects that
thread; an active task without a thread binding makes the scan's ownership result unknown for all
candidates. The retention worker is not itself a scheduled task.

## Lifecycle and compatibility

The long-running service is forked parked before command readiness and released only at the server
activation boundary. A managed update trial therefore cannot delete or report worktrees before the
launcher commits the new version. The service reads settings on each iteration and is supplied by
the orchestration production layer. Policy mode `off` skips candidate evaluation and removal but
still runs registry reconciliation so an interrupted removal cannot block recovery indefinitely.

The settings field and thread worktree status are additive contract changes. Web and desktop expose
the server setting; existing mobile clients can continue to decode and use the server because the
new fields are optional/defaulted, while no mobile editor is required for the first release. The
server accepts retention scan intervals from one hour through seven days. The default mode is
`off`; report mode is the recommended first rollout step.
