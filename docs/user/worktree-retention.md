# Worktree retention

Worktree retention keeps old T3-created Git worktrees from accumulating on the machine running
T3 Code. The setting belongs to the server, so it applies to every client connected to that server.

Open **Settings → General → Worktree retention**.

Retention runs on the server that owns the project filesystem. If you connect remotely, the policy
applies to that server's worktrees, not to unrelated worktrees on the client device.

## Modes

- **Off** — do not evaluate or remove worktrees. The server may still reconcile interrupted
  removals so recovery is not left blocked. This is the default.
- **Report only** — scan on the configured interval and record qualifying worktrees in the server
  logs without changing them. Use this mode first.
- **Delete** — remove qualifying worktrees after the same checks used by Report only. Enabling this
  mode asks for confirmation because worktree files are permanently removed.

The age rules are combined with OR semantics: a worktree qualifies when it is older than **Maximum
age**, inactive for longer than **Inactive for**, or has a merged pull request when **Delete after
pull request merge** is enabled. At least one rule must be enabled.
The scan interval is limited to one hour through seven days; this controls how often the server
checks, not how long a worktree must be retained.

## Safety checks

Retention is intentionally conservative. A candidate is skipped when T3 cannot prove all of the
following:

- it is a Git worktree created and managed by T3 under the server's managed worktree directory;
- it is not a registered project root or an explicitly unmanaged worktree;
- it is clean and has no active agent run, provider session, runtime request, terminal, background
  process, scheduled run, or shared thread owner; and
- its filesystem and Git state can be read consistently.

Legacy worktrees discovered during reconciliation are recorded for visibility but are not adopted by
automatic deletion. Unknown Git, filesystem, activity, ownership, or pull-request state fails closed. A pull-request
check that cannot reach the configured source-control provider never becomes a delete decision.

Retention removes the worktree directory through Git without force. T3 may then remove a T3-owned
local branch with Git's safe `branch -d` check; Git keeps the branch when that check declines. A
thread whose worktree was removed is marked as purged; sending a follow-up message or opening a
terminal recreates a worktree when its recorded branch is still available. Workspace-file previews
show a typed unavailable state until that recovery happens.

If a purge was interrupted, recovery waits for the server to reconcile the worktree before creating
a replacement. If the branch was safely removed after a merged pull request, T3 reports that the
branch is unavailable instead of using the project root or silently discarding the thread's
dedicated-worktree relationship.

Before enabling Delete mode, use Report only long enough to review the candidates and confirm that
the configured age and inactivity thresholds match the team's expectations. Worktree removal is not
a backup mechanism: commit or preserve anything that still matters before it becomes eligible.
