# Orchestrator MCP Server

## Purpose

T3 exposes V2 orchestration through its app-owned MCP endpoint. A provider
agent can use this endpoint to:

- create an app-owned sub-agent on any supported provider instance;
- wait for or poll the sub-agent's durable result;
- cancel an active delegated task; and
- create one or more ordinary top-level T3 threads;
- list a project's threads and incrementally read any thread;
- send or steer follow-up messages; and
- wait for or interrupt ordinary thread runs.

These are T3 orchestration operations, not provider-native sub-agent APIs.
Delegated tasks always create a T3 child thread and run. The child receives
only the supplied task prompt, plus an optional role instruction supplied in
the same tool call. Parent conversation history is not copied into the child.

`ThreadManagementService` is the shared server application boundary for V2
WebSocket commands and MCP. It owns thread lookup, listing, send-mode
selection, durable send postconditions, wait polling, and interrupt selection;
`OrchestratorV2` remains the lower-level command/event processor. Transport
adapters only authenticate, resolve transport-specific inputs, and shape
responses.

## Transport And Authentication

The orchestration tools share the existing authenticated HTTP MCP endpoint:

```text
http://127.0.0.1:<server-port>/mcp
```

The provider-visible server key is `t3-code`. The endpoint registers both the
preview toolkit and the orchestration toolkit.

Before `ProviderSessionManager` opens a new V2 provider session, it asks
`McpSessionRegistry` for a credential scoped to:

- the T3 environment;
- the parent T3 thread;
- the concrete provider instance; and
- the provider session.

The credential grants `preview` and `orchestration` capabilities. Credentials
expire after a maximum lifetime, expire when idle, and are revoked when the
provider session is released. The raw token is not persisted in orchestration
state.

The MCP HTTP server resolves the bearer token and supplies the resulting
`McpInvocationScope` to tool handlers. Orchestration handlers additionally
check the `orchestration` capability before reading or mutating state.

