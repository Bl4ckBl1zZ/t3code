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
