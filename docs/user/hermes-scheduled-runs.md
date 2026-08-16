# Hermes scheduled runs

Hermes owns its own scheduler. A cron job you create — from a Hermes thread, or
from **Settings → Hermes cron** — is stored and run by Hermes, not by T3 Code.

This page is about what T3 Code does with those runs.

## The panel shows what the gateway supports

**Settings → Hermes cron** lists every job on each connected Hermes instance
with its schedule, its next run, and **how its last run ended**. A job whose
last run failed is called out in red with the reason Hermes gave, so a schedule
that has been firing and failing for a week does not read as a healthy one.

Which buttons appear depends on the gateway in front of you. T3 asks it which
cron operations it accepts and offers exactly those — the current Hermes build
supports create, pause, resume, and delete, and does not implement edit or run
now, so those two do not appear.

## Runs appear in the inbox

**Settings → Hermes cron → Runs you did not start** lists every run T3 noticed,
newest first, with how it ended. Selecting one marks it read.

On iPhone and iPad the same list is **Settings → Hermes Runs**, and the row
carries a badge with the unread count. Tap a run to open it; touch and hold one
to mark it unread or dismiss it.

Each entry can be marked read or unread, and dismissed or restored, so nothing
disappears permanently.

T3 finds these by comparing each job's last run against what it recorded on the
previous check, which happens on an interval for as long as the server is
running — no client has to be connected and no window has to be open. A run
that Hermes reports at the same time with a different outcome (a retry that
also failed, say) is reported again rather than swallowed.

## Reading what a run actually did

A Hermes cron job does not run inside a conversation. Each run spawns its own
Hermes session, does its work, and ends — which is why a run is reported from
the schedule rather than streamed into an existing thread.

Those sessions are still real, and **Settings → Hermes → Import sessions**
brings them in as T3 threads with their full transcripts. Scheduled runs show up
there alongside your other Hermes conversations, titled with the job name and
the time it ran.

## Runs that do stream in

Work Hermes starts on a session T3 is already subscribed to — a prompt sent from
another Hermes client, or anything the model keeps doing after a turn settles —
streams into that thread on its own and is written to the transcript like any
other turn. **Proactive mode** is what keeps those sessions subscribed while
nobody is looking. Residency is capped per profile, so on a profile with many
Hermes threads only the most recent are held open.

## Keeping the schedule alive

The schedule runs inside `hermes serve`, so it only fires while that gateway is
up.

If you start Hermes yourself, it keeps running after you quit T3 Code and your
jobs keep firing. If instead you let T3 Code launch it — the **Managed server**
switch on the instance — then the gateway is T3's child process and stops when
T3 does, taking the schedule with it. Run Hermes yourself if you want jobs to
fire while T3 Code is closed.

## What still needs Hermes-side support

The **Proactive delivery** panel labels each instance either **Replays
transcripts** or **Reports runs**. Reports runs means the gateway offers no
durable event cursor — the case for every current Hermes build — so T3 cannot
stream back the moment-by-moment events of a run it was not connected for. It
still reports that the run happened and how it ended, and the transcript is
still importable.
