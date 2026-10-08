# Database maintenance

> For maintainers. Using T3 Code? See [docs/user](../user/).

All server state lives in one SQLite file, `<T3 home>/userdata/state.sqlite`, served through one
synchronous connection. Anything that holds that connection for long freezes every client, so the
server only does maintenance in bounded steps. This page covers what runs on its own and the one
step that has to be done by hand.

## What runs automatically

- **Planner statistics.** Every connection runs `PRAGMA analysis_limit = 400` and
  `PRAGMA optimize = 0x10002` after migrations, and event-store compaction runs `PRAGMA optimize`
  again after each pass.
  The first run on a store that was never analyzed samples every index (~1s warm and ~12s from a
  cold disk cache on a 6.6 GB store); after that it takes under a millisecond unless a table's row
  count moved by about 10x.
- **Event-store compaction** every 30 minutes, starting shortly after boot. See
  [Performance regressions](../internals/performance-regressions.md#event-store-growth-and-compaction).
- **Returning free pages to the filesystem**, only on databases created with
  `auto_vacuum = INCREMENTAL`. New databases get it from their first open. After each compaction
  pass the server runs `PRAGMA incremental_vacuum` 2,048 pages (8 MiB, ~35ms) at a time until the free list
  is empty.

## Shrinking an older database

Databases created before incremental auto-vacuum keep their size: compaction frees pages inside the
file and new writes reuse them, so the file stops growing, but it does not shrink. The server logs
`state.sqlite has substantial reclaimable free space` once a pass leaves 512 MiB or more free.

Only a full `VACUUM` shrinks the file and switches it to incremental mode. It rewrites the whole
database and holds an exclusive lock throughout (about 40-70s for a 6.8 GB store on an Apple Silicon
SSD), so the server never runs it. On that store, after compaction, it shrank the file from 6.8 GB
to 5.7 GB. To do it by hand:

1. Quit T3 Code (desktop app, `t3` CLI server, or background service). Nothing may have the file
   open.
2. Make sure free disk space exceeds the database size; `VACUUM` writes a full temporary copy.
3. Run:

   ```sh
   sqlite3 ~/.t3/userdata/state.sqlite "PRAGMA auto_vacuum = INCREMENTAL; VACUUM;"
   ```

4. Start T3 Code again. From then on, compaction returns freed space automatically.

Never run this against a database a server is using. The `VACUUM` waits on the server's locks and
the server's own writes start failing once their 5s busy timeout runs out.
