# Hermes integration

Hermes Work uses the native desktop backend: dashboard HTTP operations for management and `/api/ws` JSON-RPC for conversations. The T3 environment is the access boundary for every client. Web, desktop, React Native, and SwiftUI do not connect directly to Hermes.

The existing Work / Code / Chat switcher is retained. Work uses the shared thread sidebar and composer rather than a separate dashboard. Each new thread creates a native Hermes session; reopening it reuses its durable session binding. Assistant and schedule management lives in Settings. Assistant profile selection and native session bindings operate below that navigation boundary.

## Ownership

Hermes owns profiles, memory, skills, sessions, schedules, execution, and external message delivery. T3 owns environment authorization, the client-facing projection, thread associations, and synchronized records used to show work across devices.

Each record is scoped by provider instance and profile. A native session opened in T3 reuses its durable binding. Creating another conversation in that profile is an explicit operation, never a reconnect side effect.

Thread details resolve the native session through that binding. The workspace comes from native session metadata, not the T3 routing project's directory. Scheduled tasks appear as linked only when native metadata, a successful structured schedule-creation tool result, or a synchronized run establishes the association; sharing an assistant profile alone does not establish ownership. Details load when opened and refresh on native schedule/session changes and completed thread activity. They are not added to every thread's sidebar payload.

Native schedules have one executor: Hermes. T3 does not schedule duplicate prompts for them. Existing T3 scheduled tasks remain independent for other providers.

## Connection and lifecycle

The management transport resolves the configured connection through the environment's provider directory. It authenticates requests with a bearer token and does not forward credentials through redirects. Remote WebSockets acquire a single-use dashboard ticket over HTTPS. Local Serve connections use the native local token mechanism.

Local backend startup is serialized per endpoint so opening management and refreshing provider inventory cannot launch competing backends. The runtime only stops a process it owns.

T3 does not set `HERMES_DESKTOP=1`: that upstream mode also performs orphan gateway cleanup. The native background gateway is controlled explicitly through its management operations. Chat connectivity and scheduler availability are distinct states.

## Setup

The explicit setup action runs in the selected T3 environment. It discovers the Hermes command, installs from the official pinned bootstrap only when absent, stores a generated sensitive local token, and enables managed startup. Setup chooses a dedicated local endpoint for a new connection and preserves explicit existing connection settings.

Installation and connection checks run in the server lifetime, so a client can reconnect and read progress without restarting setup. An authenticated backend alone is not proof of a usable model: setup checks native model configuration and reports a separate model-account step when needed. Native device-code sign-in keeps account credentials on the environment; clients receive only the verification URL and user code.

The official [installation guide](https://hermes-agent.nousresearch.com/docs/getting-started/installation) states: “The installer handles everything automatically”. T3 invokes the bootstrap's unattended installation stages and handles interactive account setup through Hermes's native dashboard APIs.

## Conversations and recovery

The WebSocket client recognizes the native ready payload, decodes newline-delimited JSON-RPC messages, maintains the heartbeat when advertised, and tracks event sequences when replay is available. It does not infer capabilities by sending speculative mutations.

On reconnect, session event replay recovers available activity when the backend supports it. Earlier native backends without replay metadata use history reconciliation. An epoch change or truncated replay triggers history reconciliation. The adapter does not resend the user's prompt to recover a connection. When saved history cannot establish completion, it preserves that uncertainty.

Input requests and live tool activity use T3's existing orchestration path. Native profile identity is retained in the session binding, including when a conversation was selected through management.

Native `thinking.delta` events carry live activity labels, not reasoning content. The provider session's optional `activityText` carries that label to the existing working indicator and clears when the activity ends. These events neither create reasoning items nor trigger external continuations. Actual reasoning comes from `reasoning.delta` and `reasoning.available`.

Changing a conversation's model uses native `config.set` with session scope. `prompt.submit` is reserved for conversation input: sending `/model` through it starts an agent turn instead of executing the model command.

Older native events can omit run identifiers. After a turn finishes, trailing events must not open an external continuation: a new native run boundary is required. External continuations ingest already-running Hermes output; their internal notification text is never submitted as a new prompt.

## Background reconciliation

The server-lifetime Work synchronization service reads native schedules and sessions and stores observed runs and outputs. It never triggers execution. The run repository keys observations by provider, profile, and session and retains associations with removed schedules.

Session backfill is bounded and resumes from durable progress. Output retrieval is queued rather than downloading every conversation on every sweep. Available execution status is kept distinct from delivery status; absent information remains unknown.

Legacy database migrations remain so existing installations can upgrade. The old ACP provider, manual import/reset RPCs, capability-probing conformance harness, and proactive inbox management path are removed. Historical compatibility does not re-enable the retired runtime.

## Verified upstream baseline

The native interface was inspected at official source revision `abf4706384c8ab17d6f22aab0ab8c71526eac305`:

- [Dashboard cron router](https://github.com/NousResearch/hermes-agent/blob/abf4706384c8ab17d6f22aab0ab8c71526eac305/hermes_cli/web_routers/cron.py): management and run-history operations.
- [Native WebSocket gateway](https://github.com/NousResearch/hermes-agent/blob/abf4706384c8ab17d6f22aab0ab8c71526eac305/tui_gateway/ws.py): ready payload and event transport.
- [Profile management](https://github.com/NousResearch/hermes-agent/blob/abf4706384c8ab17d6f22aab0ab8c71526eac305/hermes_cli/web_routers/profiles.py): assistant ownership.
- [Desktop documentation](https://hermes-agent.nousresearch.com/docs/user-guide/desktop) and [scheduled tasks documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron): product behavior.

An older gateway's `cron.manage` method does not expose every desktop management operation. Full support requires the native dashboard endpoints; an unavailable endpoint produces an explicit error rather than falling back to the old integration.
