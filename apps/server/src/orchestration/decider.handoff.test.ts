import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

/** Decide failures widen to include PlatformError from event-id generation. */
function invariantDetail(error: { readonly detail?: string } | unknown): string {
  return typeof error === "object" && error !== null && "detail" in error
    ? String((error as { readonly detail?: unknown }).detail)
    : "";
}

const UPDATED_AT = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const codexSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};
const claudeSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-5",
};
const handoffRequestId = CommandId.make("cmd-handoff-request");

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: codexSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("message-1"),
        role: "user",
        text: "hello",
        turnId: null,
        streaming: false,
        createdAt: UPDATED_AT,
        updatedAt: UPDATED_AT,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeReadModel(thread: OrchestrationThread): OrchestrationReadModel {
  return { snapshotSequence: 0, projects: [], threads: [thread], updatedAt: UPDATED_AT };
}

it.layer(NodeServices.layer)("handoff decider", (it) => {
  it.effect("records the pending handoff on a started thread", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.start",
          commandId: handoffRequestId,
          threadId,
          toModelSelection: claudeSelection,
          createdAt: UPDATED_AT,
        },
        readModel: makeReadModel(makeThread()),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.handoff).toMatchObject({
          requestId: handoffRequestId,
          fromModelSelection: codexSelection,
          toModelSelection: claudeSelection,
        });
        // The swap happens on completion, not on request.
        expect(event.payload.modelSelection).toBeUndefined();
      }
    }),
  );

  it.effect("rejects a handoff on a thread that never started", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.handoff.start",
            commandId: handoffRequestId,
            threadId,
            toModelSelection: claudeSelection,
            createdAt: UPDATED_AT,
          },
          readModel: makeReadModel(makeThread({ messages: [] })),
        }),
      );
      expect(invariantDetail(result)).toContain("has not started");
    }),
  );

  it.effect("rejects a handoff while a turn is running", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.handoff.start",
            commandId: handoffRequestId,
            threadId,
            toModelSelection: claudeSelection,
            createdAt: UPDATED_AT,
          },
          readModel: makeReadModel(
            makeThread({
              session: {
                threadId,
                status: "running",
                providerName: null,
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: UPDATED_AT,
              },
            }),
          ),
        }),
      );
      expect(invariantDetail(result)).toContain("turn in progress");
    }),
  );

  it.effect("rejects a second handoff while one is pending", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.handoff.start",
            commandId: CommandId.make("cmd-second-handoff"),
            threadId,
            toModelSelection: claudeSelection,
            createdAt: UPDATED_AT,
          },
          readModel: makeReadModel(
            makeThread({
              handoff: {
                requestId: handoffRequestId,
                fromModelSelection: codexSelection,
                toModelSelection: claudeSelection,
                startedAt: UPDATED_AT,
              },
            }),
          ),
        }),
      );
      expect(invariantDetail(result)).toContain("already has a handoff in progress");
    }),
  );

  it.effect("swaps the model and stores the context block on completion", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.complete",
          commandId: CommandId.make("cmd-handoff-complete"),
          threadId,
          requestId: handoffRequestId,
          outcome: "completed",
          summary: "We refactored the parser.",
          summarySource: "live-session",
          createdAt: UPDATED_AT,
        },
        readModel: makeReadModel(
          makeThread({
            handoff: {
              requestId: handoffRequestId,
              fromModelSelection: codexSelection,
              toModelSelection: claudeSelection,
              startedAt: UPDATED_AT,
            },
          }),
        ),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.handoff).toBeNull();
        expect(event.payload.modelSelection).toEqual(claudeSelection);
        expect(event.payload.pendingHandoffContext).toContain("We refactored the parser.");
        expect(event.payload.pendingHandoffContext).toContain("<handoff-context");
      }
    }),
  );

  it.effect("leaves the model unchanged when the handoff failed", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.complete",
          commandId: CommandId.make("cmd-handoff-failed"),
          threadId,
          requestId: handoffRequestId,
          outcome: "failed",
          detail: "Could not summarize.",
          createdAt: UPDATED_AT,
        },
        readModel: makeReadModel(
          makeThread({
            handoff: {
              requestId: handoffRequestId,
              fromModelSelection: codexSelection,
              toModelSelection: claudeSelection,
              startedAt: UPDATED_AT,
            },
          }),
        ),
      });
      const event = Array.isArray(result) ? result[0] : result;

      if (event.type === "thread.meta-updated") {
        expect(event.payload.handoff).toBeNull();
        expect(event.payload.modelSelection).toBeUndefined();
        expect(event.payload.pendingHandoffContext).toBeUndefined();
      }
    }),
  );

  it.effect("ignores a completion for a superseded request", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.complete",
          commandId: CommandId.make("cmd-handoff-stale"),
          threadId,
          requestId: CommandId.make("cmd-old-handoff"),
          outcome: "completed",
          summary: "Stale summary.",
          createdAt: UPDATED_AT,
        },
        readModel: makeReadModel(
          makeThread({
            handoff: {
              requestId: handoffRequestId,
              fromModelSelection: codexSelection,
              toModelSelection: claudeSelection,
              startedAt: UPDATED_AT,
            },
          }),
        ),
      });
      const event = Array.isArray(result) ? result[0] : result;

      if (event.type === "thread.meta-updated") {
        expect(event.payload).toEqual({ threadId, updatedAt: UPDATED_AT });
      }
    }),
  );

  it.effect("rejects a turn start while the handoff is running", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-turn-during-handoff"),
            threadId,
            message: {
              messageId: MessageId.make("message-2"),
              role: "user",
              text: "keep going",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: UPDATED_AT,
          },
          readModel: makeReadModel(
            makeThread({
              handoff: {
                requestId: handoffRequestId,
                fromModelSelection: codexSelection,
                toModelSelection: claudeSelection,
                startedAt: UPDATED_AT,
              },
            }),
          ),
        }),
      );
      expect(invariantDetail(result)).toContain("handing off");
    }),
  );

  it.effect("carries and clears the handoff context on the next turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-after-handoff"),
          threadId,
          message: {
            messageId: MessageId.make("message-2"),
            role: "user",
            text: "what were we doing?",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: UPDATED_AT,
        },
        readModel: makeReadModel(
          makeThread({
            modelSelection: claudeSelection,
            pendingHandoffContext: "<handoff-context>summary</handoff-context>",
          }),
        ),
      });
      const events = Array.isArray(result) ? result : [result];

      const turnStart = events.find((event) => event.type === "thread.turn-start-requested");
      expect(turnStart?.type === "thread.turn-start-requested").toBe(true);
      if (turnStart?.type === "thread.turn-start-requested") {
        expect(turnStart.payload.handoffContext).toBe("<handoff-context>summary</handoff-context>");
      }

      // Cleared in the same batch, so a retry cannot inject it twice.
      const clear = events.find(
        (event) =>
          event.type === "thread.meta-updated" && event.payload.pendingHandoffContext === null,
      );
      expect(clear).toBeDefined();

      // The persisted user message keeps exactly what the user typed.
      const messageSent = events.find((event) => event.type === "thread.message-sent");
      if (messageSent?.type === "thread.message-sent") {
        expect(messageSent.payload.text).toBe("what were we doing?");
      }
    }),
  );

  it.effect("rejects a racing model-selection update while handing off", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-meta-during-handoff"),
            threadId,
            modelSelection: codexSelection,
          },
          readModel: makeReadModel(
            makeThread({
              handoff: {
                requestId: handoffRequestId,
                fromModelSelection: codexSelection,
                toModelSelection: claudeSelection,
                startedAt: UPDATED_AT,
              },
            }),
          ),
        }),
      );
      expect(invariantDetail(result)).toContain("cannot be changed");
    }),
  );
});
