# Hermes H0 conformance harness

This disposable harness captures protocol evidence from the official `hermes serve` TUI gateway.
It does not enable Hermes in T3 Code and is not a provider adapter.

The only accepted source revision is:

```text
2c1a38a3cc4b5727c817f007a46c377cafddde4c
```

The locally carried Hermes 0.19.0 is not evidence for this pin. Launch mode verifies that the
supplied checkout has the exact Git revision, no modified/untracked files or ignored Python outside
`.venv`, and the expected gateway source files. It then uses that checkout as the complete
`PYTHONPATH`, disables user site packages, records the interpreter/dependency fingerprint, creates a private temporary
Hermes profile and working directory, chooses a loopback port and session token, and starts
`hermes serve --isolated --skip-build` in an owned process group. Attach mode is strictly read-only
even when mutation environment variables are set, and remains fail-closed on runtime revision
because `gateway.ready` does not report a build revision.

Before launch-mode evidence is finalized, the harness snapshots the full descendant PID tree,
signals both the main process group and separately detached descendants, escalates survivors, and
passes cleanup only after every snapshotted PID has disappeared. Platforms without process-tree
inspection fail this critical probe rather than assuming cleanup.

## Prepare the pinned checkout

Create a disposable checkout outside this repository and install its dependencies into a virtual
environment. The harness defaults to `<checkout>/.venv/bin/python`; set
`HERMES_CONFORMANCE_PYTHON` when the interpreter lives elsewhere.

```bash
git clone https://github.com/NousResearch/hermes-agent.git /tmp/hermes-h0
git -C /tmp/hermes-h0 checkout --detach 2c1a38a3cc4b5727c817f007a46c377cafddde4c

vp run hermes:conformance -- \
  --mode launch \
  --source /tmp/hermes-h0 \
  --output /tmp/hermes-h0-evidence
```

The `--output` directory receives only sanitized JSONL and Markdown. Unsanitized frames and
`hermes serve` logs stay in a mode-0700 temporary directory printed at the end of the run. Inspect
raw capture locally; never add it to the repository. Each report records a SHA-256 fingerprint of
the two executable harness source files plus a path-free summary of the invocation gates, so
evidence can be tied to the implementation that produced it.

For an already-running loopback gateway:

```bash
vp run hermes:conformance -- \
  --mode attach \
  --url 'ws://127.0.0.1:9119/api/ws?token=CALLER_CHOSEN_TOKEN' \
  --output /tmp/hermes-h0-attached
```

Loopback WebSocket auth uses the caller-chosen `HERMES_DASHBOARD_SESSION_TOKEN` as the `token`
query parameter. Remote endpoints and credential-bearing non-loopback connections are outside H0.

## Probe gates

Read-only inventory probes run by default. Launch-mode mutations are confined to the disposable
profile and working directory and still require explicit opt-in:

```bash
HERMES_CONFORMANCE_ALLOW_MUTATIONS=1 vp run hermes:conformance -- ...
```

Mutation opt-ins never enable attach-mode writes.

The official `HERMES_ISO_CERTIFY_SYNTH_TURN=1` seam is used by launch mode unless live execution is
enabled. Independent probes validate session-correlated message ordering and interrupt behavior
without an LLM. It does **not** persist transcript messages: empty `session.history` and
`session.list` after a synthetic turn are expected, so durable transcript recovery remains blocked.

Real provider/tool execution requires both mutation and live opt-ins. The rich-event prompt must
be reviewed by the operator because it may invoke tools or request approval:

```bash
HERMES_CONFORMANCE_ALLOW_MUTATIONS=1 \
HERMES_CONFORMANCE_ALLOW_LIVE=1 \
HERMES_CONFORMANCE_TOOL_PROMPT='REVIEWED DISPOSABLE TOOL SCENARIO' \
HERMES_CONFORMANCE_APPROVAL_PROMPT='REVIEWED DISPOSABLE APPROVAL SCENARIO' \
HERMES_CONFORMANCE_CLARIFICATION_PROMPT='REVIEWED DISPOSABLE CLARIFICATION SCENARIO' \
vp run hermes:conformance -- ...
```

Each live scenario is independent; approval and clarification observations are interrupted instead
of being answered without a stable request identity. Cron creation/removal additionally requires
`HERMES_CONFORMANCE_ALLOW_DESTRUCTIVE=1`. The harness uses a unique disposable name, removes the
canonical returned job ID, and verifies absence from a final list, but keeps this probe separately
gated because it mutates scheduler state.

## Interpretation

Each probe is classified `passed`, `failed`, `blocked`, or `indeterminate`. The command exits
non-zero for any failure or any security-critical result that is not `passed`.

Known pinned-protocol blockers are recorded rather than papered over:

- `gateway.ready` contains only `{skin}`; there is no negotiated version/capability inventory.
- Durable identity is profile plus `stored_session_id`/session key; the live session ID is
  ephemeral.
- `session.branch` branches the latest head only.
- There are no stable mutation, event, message, or run IDs.
- `approval.respond` has no approval request ID.
- There is no per-session MCP registration/revocation, writer fencing, or durable global cron
  event cursor.

## Requests the gateway cannot take an answer to

