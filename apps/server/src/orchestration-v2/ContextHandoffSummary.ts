/**
 * ContextHandoffSummary - AI summaries of the history a context handoff could
 * not deliver verbatim.
 *
 * Handoffs carry the newest intact items that fit the target's budget. When a
 * long conversation changes provider, everything older is otherwise reachable
 * only through `t3_thread_read`. This service asks the configured text
 * generation model for a summary of those omitted items. It runs from the
 * effect worker while the target turn starts, never from the orchestrator.
 *
 * Summaries are best effort: any failure or timeout returns null, and delivery
 * proceeds exactly as it would without one.
 *
 * @module ContextHandoffSummary
 */
import type {
  OrchestrationV2HistoricalMessage,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { historicalMessage } from "@t3tools/provider-core/server/handoffBudget";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const TRANSCRIPT_MAX_CHARS = 60_000;
const ITEM_MAX_CHARS = 6_000;
const SUMMARY_TIMEOUT = Duration.seconds(90);

export interface ContextHandoffSummaryInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly cwd: string | null;
  readonly fromProviderInstanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly toProviderInstanceId: ProviderInstanceId;
  /** Omitted while the handoff was prepared; their text is read back from the thread. */
  readonly omittedItemIds: ReadonlyArray<string>;
  /** Omitted by the delivery budget, text in hand. */
  readonly omittedMessages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
}

export class ContextHandoffSummary extends Context.Service<
  ContextHandoffSummary,
  {
    readonly summarize: (input: ContextHandoffSummaryInput) => Effect.Effect<string | null>;
  }
>()("t3/orchestration-v2/ContextHandoffSummary") {}

function renderItem(message: OrchestrationV2HistoricalMessage): string {
  const label = message.role === "user" ? "User" : `Assistant (${message.kind})`;
  const text =
    message.text.length <= ITEM_MAX_CHARS
      ? message.text
      : `${message.text.slice(0, ITEM_MAX_CHARS)}\n[item truncated]`;
  return `${label}:\n${text.trim()}`;
}

/**
 * Oldest first, keeping the newest sections whole when the transcript must be
 * cut: they sit closest to the verbatim history the target receives.
 */
export function handoffSummaryTranscript(
  messages: ReadonlyArray<OrchestrationV2HistoricalMessage>,
): string {
  const selected: Array<string> = [];
  let used = 0;
  for (const message of messages.toReversed()) {
    const section = renderItem(message);
    if (used + section.length + 2 > TRANSCRIPT_MAX_CHARS) {
      selected.unshift("[Earlier history truncated]");
      break;
    }
    selected.unshift(section);
    used += section.length + 2;
  }
  return selected.join("\n\n");
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

  const summarize = Effect.fn("ContextHandoffSummary.summarize")(
    function* (input: ContextHandoffSummaryInput) {
      const preparedIds = new Set(input.omittedItemIds);
      const deliveryMessages = new Map(
        input.omittedMessages.map((message) => [message.itemId as string, message]),
      );
      const fromThread =
        preparedIds.size === 0
          ? []
          : (yield* projectionStore.getTurnStartHistory(input.threadId)).flatMap((item) => {
              if (!preparedIds.has(item.id) || deliveryMessages.has(item.id)) return [];
              const message = historicalMessage(item);
              return message === null ? [] : [message];
            });
      // Prepared omissions precede what the delivery budget dropped: preparation
      // keeps the newest items, so whatever it left out is older.
      const messages = [...fromThread, ...deliveryMessages.values()];
      if (messages.length === 0) return null;

      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        input.projectId,
      ).settings;
      const generated = yield* textGeneration
        .generateHandoffSummary({
          cwd: input.cwd ?? config.cwd,
          transcript: handoffSummaryTranscript(messages),
          fromProvider:
            input.fromProviderInstanceIds.length === 0
              ? "another provider"
              : input.fromProviderInstanceIds.join(", "),
          toProvider: input.toProviderInstanceId,
          modelSelection: settings.textGenerationModelSelection,
        })
        .pipe(Effect.timeoutOption(SUMMARY_TIMEOUT));
      if (Option.isNone(generated)) {
        yield* Effect.logWarning("Context handoff summary timed out", {
          threadId: input.threadId,
        });
        return null;
      }
      const summary = generated.value.summary.trim();
      return summary.length === 0 ? null : summary;
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Context handoff summary unavailable", {
                threadId: input.threadId,
                cause,
              }).pipe(Effect.as(null)),
        ),
      ),
  );

  return ContextHandoffSummary.of({ summarize });
});

export const layer = Layer.effect(ContextHandoffSummary, make);

/** No summaries: delivery keeps only the verbatim history and recovery pointer. */
export const layerDisabled = Layer.succeed(
  ContextHandoffSummary,
  ContextHandoffSummary.of({ summarize: () => Effect.succeed(null) }),
);
