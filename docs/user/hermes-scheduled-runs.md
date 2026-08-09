# Hermes scheduled runs

Hermes owns its own scheduler. A cron job you create — from a Hermes thread, or
from **Settings → Hermes cron** — is stored and run by Hermes, not by T3 Code.
That means the schedule keeps running whether or not T3 Code is open.

This page is about what T3 Code does with those runs when they finish.

## Runs appear in the thread

When proactive mode is on for a Hermes instance, T3 Code keeps that profile's
Hermes threads subscribed to the gateway. A run that starts without anyone
sending a message — a cron job firing, or a prompt from a different Hermes
client on the same session — streams into the thread on its own and is written
to the transcript like any other turn.

## Runs also appear in the inbox

**Settings → Hermes cron → Runs you did not start** lists every run T3 Code
noticed that nobody was waiting for, newest first, with the first part of the
reply. Selecting one opens the thread it landed in and marks it read.

On iPhone and iPad the same list is **Settings → Hermes Runs**, and the row
carries a badge with the unread count. Tap a run to open its thread; touch and
hold one to mark it unread or dismiss it.

Each entry can be marked read or unread, and dismissed or restored, so nothing
disappears permanently.

## What happens while T3 Code is closed

Hermes runs the job as scheduled, but no client is listening. The pinned Hermes
gateway protocol has no way to replay events after the fact, so T3 Code cannot
recover those transcripts.

What it does instead: on the first check after starting up, T3 Code compares
each job's last run time against the value it recorded before. A job whose last
run moved gets an inbox entry saying it ran while T3 Code was closed. You will
know it happened and which thread it belongs to; the run's own output stays in
Hermes.

The same applies to a run that lands on a session T3 Code is not subscribed to.
Residency is capped per profile, so on a profile with many Hermes threads, a job
running in a thread outside that set is reported this way rather than streamed.

## What still needs Hermes-side support

The **Proactive delivery** panel labels each instance either **Durable replay**
or **Live only**. Live only means the gateway does not advertise a durable
global cron cursor, which is the case for every current Hermes build. Until a
gateway offers one, T3 Code can report that a missed run happened but cannot
reconstruct what it said.
