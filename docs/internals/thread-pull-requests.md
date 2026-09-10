# V2 thread pull requests

The V2 JSON thread projection optionally carries `linkedPullRequests`. An absent
collection falls back to `linkedPullRequest`; an empty collection is explicit.
The primary field mirrors the first collection entry for older clients.

`thread.metadata.update` accepts one of `linkPullRequest`, `unlinkPullRequest`,
or the legacy `linkedPullRequest` edit. The orchestrator applies the edit to the
latest projection under its existing dispatch serialization. Links deduplicate
by URL host, repository and number, with at most 50 entries. A legacy replacement
or removal changes only its primary entry, retaining additional links.

Swift gates collection editing on `threadPullRequestsV2` and polls every link for
visible tasks. Its aggregate remains nonterminal when any request is open or a
read fails. Changing the collection restarts subscriptions and drops the prior
aggregate seed. Web/Expo continue showing the primary; their shared settlement
helper declines primary-only automatic settlement for a collection.

`pullRequests.stack` reads a GitHub stack on demand. Other providers return null.
`pullRequestStackActions` gates the native UI. `pullRequests.runAction` accepts
`stackNumber` and `expectedStackHeads`; the GitHub boundary re-reads membership,
checks revisions and branch permissions, and performs remote-only mutations.
All reviewed references are invalidated even on partial failure. Native action
confirmation holds an immutable reviewed stack and refreshes after dismissal.

This does not implement upstream's automatic PR discovery/linking, stack link
tombstones, MCP linking tools, or restart-persistent summary cache. It adds no
SQLite migration or V1 thread-runtime dependency.
