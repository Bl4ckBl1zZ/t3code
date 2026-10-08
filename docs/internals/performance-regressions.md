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
  large tool outputs outweighs a thousand small status updates. Nor is it a reason to snapshot:
  sequences are global, so a thread that sat idle while others ran is far behind in sequence but
  has nothing to replay. The catch-up read itself (129 rows on the thread's stream index) decides.
- Live thread delivery keeps up with a slow link instead of queueing behind it. `RpcServer` sends
  one stream chunk and waits for the client's ack before pulling the next, so throughput is one
  frame per round trip; a T3 Connect phone falls behind a provider that republishes a whole message
  every 50 ms. `streamThreadLiveFrames` (`ThreadStreamFrames.ts`) drains the subscription as events
  are published and sends everything queued as the next frame:
  - Undelivered full-state updates that a later event of the same type for the same entity
    overwrites are dropped. The list of such types, and why runs, attempts, provider sessions and
    turns, checkpoints, creation and deletion are not on it, lives in
    `@t3tools/shared/orchestrationV2EventSupersession`. An entity's first event in a frame is kept
    until the entity has been delivered once, because clients append unseen entities and arrays such
    as `messages` are read by position. Applying the coalesced stream must give the same projection
    as applying every event; `threadStreamSupersession.test.ts` checks that with the real reducer.
  - Survivors keep their own sequences, in order, so a frame still ends with its highest sequence.
    Every thread client must therefore treat a thread stream's sequences as a cursor that may skip
    values, never as consecutive. Web, desktop, and React Native skip anything at or below their
    cursor; the SwiftUI client compares against its highest applied sequence.
  - When the queued survivors exceed the resume budget (128 events or 1 MiB of projected JSON), the
    queue is dropped and the next frame is one `snapshot` item, windowed by the subscription's
    `snapshotMaxVisibleItems`. Delivery continues after the snapshot's sequence. The snapshot is
    read only when the client asks for its next frame, so a client that keeps up never costs one,
    and a stalled one costs at most one per frame it acknowledges.
- Thread-scoped event-sink streams subscribe to their own thread's PubSub. Through the shared one,
  every open thread, desktop keep-alive, and wait received and filtered every thread's events: with
  50 subscribers, delivering 20,000 events to one of them took 1.2 s instead of 57 ms.
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
- Reads of `orchestration_events` name their index (`INDEXED BY`) and never filter with
  `? IS NULL OR column = ?`. Installs are not ANALYZEd, and without statistics SQLite reads one
  thread's events through the `(application_event_version, sequence)` index, walking every V2 event
  after the cursor: ~20s cold for an idle thread 836k events behind, against ~0.5ms on the stream
  index. Pinning also keeps a future `ANALYZE` from flipping a plan. `OrchestrationEventStore.test.ts`
  asserts each read shape's plan.
- Thread mutations that decide from the thread row (visit, rename, pin, unarchive) read only that
  row. The full thread projection decodes the transcript and every fork ancestor's, so the
  orchestrator loads it only for the decisions that inspect runs, requests, sessions, or messages.
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
- Older versions are found by seeking one partial expression index from migration 068,
  `idx_orch_events_versions` on `(event_type, json_extract(payload_json, '$.id'), sequence)`,
  covering the snapshot and thread-state types. A thread-state payload's id is the thread id. The
  queries repeat the index's WHERE terms literally, or SQLite cannot use it. The other side of each
  comparison must be affinity-free: compare against a `json_extract` result, not a column.
- Every read pins its access path with `NOT INDEXED` (rowid range) and `INDEXED BY` (version
  lookups). Left to itself, the planner preferred walking a whole index over the bounded range, with
  or without statistics. `ProjectionMaintenance.test.ts` asserts the plans.

Measured on a copy of a 6.6 GB store with 788k events: migration 068 builds the index in ~3s warm
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
