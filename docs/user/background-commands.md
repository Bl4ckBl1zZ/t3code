# Background commands

Agents sometimes start a command and let it run while they carry on — a test suite, a build, a
review tool, a dev server. The turn can finish before the command does, and the agent will come back
on its own once it has a result.

T3 Code keeps that visible instead of letting the conversation look finished.

## While a command runs

The command keeps its own row in the conversation, reporting:

- **how long it has been running**, and for a paused command, that it is paused
- **the last line it printed**, plus how long ago that was — the difference between a command that is
  working and one that is stuck
- **its exit code** when it finishes, or why it never got to finish

A row stays visible even when the surrounding tool calls collapse, so a long-running command is never
hidden behind "+3 previous tool calls".

Some commands show a progress bar. That only happens when the command declared a timeout, which is
the only case where the remaining time is a real number rather than a guess. A command with no
declared deadline shows elapsed time and its output, and nothing that pretends to be a percentage.

If a command has printed nothing yet, the row says so rather than looking stalled.

## Waiting

When an agent is waiting for something to happen rather than doing work, the row says so and shows
when it will give up. If that wait belongs to a specific command, it appears beneath that command
instead of as a separate process, because you are waiting on one thing, not two.

## While you are elsewhere

A strip above the composer shows how many background commands are running for the open conversation,
with the elapsed time of the oldest. Expand it for the full detail of each. In the sidebar, a
conversation with background work shows a hollow, breathing dot — distinct from the filled dot of a
conversation that is generating right now, and from no dot at all. It means: idle at the moment, but
this one will speak again by itself.

## How commands end

| What you see                                     | What happened                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `finished exit 0`                                | The command completed successfully.                                                |
| `failed exit 1`                                  | The command failed. This appears whether or not the agent mentions it.             |
| `stopped when the session ended`                 | The provider shut down and took the command with it. Not a failure of the command. |
| `outcome unknown, server restarted while it ran` | The T3 Code server restarted, so the result can no longer be observed.             |
| `gave up waiting`                                | A wait reached its deadline without the thing it wanted happening.                 |

Stopping a turn does not stop a command that has been detached from it. The turn stops; the command
keeps running and stays visible, and you can stop it from its own row.

## What each provider can show

Providers expose different things, and the display follows what is actually knowable:

- **Claude** identifies a background command and streams it to a file, so T3 Code can show a live
  tail and an exit code. A command Claude runs in the foreground reports nothing until it exits, so
  those rows show elapsed time and, where a timeout was set, a progress bar.
- **Codex** streams a running command's output as it arrives, so its rows show a live tail. Codex has
  no notion of detaching a command from a turn, so a long command holds the turn open while it runs.
  A command Codex starts with a trailing `&` returns immediately and cannot be tracked at all — the
  row reports the shell's own exit, which is usually `0`, and says nothing about the process left
  behind.
