# Server updates

## Launcher ownership and compatibility

A [stable launcher](../../apps/server/src/serviceLauncher.ts) owns the runtime selected by systemd,
launchd, or Task Scheduler and is the only runtime writer of durable service state. Server children
request updates over inherited IPC and never rewrite their service definition. Foreground CLI
processes do not self-update.

Remote updates replace only the server child, not the launcher, so every existing background service
lags behind after a launcher-protocol bump. Keep new server runtimes compatible with the previous
launcher protocol unless impossible, and validate protocol compatibility during preflight.

Installations use exact versions and stage/preflight before publishing an immutable runtime so
restarts never depend on npm cache eviction or a moving tag.

## Commit boundary and database rollback

1. Record the pending update durably (atomic rename + fsync) before stopping the old child.
2. Refuse the update if a database snapshot will not fit on disk. After the old child exits, snapshot
   SQLite (main, WAL, SHM) once per update so failed trial migrations are reversible without down
   migrations. Never overwrite that snapshot on retry. Files outside SQLite (such as attachments)
   are outside this rollback boundary.
3. Start the new runtime as a trial. It must finish migrations, acquire fallible dependencies, bind
   HTTP, and hold long-running roots at the activation gate before reporting `prepared`.
4. Only after the launcher commits the new version durably and replies `committed` may the child
   release activation gates and accept work. A failed or timed-out trial stops and restores the
   snapshot before booting the old version.

## Client acknowledgement

An accepted update RPC is only pending. Clients correlate the launcher's update ID with the
reconnected ready state to distinguish commit from rollback. Desktop updates use a two-phase handoff
(prepare token while connected, commit after receiving it) because installing stops the bundled
backend.

## Recovering interrupted threads

- On startup, retire effects tied to the lost process before admitting new work.
- Persist restart-continuation intent in the durable outbox and wait for activation before running
  it so slow providers never delay readiness or the launcher's commit boundary.
- Cap consecutive crash recoveries per unfinished turn so a crashing turn cannot loop forever.
- Never auto-continue a turn that is archived, settled, snoozed, user-stopped, or waiting on a
  blocking user action (approval, question, or secret).

## Builds released outside upstream

Only upstream publishes the `t3` CLI (npm package and release archives), so every CLI install path
fetches upstream's build. A build made with `T3CODE_RELEASE_REPOSITORY` set to another repository
(`releaseSourcePublishesCli` in `packages/shared/src/cliRelease.ts`) therefore offers none of them:
`t3 update` points at that repository's releases page instead, and web and mobile offer only
desktop-managed updates, which install from the desktop app's own feed. Mobile reads that
repository's releases with `T3CODE_RELEASE_TAG_PREFIX` (default `v`). Unset, both default to
upstream.
