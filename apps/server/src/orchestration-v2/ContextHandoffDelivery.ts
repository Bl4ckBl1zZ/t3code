import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ContextHandoffBudgetError } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  historyCost,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";

const HANDOFF_SUMMARY_MAX_BYTES = 8_000;

/** Appends an AI summary to the coverage, shortened until its added cost fits `reserve`. */
function coverageWithSummary(coverage: string, summary: string, reserve: number): string | null {
  const base = historyCost([], coverage);
  const full = summary.trim();
  for (let keep = full.length; keep > 0; keep = Math.floor(keep * 0.8)) {
    const text =
      keep === full.length ? full : `${full.slice(0, keep).trimEnd()} [summary truncated]`;
    const candidate = `${coverage}\nAI summary of the history omitted below (exact text stays available through t3_thread_read):\n${text}`;
    if (historyCost([], candidate) - base <= reserve) return candidate;
  }
  return null;
}

/**
 * Persist before/after injection: an ambiguous pending delivery requires a fresh native thread.
 * Run `unsent` when the provider refused the turn before reading the prompt, so that
 * refusal does not leave an ambiguous marker behind.
 */
export const deliverContextHandoffs = Effect.fn("orchestrationV2.deliverContextHandoffs")(
  function* <InjectError = never, PersistError = never, BudgetError = never>(input: {
    readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly budget: number | Effect.Effect<number, BudgetError>;
    readonly deferInline?: boolean;
    readonly alreadyDeliveredItemIds: ReadonlySet<string>;
    readonly inject?: (
      history: ProviderAdapter.ProviderAdapterV2HistoricalContext,
    ) => Effect.Effect<boolean, InjectError>;
    readonly persist: (handoff: OrchestrationV2ContextHandoff) => Effect.Effect<void, PersistError>;
    /**
     * Summarizes history that cannot be delivered verbatim: items omitted when the
     * handoff was prepared (ids only) and items the delivery budget leaves out.
     * Null leaves delivery as it was, with only the recovery pointer.
     */
    readonly summarize?: (input: {
      readonly omittedItemIds: ReadonlyArray<string>;
      readonly omittedMessages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
    }) => Effect.Effect<string | null>;
  }) {
    const nativeThreadId = input.providerThread.nativeThreadRef?.nativeId ?? undefined;
    let pending = input.handoffs.filter(
      (handoff) =>
        nativeThreadId === undefined ||
        handoff.delivery?.nativeThreadId !== nativeThreadId ||
        handoff.delivery.status === "pending",
    );
    if (pending.length === 0 || (input.deferInline && input.inject === undefined))
      return { context: "", delivered: Effect.void, unsent: Effect.void };
    const budget = typeof input.budget === "number" ? input.budget : yield* input.budget;
    let coverage = pending
      .map(
        (handoff) =>
          `Context handoff (${handoff.strategy === "fork_delta_summary" ? "merge_back / fork_delta_summary" : handoff.strategy}):\n${
            handoff.history?.coverage ??
            `From thread ${handoff.threadId}, runs ${handoff.coveredRunOrdinals.from}-${handoff.coveredRunOrdinals.to}. Recover history with t3_thread_read, view=activity; paginate with afterPosition, and use itemId/textOffset for long items.`
          }`,
      )
      .join("\n");
    if (historyCost([], coverage) > Math.min(4_000, budget / 2)) {
      const strategies = Array.from(new Set(pending.map((handoff) => handoff.strategy)));
      coverage = `Context handoff (${strategies.join(", ")}). ${pending.length} handoff records; detailed coverage references omitted. Recover history with t3_thread_read({threadId:"${input.providerThread.appThreadId ?? pending[0]!.threadId}",view:"activity",limit:20,maxCharsPerItem:4000}); paginate with afterPosition=nextPosition. Follow fork/handoff source references in activity. For long items use itemId and textOffset=nextTextOffset until null.`;
    }
    const seen = new Set(input.alreadyDeliveredItemIds);
    const messages = pending
      .flatMap((handoff) => handoff.history?.messages ?? [])
      .filter((message) => {
        if (seen.has(message.itemId)) return false;
        seen.add(message.itemId);
        return true;
      });
    const oldContext = pending
      .filter((handoff) => handoff.history === undefined)
      .map((handoff) => handoff.summaryText)
      .join("\n\n");
    const fullCoverage =
      oldContext && historyCost([], `${coverage}\n${oldContext}`) + 512 <= budget
        ? `${coverage}\n${oldContext}`
        : coverage;
    const priorOmittedItems = pending.reduce(
      (sum, handoff) => sum + (handoff.history?.omittedItems ?? 0),
      0,
    );
    let selected = selectHistory({
      messages,
      coverage: fullCoverage,
      omittedItems: priorOmittedItems,
      budget,
    });
    // Whatever does not fit verbatim is summarized into space reserved ahead of
    // selection, so the summary never pushes out the items it was written around.
    const storedSummary = pending.find((handoff) => handoff.history?.summary !== undefined)?.history
      ?.summary;
    if (selected.omittedItems > 0 && (storedSummary !== undefined || input.summarize)) {
      const reserve = Math.min(HANDOFF_SUMMARY_MAX_BYTES, Math.floor(budget / 4));
      const room = selectHistory({
        messages,
        coverage: fullCoverage,
        omittedItems: priorOmittedItems,
        budget: budget - reserve,
      });
      const roomOmitted = new Set(room.omittedItemIds);
      const summary =
        storedSummary ??
        (yield* input.summarize!({
          omittedItemIds: pending.flatMap((handoff) => handoff.history?.omittedItemIds ?? []),
          omittedMessages: messages.filter((message) => roomOmitted.has(message.itemId)),
        }));
      const coverageSummary =
        summary === null ? null : coverageWithSummary(fullCoverage, summary, reserve);
      if (summary !== null && coverageSummary !== null) {
        const summarized = selectHistory({
          messages: room.messages,
          coverage: coverageSummary,
          omittedItems: room.omittedItems,
          budget,
        });
        if (historyCost(summarized.messages, summarized.context) <= budget) {
          selected = {
            ...summarized,
            omittedItemIds: [...room.omittedItemIds, ...summarized.omittedItemIds],
          };
          pending = pending.map((handoff) =>
            handoff.history === undefined
              ? handoff
              : { ...handoff, history: { ...handoff.history, summary } },
          );
        }
      }
    }
    if (historyCost(selected.messages, selected.context) > budget) {
      if (input.deferInline) return { context: "", delivered: Effect.void, unsent: Effect.void };
      return yield* new ContextHandoffBudgetError();
    }
    const omittedItemIds = new Set(selected.omittedItemIds);
    const persist = (status: "pending" | "injected" | "inline") =>
      Effect.forEach(
        pending,
        (handoff) =>
          input.persist({
            ...handoff,
            ...(nativeThreadId === undefined
              ? {}
              : {
                  delivery: {
                    nativeThreadId,
                    status,
                    omittedItemIds: [
                      ...(handoff.history?.omittedItemIds ?? []),
                      ...(handoff.history?.messages ?? [])
                        .filter((message) => omittedItemIds.has(message.itemId))
                        .map((message) => message.itemId),
                    ],
                    itemIds: selected.messages
                      .filter((message) =>
                        handoff.history?.messages.some(
                          (candidate) => candidate.itemId === message.itemId,
                        ),
                      )
                      .map((message) => message.itemId),
                  },
                }),
          }),
        { discard: true },
      );
    if (input.inject !== undefined && nativeThreadId !== undefined) {
      if (
        pending.some(
          (handoff) =>
            handoff.delivery?.nativeThreadId === nativeThreadId &&
            handoff.delivery.status === "pending",
        )
      ) {
        return yield* new ContextHandoffDeliveryUncertainError();
      }
      yield* persist("pending");
      const injected = yield* input.inject({
        messages: selected.messages,
        context: selected.context,
      });
      if (injected) {
        yield* persist("injected");
        return { context: "", delivered: Effect.void, unsent: Effect.void };
      }
    } else {
      yield* persist("pending");
    }
    if (input.deferInline) {
      // Compaction APIs cannot accept an inline transcript. Keep it available
      // for the next ordinary turn when native injection is unsupported.
      yield* Effect.forEach(pending, input.persist, { discard: true });
      return { context: "", delivered: Effect.void, unsent: Effect.void };
    }
    return {
      context: renderHistory(selected.messages, selected.context),
      delivered: persist("inline"),
      unsent: Effect.forEach(pending, input.persist, { discard: true }),
    };
  },
);

export class ContextHandoffDeliveryUncertainError extends Schema.TaggedError<ContextHandoffDeliveryUncertainError>()(
  "ContextHandoffDeliveryUncertainError",
  {},
) {
  override get message() {
    return "Historical context delivery is uncertain; replace the native thread before retrying.";
  }
}
