import {
  type ModelSelection,
  OrchestrationV2ContextHandoff,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";

export class ContextHandoffPrepareError extends Schema.TaggedErrorClass<ContextHandoffPrepareError>()(
  "ContextHandoffPrepareError",
  {
    threadId: ThreadId,
    targetRunId: RunId,
    fromProviderThreadIds: Schema.Array(ProviderThreadId),
    toProviderThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to prepare context handoff for run ${this.targetRunId} in thread ${this.threadId}.`;
  }
}

export const ContextHandoffServiceV2Error = Schema.Union([ContextHandoffPrepareError]);
export type ContextHandoffServiceV2Error = typeof ContextHandoffServiceV2Error.Type;

export interface ContextHandoffServiceV2Shape {
  readonly prepareLegacyImport: (input: {
    readonly threadId: ThreadId;
    readonly targetRunId: RunId;
    readonly toProviderThreadId: ProviderThreadId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  readonly prepare: (input: {
    readonly threadId: ThreadId;
    readonly targetRunId: RunId;
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  readonly prepareForkDelta: (input: {
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly targetRunId: RunId;
    readonly transferId: OrchestrationV2ContextHandoff["transferId"];
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  readonly prepareProviderHandoff: (input: {
    readonly threadId: ThreadId;
    readonly targetRunId: RunId;
    readonly transferId: NonNullable<OrchestrationV2ContextHandoff["transferId"]>;
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly strategy: Extract<
      OrchestrationV2ContextHandoff["strategy"],
      "delta_since_target_last_seen" | "full_thread_summary"
    >;
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
    /** Working directory for AI summary generation; null skips AI compaction. */
    readonly cwd?: string | null;
    /** Model to compact the transcript with; null skips AI compaction. */
    readonly summaryModelSelection?: ModelSelection | null;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
}

export class ContextHandoffServiceV2 extends Context.Service<
  ContextHandoffServiceV2,
  ContextHandoffServiceV2Shape
>()("t3/orchestration-v2/ContextHandoffService/ContextHandoffServiceV2") {}

function compactText(text: string, maxLength = 240): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, maxLength - 3)}...`;
}

function summarizeDeltaItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
      return `- User: ${compactText(item.text)}`;
    case "assistant_message":
      return `- Assistant: ${compactText(item.text)}`;
    case "command_execution":
      return `- Command: ${compactText(item.input)}`;
    case "file_change":
      return `- File change: ${item.fileName}`;
    case "checkpoint":
      return `- Checkpoint: ${item.files.length} files`;
    case "handoff":
      return `- Handoff: ${compactText(item.summary ?? item.strategy)}`;
    default:
      return null;
  }
}

function makeForkDeltaSummary(input: {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
  readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): string {
  const itemLines = input.deltaItems.flatMap((item) => {
    const line = summarizeDeltaItem(item);
    return line === null ? [] : [line];
  });
  return [
    "Merge-back context from forked conversation.",
    `Source thread: ${input.sourceThreadId}`,
    `Target thread: ${input.targetThreadId}`,
    `Covered fork runs: ${input.coveredRunOrdinals.from}-${input.coveredRunOrdinals.to}`,
    "",
    "Fork delta:",
    ...(itemLines.length === 0 ? ["- No user-visible delta items."] : itemLines),
  ].join("\n");
}

interface ProviderHandoffSummaryInput {
  readonly fromProviderInstanceId: ProviderInstanceId;
  readonly toProviderInstanceId: ProviderInstanceId;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
  readonly strategy: Extract<
    OrchestrationV2ContextHandoff["strategy"],
    "delta_since_target_last_seen" | "full_thread_summary"
  >;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
}

function makeProviderHandoffHeader(input: ProviderHandoffSummaryInput): ReadonlyArray<string> {
  return [
    input.strategy === "full_thread_summary"
      ? "Full conversation context for provider handoff."
      : "Conversation delta since this provider last participated.",
    `From driver: ${input.fromProviderInstanceId}`,
    `To driver: ${input.toProviderInstanceId}`,
    `Covered app runs: ${input.coveredRunOrdinals.from}-${input.coveredRunOrdinals.to}`,
    "",
  ];
}

function makeProviderHandoffSummary(input: ProviderHandoffSummaryInput): string {
  const itemLines = input.items.flatMap((item) => {
    if (item.type === "handoff") {
      return [];
    }
    const line = summarizeDeltaItem(item);
    return line === null ? [] : [line];
  });
  return [
    ...makeProviderHandoffHeader(input),
    "Canonical conversation context:",
    ...(itemLines.length === 0 ? ["- No user-visible context items."] : itemLines),
  ].join("\n");
}

const HANDOFF_TRANSCRIPT_MAX_CHARS = 60_000;
const HANDOFF_SUMMARY_TIMEOUT_MS = 120_000;

/**
 * Full-fidelity transcript for AI compaction, keeping the newest sections
 * whole when the character budget forces truncation of older history.
 */
function makeHandoffTranscript(items: ReadonlyArray<OrchestrationV2TurnItem>): string {
  const sections = items.flatMap((item) => {
    switch (item.type) {
      case "user_message":
        return item.text.trim().length === 0 ? [] : [`User:\n${item.text.trim()}`];
      case "assistant_message":
        return item.text.trim().length === 0 ? [] : [`Assistant:\n${item.text.trim()}`];
      case "command_execution":
        return [`Command executed:\n${compactText(item.input, 2_000)}`];
      case "file_change":
        return [`File changed: ${item.fileName}`];
      default:
        return [];
    }
  });
  const selected: Array<string> = [];
  let used = 0;
  for (const section of sections.toReversed()) {
    if (used + section.length + 2 > HANDOFF_TRANSCRIPT_MAX_CHARS) {
      selected.unshift("[Earlier content truncated]");
      break;
    }
    selected.unshift(section);
    used += section.length + 2;
  }
  return selected.join("\n\n");
}

function makeLegacyImportSummary(items: ReadonlyArray<OrchestrationV2TurnItem>): string {
  const sections = items.flatMap((item) => {
    switch (item.type) {
      case "user_message":
        return [{ label: "User", body: item.text }];
      case "assistant_message":
        return [{ label: "Assistant", body: item.text }];
      default:
        return [];
    }
  });
  const header =
    "Imported conversation history from the previous T3 Code orchestrator. Use it as context; do not repeat it unless the user asks.";
  const maxChars = 32_000;
  const selected: Array<string> = [];
  let remaining = maxChars - header.length - 2;
  for (const section of sections.toReversed()) {
    if (remaining <= 0) break;
    const fullSection = `${section.label}:\n${section.body}`;
    if (fullSection.length <= remaining) {
      selected.unshift(fullSection);
      remaining -= fullSection.length + 2;
      continue;
    }

    const prefix = `${section.label}:\n... `;
    const bodyBudget = remaining - prefix.length;
    if (bodyBudget <= 0) continue;

    const initialStart = section.body.length - bodyBudget;
    let bodyStart = Math.max(0, initialStart);
    if (
      bodyStart > 0 &&
      !/\s/.test(section.body[bodyStart - 1] ?? "") &&
      !/\s/.test(section.body[bodyStart] ?? "")
    ) {
      const nextWhitespace = section.body.slice(bodyStart).search(/\s/);
      if (nextWhitespace !== -1) {
        bodyStart += nextWhitespace;
      }
    }
    const codeUnitAtStart = section.body.charCodeAt(bodyStart);
    const codeUnitBeforeStart = section.body.charCodeAt(bodyStart - 1);
    if (
      codeUnitAtStart >= 0xdc00 &&
      codeUnitAtStart <= 0xdfff &&
      codeUnitBeforeStart >= 0xd800 &&
      codeUnitBeforeStart <= 0xdbff
    ) {
      bodyStart += 1;
    }
    const bodySuffix = section.body.slice(bodyStart).trimStart();
    if (bodySuffix.length === 0) continue;

    const suffix = `${prefix}${bodySuffix}`;
    selected.unshift(suffix);
    remaining -= suffix.length + 2;
  }
  return [header, ...selected].join("\n\n");
}

export function providerMessageWithContextHandoff(input: {
  readonly handoff: OrchestrationV2ContextHandoff;
  readonly userText: string;
}): string {
  return providerMessageWithContextHandoffs({
    handoffs: [input.handoff],
    userText: input.userText,
  });
}

export function providerMessageWithContextHandoffs(input: {
  readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
  readonly userText: string;
}): string {
  const handoffSections = input.handoffs.flatMap((handoff) => {
    const label =
      handoff.strategy === "fork_delta_summary"
        ? "merge_back / fork_delta_summary"
        : handoff.strategy;
    return [`Context handoff (${label}):`, handoff.summaryText, ""];
  });
  return [...handoffSections, "User message:", input.userText].join("\n");
}

const makeContextHandoffService = Effect.fn("orchestrationV2.ContextHandoffService.layer")(
  function* () {
    const idAllocator = yield* IdAllocatorV2;
    const textGeneration = yield* TextGeneration.TextGeneration;

    /**
     * AI-compacted handoff summary with the deterministic template as a
     * fallback whenever generation is unavailable, fails, or times out.
     */
    const makeProviderHandoffSummaryText = Effect.fn(
      "orchestrationV2.contextHandoff.makeProviderHandoffSummaryText",
    )(function* (
      input: ProviderHandoffSummaryInput & {
        readonly threadId: ThreadId;
        readonly cwd?: string | null;
        readonly summaryModelSelection?: ModelSelection | null;
      },
    ) {
      const fallback = makeProviderHandoffSummary(input);
      if (input.cwd == null || input.summaryModelSelection == null) {
        return fallback;
      }
      const transcript = makeHandoffTranscript(input.items);
      if (transcript.length === 0) {
        return fallback;
      }
      const generated = yield* Effect.result(
        textGeneration
          .generateHandoffSummary({
            cwd: input.cwd,
            transcript,
            fromProvider: input.fromProviderInstanceId,
            toProvider: input.toProviderInstanceId,
            modelSelection: input.summaryModelSelection,
          })
          .pipe(Effect.timeoutOption(HANDOFF_SUMMARY_TIMEOUT_MS)),
      );
      if (generated._tag === "Success" && Option.isSome(generated.success)) {
        const summary = generated.success.value.summary.trim();
        if (summary.length > 0) {
          return [...makeProviderHandoffHeader(input), summary].join("\n");
        }
      }
      yield* Effect.logWarning(
        "Provider handoff AI summary unavailable; falling back to template summary.",
        {
          threadId: input.threadId,
          fromProviderInstanceId: input.fromProviderInstanceId,
          toProviderInstanceId: input.toProviderInstanceId,
          ...(generated._tag === "Failure" ? { cause: generated.failure } : { timedOut: true }),
        },
      );
      return fallback;
    });

    const prepareLegacyImport = Effect.fn("orchestrationV2.contextHandoff.prepareLegacyImport")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly targetRunId: RunId;
        readonly toProviderThreadId: ProviderThreadId;
        readonly toProviderInstanceId: ProviderInstanceId;
        readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly createdAt: DateTime.Utc;
      }) {
        const handoffId = yield* idAllocator.allocate
          .contextHandoff({
            threadId: input.threadId,
            fromProviderInstanceId: ProviderInstanceId.make("legacy"),
            toProviderInstanceId: input.toProviderInstanceId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ContextHandoffPrepareError({
                  threadId: input.threadId,
                  targetRunId: input.targetRunId,
                  fromProviderThreadIds: [],
                  toProviderThreadId: input.toProviderThreadId,
                  cause,
                }),
            ),
          );
        return {
          id: handoffId,
          transferId: null,
          threadId: input.threadId,
          targetRunId: input.targetRunId,
          fromProviderThreadIds: [],
          toProviderThreadId: input.toProviderThreadId,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "manual_context",
          status: "ready",
          summaryMessageId: null,
          summaryText: makeLegacyImportSummary(input.items),
          createdByProviderInstanceId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        } satisfies OrchestrationV2ContextHandoff;
      },
    );

    const prepare = Effect.fn("orchestrationV2.contextHandoff.prepare")(function* (input: {
      readonly threadId: ThreadId;
      readonly targetRunId: RunId;
      readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
      readonly toProviderThreadId: ProviderThreadId;
    }) {
      const now = yield* DateTime.now;
      const handoffId = yield* idAllocator.allocate
        .contextHandoff({
          threadId: input.threadId,
          fromProviderInstanceId: ProviderInstanceId.make("manual"),
          toProviderInstanceId: ProviderInstanceId.make("manual"),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ContextHandoffPrepareError({
                threadId: input.threadId,
                targetRunId: input.targetRunId,
                fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                toProviderThreadId: input.toProviderThreadId,
                cause,
              }),
          ),
        );
      return {
        id: handoffId,
        transferId: null,
        threadId: input.threadId,
        targetRunId: input.targetRunId,
        fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
        toProviderThreadId: input.toProviderThreadId,
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "manual_context",
        status: "ready",
        summaryMessageId: null,
        summaryText: "Manual context handoff.",
        createdByProviderInstanceId: null,
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationV2ContextHandoff;
    });

    const prepareForkDelta = Effect.fn("orchestrationV2.contextHandoff.prepareForkDelta")(
      function* (input: {
        readonly sourceThreadId: ThreadId;
        readonly targetThreadId: ThreadId;
        readonly targetRunId: RunId;
        readonly transferId: OrchestrationV2ContextHandoff["transferId"];
        readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
        readonly toProviderThreadId: ProviderThreadId;
        readonly fromProviderInstanceId: ProviderInstanceId;
        readonly toProviderInstanceId: ProviderInstanceId;
        readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
        readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly createdAt: DateTime.Utc;
      }) {
        const handoffId = yield* idAllocator.allocate
          .contextHandoff({
            threadId: input.targetThreadId,
            fromProviderInstanceId: input.fromProviderInstanceId,
            toProviderInstanceId: input.toProviderInstanceId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ContextHandoffPrepareError({
                  threadId: input.targetThreadId,
                  targetRunId: input.targetRunId,
                  fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                  toProviderThreadId: input.toProviderThreadId,
                  cause,
                }),
            ),
          );
        return {
          id: handoffId,
          transferId: input.transferId,
          threadId: input.targetThreadId,
          targetRunId: input.targetRunId,
          fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
          toProviderThreadId: input.toProviderThreadId,
          coveredRunOrdinals: input.coveredRunOrdinals,
          strategy: "fork_delta_summary",
          status: "ready",
          summaryMessageId: null,
          summaryText: makeForkDeltaSummary(input),
          createdByProviderInstanceId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        } satisfies OrchestrationV2ContextHandoff;
      },
    );

    const prepareProviderHandoff = Effect.fn(
      "orchestrationV2.contextHandoff.prepareProviderHandoff",
    )(function* (input: {
      readonly threadId: ThreadId;
      readonly targetRunId: RunId;
      readonly transferId: NonNullable<OrchestrationV2ContextHandoff["transferId"]>;
      readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
      readonly toProviderThreadId: ProviderThreadId;
      readonly fromProviderInstanceId: ProviderInstanceId;
      readonly toProviderInstanceId: ProviderInstanceId;
      readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
      readonly strategy: Extract<
        OrchestrationV2ContextHandoff["strategy"],
        "delta_since_target_last_seen" | "full_thread_summary"
      >;
      readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
      readonly createdAt: DateTime.Utc;
      readonly cwd?: string | null;
      readonly summaryModelSelection?: ModelSelection | null;
    }) {
      const handoffId = yield* idAllocator.allocate
        .contextHandoff({
          threadId: input.threadId,
          fromProviderInstanceId: input.fromProviderInstanceId,
          toProviderInstanceId: input.toProviderInstanceId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ContextHandoffPrepareError({
                threadId: input.threadId,
                targetRunId: input.targetRunId,
                fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                toProviderThreadId: input.toProviderThreadId,
                cause,
              }),
          ),
        );
      return {
        id: handoffId,
        transferId: input.transferId,
        threadId: input.threadId,
        targetRunId: input.targetRunId,
        fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
        toProviderThreadId: input.toProviderThreadId,
        coveredRunOrdinals: input.coveredRunOrdinals,
        strategy: input.strategy,
        status: "ready",
        summaryMessageId: null,
        summaryText: yield* makeProviderHandoffSummaryText(input),
        createdByProviderInstanceId: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      } satisfies OrchestrationV2ContextHandoff;
    });

    return ContextHandoffServiceV2.of({
      prepareLegacyImport,
      prepare,
      prepareForkDelta,
      prepareProviderHandoff,
    });
  },
);

export const layer: Layer.Layer<
  ContextHandoffServiceV2,
  never,
  IdAllocatorV2 | TextGeneration.TextGeneration
> = Layer.effect(ContextHandoffServiceV2, makeContextHandoffService());
