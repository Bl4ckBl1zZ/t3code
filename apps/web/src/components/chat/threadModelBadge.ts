import type {
  ModelSelection,
  OrchestrationV2Subagent,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  getModelSelectionOptionDescriptors,
  getProviderOptionCurrentLabel,
  resolveSelectableModel,
} from "@t3tools/shared/model";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { getTriggerDisplayModelLabel } from "./providerIconUtils";
import { getTraitsSpeedDisplay } from "./TraitsSpeed";

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

export interface SubagentModelTraits {
  /** Current reasoning tier label, e.g. "High". */
  readonly reasoning: string | null;
  /** Set only when the selection saved a faster-than-normal speed. */
  readonly speedIcon: "fast" | "ultrafast" | null;
}

/**
 * Reasoning tier and speed of the selection a subagent runs on, for its hover
 * card. A selection the provider reported for the subagent wins, and it stays
 * after the subagent completes. Without one, only a T3-owned subagent runs on
 * its child thread's model selection; a provider-native child thread mirrors
 * the parent's, and a child that moved to another model or instance no longer
 * describes the subagent. Both return null so the card never claims traits the
 * agent is not using.
 */
export function resolveSubagentModelTraits(input: {
  readonly subagent: Pick<
    OrchestrationV2Subagent,
    "origin" | "model" | "providerInstanceId" | "modelSelection"
  >;
  readonly modelSelection: ModelSelection | null | undefined;
  readonly providerEntry: ProviderInstanceEntry | null | undefined;
}): SubagentModelTraits | null {
  const { subagent, providerEntry: entry } = input;
  const selection =
    subagent.modelSelection ?? (subagent.origin === "app_owned" ? input.modelSelection : null);
  if (!selection) return null;
  if (selection.instanceId !== subagent.providerInstanceId) return null;
  const resolveSlug = (value: string | null | undefined) =>
    (entry ? resolveSelectableModel(entry.driverKind, value, entry.models) : null) ?? value?.trim();
  const childSlug = resolveSlug(selection.model);
  if (!childSlug || childSlug !== resolveSlug(subagent.model)) return null;

  const model = entry?.models.find((candidate) => candidate.slug === childSlug);
  const speedIcon =
    entry && model
      ? (model.capabilities?.optionDescriptors
          ?.map((descriptor) => {
            // Only a speed the selection saved: a provider default is not a choice.
            const saved = selection.options?.find((option) => option.id === descriptor.id);
            if (descriptor.type === "boolean" && typeof saved?.value === "boolean") {
              return getTraitsSpeedDisplay(entry.driverKind, {
                ...descriptor,
                currentValue: saved.value,
              });
            }
            if (
              descriptor.type === "select" &&
              typeof saved?.value === "string" &&
              descriptor.options.some((option) => option.id === saved.value)
            ) {
              return getTraitsSpeedDisplay(entry.driverKind, {
                ...descriptor,
                currentValue: saved.value,
              });
            }
            return null;
          })
          .find((display) => display !== null)?.speedIcon ?? null)
      : null;
  const reasoning = resolveThreadModelBadge({
    modelSelection: selection,
    providerEntry: entry,
  })?.reasoning;
  return { reasoning: reasoning ?? null, speedIcon };
}