Agents T3 Code did not launch sign in to the same endpoint with MCP OAuth (see
[Environment Authentication](../internals/environment-auth.md#mcp-clients)).
The middleware tries a provider session token first, then an MCP client
session. A client session yields a scope with `client` set and no `thread`:
the user-approved access (read-only or a runtime-mode ceiling) sets its limits,
read-only clients pass only tools declared as reads, and tools that act as the
calling thread (`delegate_task`, preview, worktree handoff) refuse it with
`thread_credential_required`.

## Provider Injection

### Codex V2

Codex app-server receives the remote MCP server through command-line config
overrides:

```text
-c mcp_servers.t3-code.url=http://127.0.0.1:<port>/mcp
-c mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"
```

The provider-session token is placed in `T3_MCP_BEARER_TOKEN`. Both the
production Codex launcher and the injectable test launcher use the same
projection helper.

### Claude Agent SDK V2

Claude receives an HTTP MCP server in its query options:

```ts
{
  mcpServers: {
    "t3-code": {
      type: "http",
      url: "http://127.0.0.1:<port>/mcp",
      headers: {
        Authorization: "Bearer <provider-session-token>",
      },
    },
  },
  allowedTools: [
    // existing allowed tools
    "mcp__t3-code__*",
  ],
}
```

The adapter logs only whether MCP configuration exists; it does not log the
server headers or token.

### Cursor Agent SDK V2

Cursor receives the same authenticated HTTP MCP endpoint through the SDK's
`mcpServers` agent and send options. The adapter passes the authorization header
to the SDK but projects only redacted option metadata into protocol diagnostics.

### Grok ACP V2

Grok receives the authenticated HTTP MCP endpoint through the ACP
`session/new`, `session/load`, and `session/fork` `mcpServers` field. The shared
ACP adapter owns standard protocol behavior; the Grok flavor adds xAI extension
requests such as structured user questions.

ACP does not define native subagents or active steering. Grok therefore uses
orchestrator-owned child threads and implements steering through
cancel-and-restart. Its current driver also lacks `session/fork`, so app forks
use portable context transfer. These are orchestrator policies, not
provider-specific MCP tools.

### ACP Registry V2

The `acpRegistry` driver is the generic flavor of the same shared ACP adapter.
Each provider instance names an agent from the official ACP Registry. At
session startup the driver resolves the current platform distribution, uses a
managed binary cache or the declared `npx`/`uvx` package, and then negotiates
standard ACP capabilities during `initialize`. A local executable may override
the managed command without changing the registry-declared arguments or
environment.

Capabilities such as session loading, session forking, models, modes, and MCP
transport are enabled only when the selected agent advertises them. Missing
features degrade through V2 policy: steering uses interrupt-and-restart,
forking uses portable context when native `session/fork` is unavailable, and
subagents use orchestrator-owned child threads. Registry agents do not receive
provider-specific extensions; those remain in flavors such as Grok.

### Pi V2

Pi core has no MCP client. When a provider session credential exists, the
adapter writes a T3-owned extension into the server cache and spawns
`pi --mode rpc --extension <cache>/pi-t3-mcp-extension.ts` with:

```text
T3_MCP_URL=http://127.0.0.1:<port>/mcp
T3_MCP_BEARER_TOKEN=<provider-session-token>
```

The extension connects to that HTTP endpoint, lists tools, and registers each
one with `pi.registerTool` under a `mcp__t3-code__` namespace
(`mcp__t3-code__delegate_task`, `mcp__t3-code__t3_thread_start`, and the rest).
The bridge calls the original MCP tool name over HTTP. Follow-up requests send
`mcp-protocol-version: 2025-06-18`; Effect's MCP transport returns 400
without it. The first turn of a session also receives the shared T3
orchestration instructions.

Pi keeps ownership of native extension discovery. T3 does not replace Pi's
`subagent` tool or reproduce Pi's package and project-trust loader. Durable
delegation goes through the namespaced T3 MCP `delegate_task` tool and the
shared orchestration child-thread lifecycle. When Pi's example `subagent`
extension is installed, the adapter observes its documented `details.results`
shape and projects task cards with no child thread id. Unknown result shapes
remain ordinary dynamic tool output.

### Initial Provider Support

The V2 provider adapters are Codex, Claude Agent SDK, Cursor Agent SDK, Grok
plus generic registry agents over ACP, OpenCode, Antigravity, Hermes, OpenClaw, and Pi.
Capability discovery still reports other registered provider instances, but marks them
unavailable for orchestration when no V2 adapter exists. This keeps provider
selection model-visible without allowing a request that cannot run.

## Tool Surface

The orchestrator toolkit below exposes sixteen tools. A separate thread toolkit
adds seventeen more, a workspace toolkit adds three, and environment and
preview toolkits add two each.

### `orchestrator_capabilities`

Returns:

- the inherited provider instance and model;
- the parent runtime and interaction modes;
- registered provider instances and advertised models;
- whether each provider can run a child task; and
- feature flags for polling, cancellation, and batch thread creation.

Unavailable providers include model-visible constraints such as missing V2
adapter support, disabled state, missing executable, or missing authentication.

### `delegate_task`

Creates a T3-owned child thread and immediately dispatches the supplied task
prompt.

```ts
type DelegateTaskInput = {
  task: string;
  target?: {
    providerInstanceId?: string;
    driverKind?: string;
    model?: string;
  };
  title?: string;
  role?: "implementation" | "research" | "review" | "design" | "test" | "general";
  mode?: "async" | "wait";
  timeoutMs?: number;
  clientRequestId?: string;
  runtimeMode?: "inherit" | "approval-required" | "auto-accept-edits" | "full-access";
  interactionMode?: "inherit" | "plan" | "default";
};
```

Provider, model, runtime mode, and interaction mode inherit from the parent
when omitted. A driver-only target inherits the parent's provider instance
when it can run child tasks, and otherwise selects an available instance of
that driver; an explicit `providerInstanceId` is honored exactly and fails
when unavailable. Selecting a different provider without a model uses that
provider's first advertised model.

Each delegated review round uses a new `delegate_task` call with the original brief,
prior findings, responses, and unresolved objections. Track each round by its own `taskId` and use
a distinct `clientRequestId` per round, stable across retries of that round.
`childThreadId` is backing storage, not a target for another review round through
`t3_thread_send`. Ordinary thread messaging remains available for user-requested
conversations; it does not reopen a completed task. There is no task-level follow-up
API for preserving the same reviewer session.

Delegation requires an active parent run owned by the MCP credential's
provider session. The request becomes the V2 command
`delegated_task.request`.

`mode: "async"` returns the current durable state immediately.
`mode: "wait"` re-reads the same durable state whenever the parent's task record
or the child's runs or nested tasks change, until it becomes terminal or the
timeout expires. A wait timeout does not cancel the child; the result sets
`waitTimedOut: true`, and the caller can continue with `task_status`.

```ts
type DelegateTaskResult = {
  taskId: string;
  childThreadId: string;
  childRunId: string | null;
  childNodeId: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  providerInstanceId: string;
  model: string | null;
  summary: string | null;
  resultContextTransferId: string | null;
  waitTimedOut: boolean;
};
```

### `task_status`

Reads a delegated task from the parent thread's durable projection. A task ID
from another parent thread is rejected. Terminal results include the child
summary and the durable `subagent_result` context transfer ID when available.

### `task_cancel`

Stops the child thread with the server-only `thread.stop` command, then stops every
task the child delegated, and disposes automatic parent delivery. Like a user Stop,
`thread.stop` interrupts the running turn and ends pull request watches; it also
holds queued turns. A nonterminal task with neither an interruptible run nor
delegates of its own is rejected. A terminal task returns its existing status, and
its child thread still stops, including later runs and watch wakes. Published task
results remain available. It accepts an optional cancellation reason.

### `create_threads`

Creates between one and twenty ordinary top-level T3 threads:

```ts
type CreateThreadsInput = {
  threads: Array<{
    prompt?: string;
    title?: string;
    target?: {
      providerInstanceId?: string;
      driverKind?: string;
      model?: string;
    };
    runtimeMode?: "inherit" | "approval-required" | "auto-accept-edits" | "full-access";
    interactionMode?: "inherit" | "plan" | "default";
  }>;
  clientRequestId?: string;
};
```

Each entry independently resolves provider, model, and modes. The new threads
inherit the parent's project, branch, and worktree path, but they have no
sub-agent lineage. Entries with a prompt immediately dispatch a run; entries
without a prompt remain idle.

### `t3_thread_launch`

Creates one ordinary top-level thread whose workspace is bound before its agent
starts. `workspaceStrategy` chooses that binding: `worktree` provisions and
binds a new checkout from `baseRef`, `existing_worktree` binds a path that is
already there (it must be one of the project's own git worktrees), and the
default `root` uses the project checkout — not the caller's worktree. Project,
provider, model and modes inherit from the caller unless overridden; `message` dispatches the first run after preparation, and
omitting it leaves the thread idle. Returns the thread's own branch and
worktree path alongside its run.

Unlike every other mutation here it takes no `clientRequestId` and derives no
stable ids: provisioning a worktree is not safely repeatable, so each call is
its own launch. A caller that loses the response inspects `t3_thread_list`
rather than retrying. The new thread may not run with broader runtime or
interaction modes than the caller.

Use `create_threads` instead for a batch that shares the caller's checkout.

### `t3_thread_list`

Lists durable thread shells in one project, newest first: `projectId` when
given, else the calling thread's project. Callers can filter by title, run
status, settled state (`settled: true` lists threads the user or
auto-settlement moved out of the active list), and whether app-owned sub-agent
threads are included. Results are bounded and offset-paginated. Deleted threads
are never listed. Each listed thread, and `t3_thread_read`'s thread detail,
reports `settled` and `settledAt`.

### `t3_thread_read`

Reads the durable state, recent runs, and visible timeline of any thread in
the environment by thread ID. A deleted thread returns `thread_not_found`. The
default `messages` view returns user messages, assistant
messages, and proposed plans. The `activity` view also returns summarized tool,
reasoning, checkpoint, handoff, and runtime-request items. Large item text is
bounded and reports whether it was truncated. `afterPosition` and
`nextPosition` support incremental reads.

Thread and message results include required `createdBy` and `creationSource`
provenance. MCP-created threads and user-role messages use `createdBy: "agent"`
and `creationSource: "mcp"`; provider output uses `creationSource: "provider"`.
Actor and ingress are separate so agent-authored user-role messages remain
distinguishable from human-authored messages.

Agents mention another thread as `[title](t3-thread://v1/<threadId>)`. The
link carries only the id, which resolves in the environment of the message that
holds it. Clients show the thread's current title rather than the label, so a
rename never leaves a stale link.

List and read results report `snoozed` and `snoozedUntil`, and
`t3_thread_list` filters on `snoozed`. The server's `isSnoozed`
(`ThreadSettlementPolicy`) follows the client's `effectiveSnoozed`, so agents
and the sidebar agree: a snoozed thread wakes early when it has a pending
request, fails, or completes after the snooze.

### `t3_thread_update`

Updates metadata for the calling thread or any other thread in the environment.
The typed actions are `rename`, `regenerate_title`, `link_pull_request`, and
`unlink_pull_request`. A link input supplies the repository, number, and URL;
the server records the target thread's project ID. Branch and workspace changes
are outside this tool.

The result includes the command ID and durable event sequence together with the
resultant title, title-regeneration marker, and linked pull request. Reusing a
`clientRequestId` for the same action and thread replays the same command
receipt.

### `t3_thread_send`

Sends a message to any ordinary or delegated thread in the environment:

- `auto` starts an idle thread, steers a fully active turn, or queues behind a
  turn that is not yet steerable;
- `queue` creates a separate follow-up run after active work;
- `steer` requires a steerable active provider turn; and
- `restart` requires an active provider turn and uses the orchestrator's
  interrupt-and-restart path.

The target runtime and interaction modes may not be broader than the caller's.
Stable command and message IDs are derived from `clientRequestId` for
idempotent retries.

### `t3_thread_wait`

Waits for a selected run to become `completed`, `failed`, `cancelled`,
`interrupted`, or `rolled_back`. Without `runId`, it pins the latest run at call
time; an idle thread returns immediately. A timeout reports the latest durable
status and does not cancel work.

### `t3_thread_interrupt`

Interrupts a selected active run through the normal V2 `run.interrupt` command.
Without `runId`, it selects the newest interruptible run. A terminal run is
returned unchanged, and a thread with no active provider turn returns
`no_active_run`.

## Thread Toolkit

A second toolkit covers what a caller does to a thread that already exists.
Every tool resolves the caller's credential first and then the thread. A
`threadId` argument may name a thread in any project; omitting it means the
calling thread. Writes additionally require the caller's live run and runtime
and interaction modes at least as broad as the target's, which is the same
escalation rule delegation uses.

- **Organizing.** `t3_thread_organize` pins, snoozes, settles, archives or marks
  a thread unread through the ordinary lifecycle commands. `snooze` requires
  `snoozedUntil`; nothing here schedules future work.
- **The queue.** `t3_queue_list` pages queued messages in delivery order and
  `t3_queue_read` returns up to 16,000 characters of one. `t3_queue_edit`,
  `t3_queue_cancel`, `t3_queue_reorder` and `t3_queue_promote_to_steer` are the
  same commands the composer's queue strip issues, with the same rules — a run
  that is no longer queued is rejected, and steering needs a steerable turn.
- **Pending questions.** `t3_pending_request_list` and `t3_pending_request_read`
  surface unanswered user-input requests, and `t3_pending_request_respond`
  answers one. Approval requests are deliberately absent: an agent cannot
  approve its own permission prompt.
- **Configuration.** `t3_thread_configuration` reads a thread's model selection
  and modes; `t3_thread_configure` sets a thread's selection (the calling
  thread unless `threadId` is given). Permission modes are not settable here.
- **Lineage.** `t3_thread_fork` and `t3_thread_merge_back` run the existing fork
  and merge-back commands (`threadId` / `sourceThreadId` default to the calling
  thread), and `t3_thread_transfers` reads transfer status.
  Acceptance means the command committed, not that a provider turn finished.
- **Search.** `t3_thread_search` runs the app's bounded thread search and then
  keeps matches in one project (`projectId`, else the calling thread's), so it
  may return fewer results than `limit`. It is not paginated and is not
  exhaustive.
- **Scheduling.** `run_scheduled_task_now` triggers any scheduled task
  immediately. It changes the environment, so it requires a live
  full-access/default caller, and each call is a new manual run.

## Workspace, Environment And Preview Toolkits

Three smaller toolkits sit beside the thread one.

The workspace toolkit moves a thread between checkouts and reports where it is.
`t3_worktree_handoff` creates a worktree and re-points the thread at it,
`t3_worktree_status` reports the current binding, and `t3_worktree_list` pages
the branch refs in a thread's workspace (the calling thread unless `threadId`
is given) with the checkout path each one is bound to, using the app's own ref inventory. A detached worktree with no branch
is left out, since there is no ref to name it by. All three need the `worktree`
capability.

`t3_environment_read` reports the environment the credential belongs to — its
id, label, server version and platform — together with an allowlisted subset of
its preferences. The allowlist is the point: provider credentials and the rest
of the settings file never appear, and free-text writing-style instructions are
truncated to 4,000 code points with a `truncated` marker rather than streamed
whole. `t3_environment_preferences_update` writes that same subset back and
needs a live full-access/default caller. A credential issued for another
environment is refused outright.

`t3_preview_list` and `t3_preview_close` page and close the calling thread's
preview tabs. Both gate on the `preview` capability, which already carries the
project's browser-access setting, so a credential without it cannot enumerate
tabs or close one.

## Delegated Task Lifecycle

The MCP server is a command ingress into V2. It does not call provider adapters
directly.

```text
provider model
  -> MCP tools/call delegate_task
  -> authenticated OrchestratorMcpService
  -> shared ThreadManagementService
  -> V2 delegated_task.request command
  -> child thread + child run
  -> parent app_owned subagent projection
  -> parent/child execution nodes
  -> consumed subagent_spawn context transfer
  -> normal provider effect and runtime ingestion
  -> child run reaches a terminal state
  -> parent subagent/node/turn item finalized
  -> consumed subagent_result context transfer
  -> wait result or later task_status result
```

The child thread has lineage relationship `subagent` and points back to the
parent node. The parent gets an `app_owned` sub-agent projection and a
sub-agent turn item so the existing debug UI can render progress.

Terminal provider events trigger finalization. The event stream first replays
persisted events and then follows live events, so finalization also runs after
a server restart. An existing `subagent_result` transfer makes finalization
idempotent.

The result summary prefers the latest assistant content from the child run and
falls back to a terminal-status message when no assistant text exists.

## Policy And Idempotency

Every tool declares who may call it, through `McpToolAccess`: it `reads`,
`readsAsCaller` (the calling thread's own tabs or worktree), `actsAsCaller`
(its subagents, preview tabs, worktree handoff), `writes` (scheduled tasks),
`writesThreads` (the threads it names), `startsThreads` (new threads, at modes
no broader than the caller's) or `writesEnvironment` (preferences, running any
scheduled task). `McpToolAccess.toLayer` accepts only these declarations and
`McpHttpServer` registers only the layers it builds, so a tool without a
decision does not compile; the `t3code/no-raw-mcp-registration` lint rule keeps
Effect's raw `McpServer` registration inside `McpHttpServer`. A
`writesThreads` target is checked before the handler runs and again by the
orchestrator under the thread's lock (`DispatchModeLimit`), so a user raising a
thread's modes mid-call cannot let a narrower caller act on it.

- A child runtime mode may stay equal to or become narrower than the parent
  mode. It may not escalate privileges.
- A child interaction mode may stay equal to or narrow from `default` to
  `plan`. It may not escalate from `plan` to `default`.
- Thread tools take any thread in the environment as a target. List and
  search cover one project: the calling thread's unless `projectId` is given.
- A tool that changes another thread needs the calling thread's live run, and
  the target's runtime and interaction modes may not be broader than the
  caller's. This is the same privilege ceiling as child creation.
- Scheduled tasks take a `projectId` target too. Changing or deleting a task
  requires its modes to be within the caller's, and work in another project
  needs the caller's live run. A task in another project launches a fresh
  thread per run; it cannot bind to the calling thread.
- Provider instances must be enabled, installed, available, authenticated, and
  backed by a V2 adapter.
- A requested model must be advertised by the selected provider when the
  provider publishes a model list.
- `clientRequestId` derives stable command, thread, and message IDs within the
  provider session. Retrying the same call returns the same durable work.
- Calls without `clientRequestId` receive a generated request key and create
  new work.

Expected denials use the typed `OrchestratorMcpFailure` result:

```text
capability_denied
parent_not_active
provider_unavailable
model_unavailable
runtime_mode_escalation_denied
interaction_mode_escalation_denied
task_not_found
task_not_cancellable
thread_not_found
run_not_found
thread_not_sendable
thread_not_interruptible
thread_credential_required
target_required
invalid_request
orchestration_error
```

## Code Ownership

- Shared schemas: `packages/contracts/src/orchestratorMcp.ts`
- MCP service: `apps/server/src/mcp/OrchestratorMcpService.ts`
- Tool definitions and handlers:
  `apps/server/src/mcp/toolkits/orchestrator/`
- Caller declarations: `apps/server/src/mcp/McpToolAccess.ts`
- HTTP registration and authentication:
  `apps/server/src/mcp/McpHttpServer.ts`
- Credential lifecycle: `apps/server/src/mcp/McpSessionRegistry.ts`
- Provider injection:
  `apps/server/src/orchestration-v2/ProviderSessionManager.ts` and V2 adapters
- Durable delegated-task command and finalization:
  `apps/server/src/orchestration-v2/Orchestrator.ts`

## Verification

The integration test uses the real MCP toolkit registration, V2 orchestrator,
SQL persistence, event ingestion, projections, and checkpoints. Only the
external provider adapters are deterministic test implementations.

Coverage includes:

- capability discovery;
- cross-provider delegated completion;
- prompt-only child context;
- parent and child lineage projections;
- spawn and result context transfers;
- async status polling;
- cancellation;
- batch ordinary-thread creation;
- thread listing and timeline reads, including another project's threads;
- ordinary-thread send, wait, steering, and interruption;
- inheritance and per-thread provider overrides; and
- idempotent retries.

Provider adapter tests separately verify Codex, Claude, Cursor, Grok, and ACP
Registry behavior and MCP injection. The provider-session manager test verifies
that credentials exist before an adapter opens and are revoked when it closes.
