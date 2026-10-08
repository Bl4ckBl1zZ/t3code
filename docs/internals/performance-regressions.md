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

When changing projection schemas, windowing, shell synchronization, or thread state, run this
command alongside the focused package typechecks and a real-client pass on every affected surface.
Payload budgets belong in these tests rather than logs or one-off recordings so regressions fail
locally.

## Event-store growth and compaction

Every live update is a committed event: subscribers receive what the event sink commits, and clients
resume by sequence. Streaming items are therefore persisted as full-state snapshots at the
provider's flush cadence (Codex: assistant text every 50ms, command output every 500ms), so an
item's stored bytes grow with the square of its length. On a 6.6 GB store, superseded snapshots
were ~60% of the last week's event bytes; nearly all of the rest was each entity's latest state.

Persistence cadence stays as it is. Coarsening it would coarsen live updates too, or need an
unsequenced side channel in every client. Instead compaction removes superseded copies soon after:

- **Streaming snapshots** (`turn-item.updated`, `message.updated`, `node.updated`): once the newer
  version is an hour old, older versions go. Turn items keep their first event too, which anchors
  `turn_item_positions` on rebuild. `subagent.updated` is excluded because its projection carries
  `completionDelivery` forward from earlier versions.
- **Thread-state events** and **imported legacy v1 rows** keep the 7-day history window.

Invariants: a version is only deleted when a newer version of the same entity is committed, and the
newest is never deleted. A client resuming from any sequence still converges to every entity's
latest state, rebuild reproduces the projections, and an item still streaming when the server dies
keeps its last persisted snapshot.

Compaction must never freeze the server. The previous passes were single statements that ran
`json_extract` over every row: 1.4-2.3s per snapshot pass and 22s for the thread-state pass on the
6.6 GB store, far longer from a cold page cache. Now:

- Each pass walks the log from a persisted cursor (`orchestration_event_compaction_cursors`) in
  ranges of 500 sequences. Each range is one transaction and the pass yields between ranges.
  Steady-state runs (every 30 minutes) read only events appended since the last run.
- Older versions are found by seeking one partial expression index from migration 067,
  `idx_orch_events_versions` on `(event_type, json_extract(payload_json, '$.id'), sequence)`,
  covering the snapshot and thread-state types. A thread-state payload's id is the thread id. The
  queries repeat the index's WHERE terms literally, or SQLite cannot use it. The other side of each
  comparison must be affinity-free: compare against a `json_extract` result, not a column.
- Every read pins its access path with `NOT INDEXED` (rowid range) and `INDEXED BY` (version
  lookups). Left to itself, the planner preferred walking a whole index over the bounded range, with
  or without statistics. `ProjectionMaintenance.test.ts` asserts the plans.

Measured on a copy of a 6.6 GB store with 788k events: migration 067 builds the index in ~3s warm
(~25s from a cold disk cache, once, before the server listens). The first compaction run deleted
113k events (186 MB of payload, 573 MB of pages) in 14s, with no statement over 35ms and no
event-loop stall over 60ms. The next run took 2ms. Replaying the 12 busiest threads from the
compacted log reproduced their projection tables byte for byte, and every entity's newest event
(and every turn item's first) survived. With the earlier 2,000-sequence ranges and a cold cache,
stalls reached 515ms, which is why ranges are 500.

Planner statistics: `sqlite_stat1` now exists (`PRAGMA optimize` at open and after compaction). With
`analysis_limit = 400` the sample is the first entries of each index, so low-cardinality leading
columns are underestimated, for example `aggregate_kind` at 201 rows per value against a real
390k. Do not count on statistics to pick a plan for a hot query: pin it, and check its plan on a
copy of a large real store.
