import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerSettingsService } from "../serverSettings.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { OrchestratorDispatchError } from "./Orchestrator.ts";
import { make } from "./RestartContinuationService.ts";

function harness(
  enabled: boolean,
  failSecond = false,
  completed = false,
  snoozedUntil: DateTime.Utc | null = null,
) {
  const commands: OrchestrationV2ServerCommand[] = [];
  let reads = 0;
  const shells = ["one", "two"].map((id) => ({
    id: ThreadId.make(id),
    status: "running",
    archivedAt: null,
    deletedAt: null,
  })) as OrchestrationV2ThreadShell[];
  const layer = Layer.mergeAll(
    NodeServices.layer,
    ServerSettingsService.layerTest({ continueThreadsAfterServerUpdate: enabled }),
    Layer.mock(ThreadManagementService)({
      getShellSnapshot: () =>
        Effect.sync(() => {
          reads++;
          return { threads: shells, archivedThreads: [], schemaVersion: 1, snapshotSequence: 1 };
        }),
      getThreadProjection: (id) =>
        Effect.succeed({
          thread: {
            id,
            providerInstanceId: "codex",
            activeProviderThreadId: "native",
            archivedAt: null,
            deletedAt: null,
            settledOverride: null,
            snoozedUntil,
          },
          providerThreads: [
            {
              id: "native",
              ownerNodeId: null,
              nativeThreadRef: { nativeId: "saved", strength: "strong" },
              status: "idle",
            },
          ],
          turnItems: [],
          providerTurns: [],
          runtimeRequests: [],
          messages: [],
          runs: [
            {
              id: `run-${id}`,
              ordinal: 1,
              providerInstanceId: "codex",
              providerThreadId: "native",
              status: completed ? "completed" : "running",
              ...(completed
                ? {
                    restartContinuation: {
                      messageId: `message-${id}`,
                      status: "pending",
                      reason: "restart",
                    },
                  }
                : {}),
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection),
      dispatch: (command) =>
        Effect.suspend(() => {
          commands.push(command);
          if (
            failSecond &&
            command.type === "run.restart-continuation.prepare" &&
            command.threadId === "two"
          )
            return Effect.fail(
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause: "Concurrent state change",
              }),
            );
          return Effect.succeed({ sequence: commands.length, storedEvents: [] });
        }),
    }),
  );
  return { layer, commands, reads: () => reads };
}

it.effect("restart recovery remains opt-in without scanning threads when disabled", () =>
  Effect.gen(function* () {
    const h = harness(false);
    const service = yield* make.pipe(Effect.provide(h.layer));
    expect(yield* service.prepare("restart")).toEqual([]);
    expect(h.reads()).toBe(0);
    expect(h.commands).toEqual([]);
  }),
);

it.effect("clears partially prepared markers when another thread cannot be prepared", () =>
  Effect.gen(function* () {
    const h = harness(true, true);
    const service = yield* make.pipe(Effect.provide(h.layer));
    expect((yield* service.prepare("restart").pipe(Effect.flip))._tag).toBe(
      "RestartContinuationError",
    );
    expect(h.commands.map((command) => command.type)).toEqual([
      "run.restart-continuation.prepare",
      "run.restart-continuation.prepare",
      "run.restart-continuation.clear",
    ]);
    expect(h.commands[2]).toMatchObject({ threadId: "one", runId: "run-one" });
    expect(h.commands[2]).toHaveProperty(
      "messageId",
      h.commands[0] && "messageId" in h.commands[0] ? h.commands[0].messageId : null,
    );
  }),
);

it.effect("completed work clears stale markers instead of sending a continuation", () =>
  Effect.gen(function* () {
    const h = harness(true, false, true);
    const service = yield* make.pipe(Effect.provide(h.layer));
    yield* service.resume;
    yield* service.awaitInitialResume;
    expect(h.commands.map((command) => command.type)).toEqual([
      "run.restart-continuation.clear",
      "run.restart-continuation.clear",
    ]);
  }),
);

it.effect("a snoozed thread is neither prepared nor resumed", () =>
  Effect.gen(function* () {
    const snoozedUntil = DateTime.add(yield* DateTime.now, { hours: 1 });
    const preparing = harness(true, false, false, snoozedUntil);
    expect(yield* (yield* make.pipe(Effect.provide(preparing.layer))).prepare("restart")).toEqual(
      [],
    );
    expect(preparing.commands).toEqual([]);

    const resuming = harness(true, false, true, snoozedUntil);
    const service = yield* make.pipe(Effect.provide(resuming.layer));
    yield* service.resume;
    expect(resuming.commands.map((command) => command.type)).toEqual([
      "run.restart-continuation.clear",
      "run.restart-continuation.clear",
    ]);
  }),
);
