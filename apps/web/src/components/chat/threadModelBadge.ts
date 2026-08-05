import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import {
  getModelSelectionOptionDescriptors,
  getProviderOptionCurrentLabel,
} from "@t3tools/shared/model";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { getTriggerDisplayModelLabel } from "./providerIconUtils";

/**
 * Reasoning-option ids across the drivers that expose one: `reasoningEffort`
 * (Codex, Hermes), `effort` (Claude), `thinking` (ACP agents). Matching on the
 * descriptor's "Reasoning" label first keeps a new driver working without a
 * code change here.
 */
const REASONING_OPTION_IDS = new Set(["reasoningEffort", "effort", "thinking", "thinkingLevel"]);
const REASONING_OPTION_LABEL = "reasoning";

export interface ThreadModelBadge {
  /** Display name of the model, e.g. "GPT-5.6-Sol". */
  readonly model: string;
  /** Current reasoning tier, e.g. "Low". Null when the model has no tiers. */
  readonly reasoning: string | null;
}

/**
 * The model a thread runs on, plus its reasoning tier, resolved for display.
 *
 * Falls back to the raw slug when the instance is gone (uninstalled provider,
 * archived thread from another machine) so a row never loses its model.
 */
export function resolveThreadModelBadge(input: {
  readonly modelSelection: ModelSelection | null | undefined;
  readonly providerEntry: ProviderInstanceEntry | null | undefined;
}): ThreadModelBadge | null {
  const modelSelection = input.modelSelection;
  if (!modelSelection?.model) return null;

  const model: ServerProviderModel | undefined = input.providerEntry?.models.find(
    (candidate) => candidate.slug === modelSelection.model,
  );
  const label = model ? getTriggerDisplayModelLabel(model) : modelSelection.model;

  const descriptors = getModelSelectionOptionDescriptors(modelSelection, model?.capabilities);
  const reasoningDescriptor =
    descriptors.find(
      (descriptor) => descriptor.label.trim().toLowerCase() === REASONING_OPTION_LABEL,
    ) ?? descriptors.find((descriptor) => REASONING_OPTION_IDS.has(descriptor.id));

  return {
    model: label,
    reasoning: getProviderOptionCurrentLabel(reasoningDescriptor) ?? null,
  };
}
