import type { ModelSelection } from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";

import {
  getClaudeModelCapabilities,
  isClaudeUltracodeEffort,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
  resolveClaudeAutoCompactTokens,
  resolveClaudeEffort,
} from "./provider/Layers/ClaudeProvider.ts";

export interface CompiledClaudeModelSelection {
  readonly apiModelId: string;
  readonly effort: string | undefined;
  readonly promptEffort: string | undefined;
  /**
   * Compaction threshold in tokens, or undefined to let the model run to its
   * own ceiling. Claude Code takes `min(model window, this)`.
   */
  readonly autoCompactWindow: number | undefined;
  readonly settings: Readonly<Record<string, boolean>>;
  readonly queryIdentity: string;
}

/** Compile every Claude model option at the provider boundary. */
export function compileClaudeModelSelection(
  selection: ModelSelection,
): CompiledClaudeModelSelection {
  const capabilities = getClaudeModelCapabilities(selection.model);
  const descriptors = getProviderOptionDescriptors({ caps: capabilities });
  const supportsBoolean = (id: string) =>
    descriptors.some((descriptor) => descriptor.type === "boolean" && descriptor.id === id);
  const rawEffort = getModelSelectionStringOptionValue(selection, "effort");
  const resolvedEffort = resolveClaudeEffort(capabilities, rawEffort);
  const effort = normalizeClaudeCliEffort(resolvedEffort, selection.model);
  const fastMode = supportsBoolean("fastMode")
    ? getModelSelectionBooleanOptionValue(selection, "fastMode")
    : undefined;
  const thinking = supportsBoolean("thinking")
    ? getModelSelectionBooleanOptionValue(selection, "thinking")
    : undefined;
  const settings = {
    ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    ...(isClaudeUltracodeEffort(resolvedEffort) ? { ultracode: true } : {}),
  };
  const apiModelId = resolveClaudeApiModelId(selection);
  const promptEffort = resolvePromptInjectedEffort(capabilities, rawEffort) ?? undefined;
  const autoCompactWindow = resolveClaudeAutoCompactTokens(selection);
  return {
    apiModelId,
    effort,
    promptEffort,
    autoCompactWindow,
    settings,
    // Part of the query identity: changing the threshold has to reopen the
    // query, the same as changing the model or effort would.
    queryIdentity: JSON.stringify({
      apiModelId,
      effort: effort ?? null,
      autoCompactWindow: autoCompactWindow ?? null,
      settings,
    }),
  };
}
