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
- The window is cut in SQL, not after a full read. The server reads every turn item's key (id,
  run, type, ordinal, and the two small fields visibility needs) to find the edge, then reads and
  decodes payloads only for the kept runs. A fork source contributes keys plus the inherited items
  the window keeps, never its whole projection. The full snapshot behind "load earlier" is the same
  read with no window. Turn items come off `(thread_id, run_id)` and the
  primary key, messages off `(thread_id, run_id)`; the tests pin those plans, prove dropped payloads
  are never read, and compare every window size against `windowOrchestrationV2ThreadProjection` on
  the wire. A 4,400-item, 13 MB thread went from ~600 ms to ~100 ms (200-row window).
- Snapshot reads take a deferred `BEGIN`, not the `BEGIN IMMEDIATE` writers use: one WAL snapshot
  across their queries, without holding the write lock for the length of the read.
- Runs, attempts, nodes, provider turns, runtime requests, and checkpoints still go whole, as the
  in-memory window always sent them. Nodes are the largest of these (about one per tool call,
  roughly 1 KB each), so they are the next thing to bound. Trimming them needs keep rules for
  runless and still-running rows and a "load earlier" merge that brings them back, including on
  clients already shipped.
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

When changing projection schemas, windowing, shell synchronization, or thread state, run this
command alongside the focused package typechecks and a real-client pass on every affected surface.
Payload budgets belong in these tests rather than logs or one-off recordings so regressions fail
locally.
