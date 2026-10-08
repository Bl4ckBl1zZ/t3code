# Performance regression checks

The v2 transport has a focused regression command:

```bash
vp run test:perf:v2-wire
```

It exercises the real v2 projection and client reducers. This matters because the older
built-app benchmark fixtures seed v1 orchestration events; running those fixtures against a v2
client can produce reassuring timings while missing the active transport path.

The v2 checks pin these invariants:

- Cold opens send a bounded timeline window: clients ask for the last N visible rows via
  `snapshotMaxVisibleItems` (WebSocket) or `maxVisibleItems` (HTTP), and the server reports what it
  dropped in `truncatedVisibleItemCount` so the client can offer to load the rest.
- The window never splits a run across its edge, because turn-item visibility pairs items within a
  run (an interrupt result is only visible next to its request).
- Resume catch-up replays at most 128 thread events and 1 MiB of projected event JSON before
  replacing stale state with a current snapshot. The sequence gap alone is not enough: a handful of
  large tool outputs outweighs a thousand small status updates.
- Oversized dynamic-tool results and detail strings are reduced only at the wire boundary; the
  persisted event remains complete.
- Shell resume sends deltas plus compact repository-enrichment metadata, not another full project
  and thread snapshot. Enrichment frames are metadata-only at any sequence, so a trimmed frame can
  never replace the client's project, thread, or archive lists.
- An enrichment refresh publishes only when its answer changed, and an expired answer keeps being
  served while it refreshes. Each published change makes every live shell subscriber reload the
  full snapshot, so republishing unchanged answers on every cache TTL kept those reloads running
  forever.
- The server's SQLite driver is synchronous, so a slow query stalls every client, not just its
  caller. The shell query stays index-driven per thread (a partial index for live background
  commands, a pinned join order for the last provider error) and carries only the latest message's
  preview. On a 760-thread store it went from ~2s to ~0.1s.
- A live shell subscription reads a thread's shell only for events that can change it. Attempt,
  node, provider-turn, checkpoint, and context handoff/transfer events are skipped before any read
  (`canChangeShell`), and a test keeps the shell query off those tables. The read itself goes
  through `LiveThreadShells`, one per environment: every subscriber, active and archive, shares
  one read per thread change instead of running its own in every 50 ms window.
- Shell resume within the replay gap loads project identities for its metadata frame and nothing
  else. It never builds the thread shell snapshot the resuming client already holds.
- Background sweeps never build the full shell snapshot. Settlement, auto-delete, pull request
  sync and watch, and branch pull request discovery list their candidates with
  `ProjectionStore.listThreads`, one statement over the thread table with no per-thread lookups
  (EXPLAIN QUERY PLAN tests pin this), then read shells only for the threads they act on, each in
  its own short transaction. A thread's own events re-decide only that thread.
- Limit recovery runs every five seconds, so its candidate query probes the runs index for a
  failed run before any latest-run or error lookup.
- Read paths stay out of long transactions rather than changing how the shared client begins
  them. There is one connection behind one permit, so a read transaction's cost is how long it
  holds that permit; `BEGIN IMMEDIATE` only adds a cross-process write lock, which other processes
  rarely contend for. Single-statement reads such as `listThreads` use no transaction.

When changing projection schemas, windowing, shell synchronization, or thread state, run this
command alongside the focused package typechecks and a real-client pass on every affected surface.
Payload budgets belong in these tests rather than logs or one-off recordings so regressions fail
locally.
