# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with five entries:

| Driver kind   | Driver source                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

## Commands that outlive their turn

Providers expose complementary halves of this problem, and the UI is built from whichever half is
available rather than from one assumed shape.

**Claude gives a handle without a stream.** `Bash` with `run_in_background` resolves its `tool_use`
immediately with an acknowledgement carrying a task id and an output file path, then the CLI goes
silent until the task settles. Verified against claude-code 2.1.221: no `task_progress` and no
`tool_progress` frames arrive for a `local_bash` task, even with `includePartialMessages` on. The live
tail therefore comes from the server polling that output file
([`backgroundTail.ts`][bgtail], `BACKGROUND_TAIL_INTERVAL`), not from provider events. A foreground
`Bash` reports `output_file: ""`, so there is nothing to tail and the row shows elapsed time plus, when
the model set `timeout`, a determinate bar.

`Monitor` is also a `local_bash` task, so a thread waiting on one command reports two peer tasks. The
monitor is linked to its target through the output file inside its own command
(`backgroundTaskIdFromWatchedPath`) and folded into that target in the client.

`background_tasks_changed` is a level signal: the whole live set, replaced wholesale, emitting nothing
at session start. It is used as a liveness cross-check, never as a terminalization trigger — it can
precede the matching edge events. Outcomes come from `task_notification`; two tail ticks with a task
absent from the level set retire it as `unknown`.

**Codex gives a stream without a handle.** `item/commandExecution/outputDelta` arrives while a command
blocks the turn, throttled into item updates by `CODEX_OUTPUT_DELTA_EMIT_INTERVAL_MS`. Codex has no
task identity and no notion of detaching, so `nohup cmd &` completes its item with the shell's exit
code and leaves nothing to track.

Three safety nets stop a row spinning for ever, in order: `task_notification`, the sweep when the
query stream closes ([`ClaudeAdapterV2.ts`][claudeadapter], `sweepBackgroundTasks`), and startup
reconciliation ([`ProviderRuntimeRecoveryService.ts`][recovery]), which retires background items whose
run has already completed — the per-run sweep never reaches those. `backgroundProcessCount` on the
thread shell is deliberately never persisted: a background command dies with the CLI process, so the
cached read path reports 0.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[bgtail]: ../../apps/server/src/orchestration-v2/Adapters/backgroundTail.ts
[claudeadapter]: ../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
[recovery]: ../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts
