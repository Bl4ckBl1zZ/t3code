import type {
  ModelSelection,
  OrchestrationV2RuntimeRequest,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  isClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";

/** Claude's own resume prompt thresholds: a session idle this long and this large. */
const CLAUDE_RESUME_COMPACTION_MINUTES = 70;
const CLAUDE_RESUME_COMPACTION_TOKENS = 100_000;

/**
 * Whether a Claude instance can run a `/compact` turn for this thread. A
 * thread locked to one Claude home only accepts instances that share its
 * continuation group, since another home cannot resume the session.
 */
export function hasAvailableClaudeCompactionProvider(input: {
  readonly providers: ReadonlyArray<ProviderInstanceEntry>;
  readonly instanceId: ProviderInstanceId | null;
  readonly lockedInstanceId: ProviderInstanceId | null;
}): boolean {
  const claudeProviders = input.providers.filter(
    (provider) => provider.driverKind === "claudeAgent",
  );
  const lockedContinuationGroupKey = input.lockedInstanceId
    ? claudeProviders.find((provider) => provider.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey
    : undefined;
  const compatibleProviders = lockedContinuationGroupKey
    ? claudeProviders.filter(
        (provider) => provider.continuationGroupKey === lockedContinuationGroupKey,
      )
    : claudeProviders;

  return (
    resolveSelectableProviderInstanceEntry(compatibleProviders, input.instanceId ?? undefined) !==
    undefined
  );
}

/** True once the user answered Claude's own resume prompt with "Don't ask again". */
export function hasDismissedResumeCompaction(
  requests: ReadonlyArray<Pick<OrchestrationV2RuntimeRequest, "kind" | "status" | "answers">>,
): boolean {
  return requests.some((request) => {
    if (request.kind !== "user_input" || request.status !== "resolved") return false;
    const answers = request.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;

    return Object.entries(answers).some(
      ([question, answer]) =>
        isClaudeResumeCompactionQuestion(question) &&
        answer === CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
    );
  });
}

/**
 * Whether the next send should compact first: a Claude session large enough
 * and idle long enough that its next turn would re-read the whole history.
 */
export function shouldOfferResumeCompaction(input: {
  readonly provider: string | null | undefined;
  readonly usedTokens: number | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly now: string;
}): boolean {
  if (
    input.provider !== "claudeAgent" ||
    (input.usedTokens ?? 0) < CLAUDE_RESUME_COMPACTION_TOKENS
  ) {
    return false;
  }

  const updatedAt = Date.parse(input.updatedAt ?? "");
  const now = Date.parse(input.now);
  return (
    Number.isFinite(updatedAt) &&
    Number.isFinite(now) &&
    now - updatedAt >= CLAUDE_RESUME_COMPACTION_MINUTES * 60_000
  );
}

export function resolveContextWindowModelDisplayName(
  selection: ModelSelection | null | undefined,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): string | null {
  if (!selection) {
    return null;
  }

  const selectedModel = modelOptionsByInstance
    .get(selection.instanceId)
    ?.find((model) => model.slug === selection.model);

  return selectedModel ? getTriggerDisplayModelName(selectedModel) : selection.model;
}

export function formatContextWindowCompactionMessage(
  modelDisplayName: string | null | undefined,
  autoCompactThreshold?: number | null,
): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return `Compacts automatically at ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  }
  return modelDisplayName
    ? `Context for ${modelDisplayName} compacts automatically when needed.`
    : "Context compacts automatically when needed.";
}

/** Unknown providers reserve conservatively until the V2 projection arrives. */
export function shouldReserveContextWindowMeter(input: {
  detailLoading: boolean;
  threadStarted: boolean;
  providerReportsContextWindow: boolean | null;
}): boolean {
  return input.detailLoading && input.threadStarted && input.providerReportsContextWindow !== false;
}
