# V2 thread pull requests

The V2 JSON thread projection optionally carries `pullRequests`: canonical host/repository/number
identity, source (`manual`, `created`, `agent`, `stack`, `stack-dismissed`), link timestamp,
host snapshot and native stack membership. Missing metadata upgrades from the fork's older
`linkedPullRequests`/`linkedPullRequest` fields. An empty collection is authoritative.
Derived legacy fields exclude dismissed members and select the highest open chain layer,
then the latest terminal request. Azure legacy references retain their short repository selector.

`thread.metadata.update` applies one link/unlink/snapshot edit to the latest projection under
V2 dispatch serialization. It permits 50 visible links and 100 retained records including stack
tombstones. Unlinking a known native-stack member keeps a tombstone; automatic discovery cannot
revive it, but explicit user/agent linking can. Snapshot writes carry the original link version.
Stack additions also guard their anchor and project; removed or relinked anchors reject stale
work. Background-only writes preserve `updatedAt` so polling does not become user activity.
No SQLite migration or V1 thread-runtime dependency is needed.

`ThreadPullRequestReactor` runs after recovery and discovers `branchPullRequest` independently
of explicit links. It reads a saved branch without checking it out, groups shared contexts,
checks remote identity again before writing, and guards branch/project/worktree changes.
Settled threads receive bounded startup backfill; active threads refresh every minute and after
relevant V2 lifecycle/checkpoint events. Explicit manual links remain authoritative.

`PullRequestSyncReactor` groups visible links across threads, shares one host read per PR,
writes only changed fields, and auto-links native-stack siblings. Open active links refresh
once a minute; closed or settled links slow to 15 minutes; merged snapshots remain terminal
until explicitly refreshed. Failed stack reads preserve prior membership and retry. Requests
arriving during a host read are retained, and queued sweeps coalesce. Both workers expose drains.

Summary/stack reads reuse the fork's restart-persistent cache (one minute), independently of
15-second detail reads. GitHub summary reads bypass detail permissions, base comparisons and
viewer lookups. Internal hosted references can read another repository on a configured host;
Azure requires an exact matching checkout. Hostless public references keep their existing
project/repository validation. Git branch discovery shares status caching and provider-error
backoff, including remote-repoint checks and successful-empty-cache refreshes.

MCP exposes `link_pull_request`, `unlink_pull_request`, and `list_thread_pull_requests` under
the `pull-requests` credential capability. Every operation is scoped to the credential's V2
thread and changes only the local association; no PR is created or mutated on the host.

Web sidebar/command-palette badges use persisted linked snapshots. The web collection and
Swift linked-PR sheet display sources, cached state, checks, diff counts, and native/derived
chain order. Native mirrors are covered by generated wire fixtures and host-side ordering tests.
Swift still uses its existing visible-task host subscriptions for automatic settlement;
server settlement, full hosted-reference detail routing and richer sidebar stack badges remain
separate parity work. Expo retains compatibility through the derived legacy references.

`pullRequests.stack` also supports on-demand hydrated stack details. `pullRequestStackActions`
gates reviewed remote-only merge/rebase controls. Mutations carry immutable `expectedStackHeads`,
re-read membership/revisions/permissions, and invalidate reads even after partial failure.
