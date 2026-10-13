import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  TextGenerationError,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { HandoffSummaryGenerationInput } from "@t3tools/provider-core/server/textGeneration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ContextHandoffSummary from "./ContextHandoffSummary.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const threadId = ThreadId.make("thread:summary");
const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
const writer: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-4-5",
};

function item(id: string, role: "user" | "assistant", text: string): OrchestrationV2TurnItem {
  const base = {
    id: TurnItemId.make(id),
    threadId,
    runId: RunId.make("run:one"),
    nodeId: null,
    providerThreadId: ProviderThreadId.make("provider-thread:codex"),
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${id}`),
    text,
  };
  return role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : { ...base, type: "assistant_message", streaming: false };
}

const history = [
  item("item:first", "user", "Port the parser to Rust; keep the public API."),
  item("item:second", "assistant", "Ported lexer.rs; parser.rs still pending."),
  item("item:kept", "user", "Continue."),
];

const makeLayer = (
  generate: (
    input: HandoffSummaryGenerationInput,
  ) => ReturnType<TextGeneration.TextGeneration["Service"]["generateHandoffSummary"]>,
) =>
  ContextHandoffSummary.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-handoff-summary-" }),
        ServerSettings.layerTest({ textGenerationModelSelection: writer }),
        Layer.mock(TextGeneration.TextGeneration)({ generateHandoffSummary: generate }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartHistory: () => Effect.succeed(history),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

const input = {
  threadId,
  projectId: ProjectId.make("project:summary"),
  cwd: "/repo",
  fromProviderInstanceIds: [ProviderInstanceId.make("codex")],
  toProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
  omittedItemIds: ["item:first"],
  omittedMessages: [],
};

describe("ContextHandoffSummary", () => {
  it.effect("summarizes omitted items with the configured text generation model", () => {
    const requests: Array<HandoffSummaryGenerationInput> = [];
    return Effect.gen(function* () {
      const service = yield* ContextHandoffSummary.ContextHandoffSummary;
      const summary = yield* service.summarize({
        ...input,
        omittedMessages: [
          {
            role: "assistant",
            text: "Ported lexer.rs; parser.rs still pending.",
            threadId,
            runId: RunId.make("run:one"),
            itemId: TurnItemId.make("item:second"),
            providerThreadId: null,
            status: "completed",
            kind: "assistant_message",
          },
        ],
      });
      assert.equal(summary, "Parser port in progress.");
      assert.lengthOf(requests, 1);
      const request = requests[0]!;
      assert.equal(request.modelSelection.instanceId, writer.instanceId);
      assert.equal(request.modelSelection.model, writer.model);
      assert.equal(request.cwd, "/repo");
      assert.equal(request.fromProvider, "codex");
      // Prepared omissions are read back from the thread, oldest first.
      assert.isBelow(
        request.transcript.indexOf("keep the public API"),
        request.transcript.indexOf("parser.rs still pending"),
      );
      assert.notInclude(request.transcript, "Continue.");
    }).pipe(
      Effect.provide(
        makeLayer((request) =>
          Effect.sync(() => {
            requests.push(request);
            return { summary: "  Parser port in progress.\n" };
          }),
        ),
      ),
    );
  });

  it.effect("returns null when generation fails, so delivery proceeds without a summary", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffSummary.ContextHandoffSummary;
      assert.isNull(yield* service.summarize(input));
    }).pipe(
      Effect.provide(
        makeLayer(() =>
          Effect.fail(
            new TextGenerationError({ operation: "generateHandoffSummary", detail: "offline" }),
          ),
        ),
      ),
    ),
  );
});
