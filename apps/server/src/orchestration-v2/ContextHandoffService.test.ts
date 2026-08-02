import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ContextHandoffServiceV2,
  layer as contextHandoffServiceLayer,
  providerMessageWithContextHandoff,
} from "./ContextHandoffService.ts";
import {
  TextGeneration as TextGenerationService,
  unavailable as textGenerationUnavailable,
  unavailableLayer as textGenerationUnavailableLayer,
} from "../textGeneration/TextGeneration.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";

const TestLayer = contextHandoffServiceLayer.pipe(
  Layer.provide(Layer.merge(idAllocatorLayer, textGenerationUnavailableLayer)),
);

function importedItem(
  input:
    | {
        readonly role: "user";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      }
    | {
        readonly role: "assistant";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      },
): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const base = {
    id: TurnItemId.make(`turn-item:${input.id}`),
    threadId: ThreadId.make("thread:legacy-context"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${input.id}`),
    text: input.text,
  };
  return input.role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        streaming: false,
      };
}

it.layer(TestLayer)("ContextHandoffService legacy import", (it) => {
  it.effect("prepares imported history for the first native v2 turn", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({ role: "user", id: "one", text: "What did we decide?", ordinal: 1 }),
          importedItem({
            role: "assistant",
            id: "two",
            text: "We decided to keep the migration lightweight.",
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.equal(handoff.strategy, "manual_context");
      assert.deepStrictEqual(handoff.fromProviderThreadIds, []);
      assert.include(handoff.summaryText, "What did we decide?");
      assert.include(handoff.summaryText, "keep the migration lightweight");
      const providerMessage = providerMessageWithContextHandoff({
        handoff,
        userText: "Continue from there.",
      });
      assert.include(providerMessage, handoff.summaryText);
      assert.include(providerMessage, "User message:\nContinue from there.");
    }),
  );

  it.effect("preserves role attribution when truncating imported history", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "user",
            id: "long",
            text: `${"x".repeat(35_000)} retained final words`,
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... retained final words");
      assert.notMatch(handoff.summaryText, /\n+x+ retained final words/);
    }),
  );

  it.effect("retains the newest oversized import even when it has no whitespace", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "assistant",
            id: "older",
            text: "older message",
            ordinal: 1,
          }),
          importedItem({
            role: "user",
            id: "long-single-token",
            text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... ");
      assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
      assert.notInclude(handoff.summaryText, "\ufffd");
    }),
  );
});

const providerHandoffInput = {
  threadId: ThreadId.make("thread:switch"),
  targetRunId: RunId.make("run:switch"),
  transferId: ContextTransferId.make("context-transfer:switch"),
  fromProviderThreadIds: [ProviderThreadId.make("provider-thread:codex")],
  toProviderThreadId: ProviderThreadId.make("provider-thread:claude"),
  fromProviderInstanceId: ProviderInstanceId.make("codex"),
  toProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
  coveredRunOrdinals: { from: 1, to: 2 },
  strategy: "full_thread_summary",
  items: [
    importedItem({ role: "user", id: "one", text: "Please refactor the parser.", ordinal: 1 }),
    importedItem({ role: "assistant", id: "two", text: "Refactored parser.ts.", ordinal: 2 }),
  ],
  createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
  cwd: "/tmp/switch-workspace",
  summaryModelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude"),
} as const;

const AiSummaryTestLayer = contextHandoffServiceLayer.pipe(
  Layer.provide(
    Layer.merge(
      idAllocatorLayer,
      Layer.succeed(
        TextGenerationService,
        TextGenerationService.of({
          ...textGenerationUnavailable("unused"),
          generateHandoffSummary: (input) =>
            Effect.succeed({
              summary: `AI compacted summary (${input.fromProvider} -> ${input.toProvider})`,
            }),
        }),
      ),
    ),
  ),
);

it.layer(AiSummaryTestLayer)("ContextHandoffService AI provider handoff", (it) => {
  it.effect("uses the AI-generated summary when generation succeeds", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffServiceV2;
      const handoff = yield* service.prepareProviderHandoff(providerHandoffInput);

      assert.equal(handoff.strategy, "full_thread_summary");
      assert.include(handoff.summaryText, "Full conversation context for provider handoff.");
      assert.include(handoff.summaryText, "AI compacted summary (codex -> claudeAgent)");
      assert.notInclude(handoff.summaryText, "Canonical conversation context:");
    }),
  );
});

it.layer(AiSummaryTestLayer)("ContextHandoffService pending provider handoff", (it) => {
  it.effect("begins in pending status without a summary, then completes to ready", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffServiceV2;
      const pending = yield* service.beginProviderHandoff(providerHandoffInput);

      assert.equal(pending.status, "pending");
      assert.equal(pending.summaryText, "");
      assert.equal(pending.strategy, "full_thread_summary");

      const ready = yield* service.completeProviderHandoff({
        handoff: pending,
        fromProviderInstanceId: providerHandoffInput.fromProviderInstanceId,
        toProviderInstanceId: providerHandoffInput.toProviderInstanceId,
        strategy: providerHandoffInput.strategy,
        items: providerHandoffInput.items,
        completedAt: DateTime.makeUnsafe("2026-01-02T00:00:30.000Z"),
        cwd: providerHandoffInput.cwd,
        summaryModelSelection: providerHandoffInput.summaryModelSelection,
      });

      assert.equal(ready.id, pending.id);
      assert.equal(ready.status, "ready");
      assert.include(ready.summaryText, "AI compacted summary (codex -> claudeAgent)");
      assert.deepStrictEqual(
        DateTime.toEpochMillis(ready.createdAt),
        DateTime.toEpochMillis(pending.createdAt),
      );
    }),
  );
});

it.layer(TestLayer)("ContextHandoffService AI fallback", (it) => {
  it.effect("falls back to the template summary when generation fails", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffServiceV2;
      const handoff = yield* service.prepareProviderHandoff(providerHandoffInput);

      assert.include(handoff.summaryText, "Canonical conversation context:");
      assert.include(handoff.summaryText, "Please refactor the parser.");
    }),
  );

  it.effect("skips AI generation when no cwd is available", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffServiceV2;
      const handoff = yield* service.prepareProviderHandoff({
        ...providerHandoffInput,
        cwd: null,
      });

      assert.include(handoff.summaryText, "Canonical conversation context:");
    }),
  );
});
