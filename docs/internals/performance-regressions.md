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

When changing projection schemas, windowing, shell synchronization, or thread state, run this
command alongside the focused package typechecks and a real-client pass on every affected surface.
Payload budgets belong in these tests rather than logs or one-off recordings so regressions fail
locally.
