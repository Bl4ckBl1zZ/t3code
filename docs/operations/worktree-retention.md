# Worktree retention runbook

Use this runbook when enabling, reviewing, or troubleshooting automatic worktree retention on a
server.

## Enable safely

1. Open **Settings → General → Worktree retention** on a client connected to the target server.
2. Set **Report only**.
3. Configure at least one rule: maximum age, inactivity, or merged pull request.
4. Leave the scan interval long enough to observe a complete scan, then review the server logs.
5. Confirm every reported path is disposable and belongs to the intended server-managed directory.
6. Enable **Delete** only after that review.

Delete mode removes the Git worktree without force. The existing Git driver may also remove a
T3-owned local branch with `git branch -d`; it never force-deletes the branch. Commits and the
retention registry row are retained, with the row marked removed for reconciliation and audit
context.

When the setting is **Off**, the server does not evaluate or remove candidates, but it still
reconciles the registry against fresh Git worktree refs. This clears interrupted-removal state
without enabling deletion.

Each delete is serialized by repository/path coordination and a generation-aware registry claim.
The claim is durable before the filesystem operation. After removal, the thread purge event and
registry finalization are attempted; if either fails, the server reports the partial outcome and a
later scan reconciles missing refs or stale claims. A running scheduled task with no bound thread
causes the scan to treat all candidates as unknown, so it cannot accidentally delete a workspace
used by an automation run.

## Expected skips

These are normal and should be investigated before changing the safety policy:

- `dirty_worktree`: the worktree has uncommitted changes;
- `active_use`, `active_use_unknown`, or `shared_owner`: a thread, provider, terminal, background
  process, or shared owner may still use it;
- `path_boundary_unknown` or `git_worktree_unknown`: canonical filesystem or Git inspection did
  not prove the target safe;
- `pr_unknown`: source-control state could not be established for a merge rule; and
- `max_age_unknown` or `stale_activity_unknown`: legacy discovery did not provide a trustworthy
  timestamp.

Retention fails closed. Do not work around a skip by forcing Git removal or by broadening the managed
root until the underlying state is understood.

## A thread was purged unexpectedly

First check the server logs for the candidate path and matched rule. Confirm the configured mode and
thresholds, then inspect the worktree's Git status and the thread's latest workspace state. A purged
thread is re-provisioned on the next follow-up send or terminal open when its branch and project are
still available. A merged pull request may have allowed Git's safe local branch cleanup, in which
case recovery returns a typed error rather than silently using the project root.

If recovery reports `removal-in-progress`, do not manually delete or recreate the path. Let the next
retention reconciliation complete; it will either confirm the Git ref is gone or release a stale
claim when the worktree is still present. If recovery reports `branch-unavailable`, the original
branch is no longer available locally and must be restored or selected explicitly by the user.

If re-provisioning fails, the client receives a typed worktree recovery error. Check that the project
still exists, the branch is available, the server can create a worktree under its managed directory,
and the server's registry migration has run. Do not manually point the thread at the project root if
it is still marked purged.

## Managed updates and restart behavior

The retention loop is parked during a managed server update trial and starts only after activation.
A normal restart may run a scan after startup; it does not require a separate manual migration
command beyond the standard server migration process.
