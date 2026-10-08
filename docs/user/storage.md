# Disk Space

T3 Code keeps your threads, settings, and history in one database in its data folder
(`~/.t3/userdata/state.sqlite` by default). It tidies that database in the background while it runs.

## What T3 Code cleans up on its own

While an agent works, T3 Code saves streaming replies and command output many times over, so
nothing is lost if it stops mid-turn. About an hour after an item finishes, T3 Code drops the
in-between copies and keeps the final one. Other history is kept for a week before older copies go.
Your conversations, settings, and project files are never removed.

The first start after updating to this version can take a few extra seconds on a large history
while T3 Code builds what it needs to do this.

## Why the file may not shrink

Databases created by this version or later give freed space back to your disk automatically.

An older database stops growing, because new data reuses the freed space, but it keeps its current
size. To shrink it once and give space back automatically from then on:

1. Quit T3 Code completely, including any background service or `t3` server using this data folder.
2. Make sure you have at least as much free disk space as the database file takes.
3. In a terminal, run:

   ```sh
   sqlite3 ~/.t3/userdata/state.sqlite "PRAGMA auto_vacuum = INCREMENTAL; VACUUM;"
   ```

   On a database of several gigabytes this takes a minute or two.

4. Start T3 Code again.

Never run this while T3 Code is open.
