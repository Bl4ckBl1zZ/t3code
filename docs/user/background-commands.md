# Background commands

Agents sometimes start a command and let it run while they carry on — a test suite, a build, a
review tool, a dev server. The turn can finish before the command does, and the agent will come back
on its own once it has a result.

T3 Code keeps that visible instead of letting the conversation look finished.

## While a command runs

The command keeps its own row in the conversation, shaped like any other tool call, reporting:

- **how long it has been running**, and for a paused command, that it is paused
- **the last line it printed**, plus how long ago that was — the difference between a command that is
  working and one that is stuck
- **why it failed or never got to finish**, once it ends

Open the row to read its exit code and how it ended.

A row stays visible even when the surrounding tool calls collapse, so a long-running command is never
hidden behind "+3 previous tool calls".

Some commands show a progress bar. That only happens when the command declared a timeout, which is
the only case where the remaining time is a real number rather than a guess. A command with no
declared deadline shows elapsed time and its last printed line, and nothing that pretends to be a
percentage.

While a command is running, T3 sends its most recent line and nothing more. A finished command keeps
its exit code and whether it succeeded, not the text it printed. Ask the agent to read a log or
re-run a command when you need the full transcript.

If a command has printed nothing yet, the row says so rather than looking stalled.

## Waiting

When an agent is waiting for something to happen rather than doing work, the row says so and shows
when it will give up. If that wait belongs to a specific command, it appears beneath that command
instead of as a separate process, because you are waiting on one thing, not two.

## While you are elsewhere

A pill above the composer shows how many background commands are running for the open conversation,
with the elapsed time of the oldest. Click it for the latest output of each. When subagents are
working, a pill beside it counts them; click it to see what each agent is doing and open its thread.
The two pills share one panel, so clicking the other pill swaps what it shows. In the React Native
mobile client, tapping either pill opens the conversation's details, which list both. In the
sidebar, a conversation with background work shows a hollow, breathing dot — distinct from the
filled dot of a conversation that is generating right now, and from no dot at all. It means: idle at
the moment, but this one will speak again by itself.

## How commands end

| What you see                            | What happened                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| Only the run time                       | The command completed successfully.                                                |
| `Failed with exit code 1`               | The command failed. This appears whether or not the agent mentions it.             |
| `Stopped when the session ended`        | The provider shut down and took the command with it. Not a failure of the command. |
| `Result unknown after a server restart` | The T3 Code server restarted, so the result can no longer be observed.             |
| `Timed out`                             | A wait reached its deadline without the thing it wanted happening.                 |
| `Stopped`                               | The command was cancelled before it finished.                                      |

Stopping a turn does not stop a command that has been detached from it. The turn stops; the command
keeps running and stays visible. To end it, ask the agent to stop it.

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