Pushing `approval.request` and `clarify.request` is not the same capability as accepting a response
to them. `approval.respond` needs `events.approvals` and `clarify.respond` needs
`events.clarification`, and both are Tier 2 — a non-advertising gateway never earns them from a
probe (see `HermesGatewayClient`). A gateway can therefore park a run on a decision it has no method
to receive, which is the shape a legacy gateway actually has.

The adapter reads that pair off the negotiated inventory per connection and projects it onto the
session's capabilities, so `supportsCommandApproval` and `supportsStructuredQuestions` describe the
gateway in front of it rather than the protocol at its best. When the response method is missing:

- The request is still projected, so the command or question stays on the record.
- It is marked `not_resumable` with the missing capability named, settled immediately, and the turn
  fails with the same reason instead of waiting on an answer that could never be delivered.
- The run is interrupted on the gateway, because Hermes holds it open until someone responds.

The same reasoning governs teardown. A Hermes session outlives the T3 process driving it, so
releasing a session — including on server shutdown, which closes provider sessions before
reconciling the projection — interrupts any run still parked on a request. Without that the gateway
would sit blocked on a prompt whose only reader has exited, since the request identity was live-only
and no restart can re-adopt it.

Answering is refused when more than one approval is outstanding on a session. `approval.respond`
names a session, not a request, so with two in flight there is no way to say which one a decision
belongs to.

## Proactive delivery boundary

Hermes runs work that T3 never prompted: cron jobs, and prompts sent to the same session by another
Hermes client. Those runs stream on the gateway socket like any other, so when the instance's
**Proactive mode** switch is on the adapter buffers their events and asks the orchestrator for a
continuation turn (the same
`ProviderContinuationRequests` path Claude uses for background-task wakes). The run is projected
into the T3 thread as a normal turn, with no prompt submitted and no durable mutation intent to
settle — nobody has to send a message for the conversation to move.

Delivery is therefore live-only, and bounded by two pinned-protocol facts:

- There is no durable global cron event cursor, so a run that happens while T3 is not connected
  cannot be replayed afterwards. `hermes_proactive_sources` records that state per gateway
  (`missing_durable_global_cursor`) instead of pretending the backfill happened; the durable
  ingest path in `HermesProactiveEventRepository` stays inert until a gateway advertises
  `cron.events.global_cursor` and `events.stable_ids`.
- Cron rows are not required to name the session a job runs in. When they do, T3 keeps exactly
  that thread subscribed; when they do not, it falls back to the most recently used threads on the
  profile, capped, and says so in the proactive status.

Buffered events are trimmed once a continuation that never attaches grows past its limit, which
costs transcript detail. `approval.request` and `clarify.request` are exempt: dropping one opens the
continuation turn with nothing to answer while the gateway stays parked on it. With proactive mode
off, an external run carrying a request is logged and left alone — it belongs to whoever started it,
so T3 neither answers it nor stops it on their behalf.

Because T3 retires idle provider sessions, being connected is not automatic. `HermesProactiveService`
re-establishes residency on an interval for instances with proactive mode enabled, and the adapter
reports an in-flight external run as pending background work so idle release cannot drop the
subscription mid-wake. Runs on a gateway that T3 has never opened, or that occur while the server is
stopped, are missed by design rather than silently.

## H5 import boundary

The pinned `session.list` method is sufficient for profile-scoped, most-recent-first discovery. It
returns a durable session ID, title, preview, start timestamp, message count, and source. T3 may
therefore create a lazy historic shell and bind that durable ID without resuming or reading the
transcript during bulk import. Opening the shell uses the existing guarded `session.resume` plus
`session.history` path.

Two child-session capabilities remain explicitly unavailable:

- `session.list` does not return `parent_session_id`, so imported child lineage cannot be recovered
  without guessing from titles or timestamps.
- `session.branch` copies only the latest live head and accepts no stable source message/run
  boundary, so arbitrary historic child copying is not replay-safe.

The H5 API reports both limitations as capability state. It does not manufacture lineage or offer
an action that the pinned protocol cannot perform safely.

T3 therefore keeps `supportsMcpTools` false for Hermes and does not mint or pass a T3 MCP bearer
credential when opening a Hermes provider session. The adapter checks negotiated capabilities for
the complete `mcp.session.register`, `mcp.session.replace`, and `mcp.session.revoke` set and emits an
audit-safe blocked diagnostic when Hermes MCP integration is requested. Even if a future gateway
advertises all three, T3 remains blocked
until the corresponding request/response contracts and lifecycle behavior are implemented and
conformance-tested. A global Hermes MCP configuration or permanent shared token is never used as a
fallback.

Reads may be retried. If a connection is lost after any write is sent but before its result is
observed, the harness records `indeterminate`, stops automatic writes, reconnects, and performs
`session.list` reconciliation only. `session.resume` is classified as a mutation and is not used
after ambiguous admission. The harness never replays an ambiguous prompt, fork, title, approval,
attachment, or cron mutation.

Sanitized fixtures use an allowlist: protocol methods/event types, booleans, selected protocol
counts, safe enums, and salted correlation pseudonyms are retained. Unknown strings, numbers,
field names, titles, URLs, tool arguments/results, errors, and full filenames/paths are redacted.
Raw frames remain private.

The generated report is evidence, not an H0 acceptance claim. Blocked scenarios need a real
pinned live capture or an upstream protocol change before later Hermes integration work can rely
on them.
