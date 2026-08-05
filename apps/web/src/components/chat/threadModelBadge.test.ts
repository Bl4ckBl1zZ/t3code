import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { resolveThreadModelBadge } from "./threadModelBadge";

function model(input: {
  readonly slug: string;
  readonly name: string;
  readonly optionId?: string;
  readonly optionLabel?: string;
}): ServerProviderModel {
  return {
    slug: input.slug,
    name: input.name,
    isCustom: false,
    capabilities:
      input.optionId === undefined
        ? null
        : {
            optionDescriptors: [
              {
                id: input.optionId,
                label: input.optionLabel ?? "Reasoning",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium", isDefault: true },
                  { id: "high", label: "High" },
                ],
              },
            ],
          },
  } as unknown as ServerProviderModel;
}

function entry(models: ReadonlyArray<ServerProviderModel>): ProviderInstanceEntry {
  return { instanceId: "codex", models } as unknown as ProviderInstanceEntry;
}

function selection(input: {
  readonly model: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}): ModelSelection {
  return {
    instanceId: "codex",
    model: input.model,
    ...(input.options === undefined ? {} : { options: input.options }),
  } as unknown as ModelSelection;
}

describe("resolveThreadModelBadge", () => {
  it("renders the model display name with its selected reasoning tier", () => {
    const badge = resolveThreadModelBadge({
      modelSelection: selection({
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "low" }],
      }),
      providerEntry: entry([
        model({ slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", optionId: "reasoningEffort" }),
      ]),
    });
    expect(badge).toEqual({ model: "GPT-5.6-Sol", reasoning: "Low" });
  });

  it("falls back to the model's default tier when the thread stored no selection", () => {
    const badge = resolveThreadModelBadge({
      modelSelection: selection({ model: "gpt-5.6-sol" }),
      providerEntry: entry([
        model({ slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", optionId: "reasoningEffort" }),
      ]),
    });
    expect(badge).toEqual({ model: "GPT-5.6-Sol", reasoning: "Medium" });
  });

  it("reads Claude's differently named reasoning option", () => {
    const badge = resolveThreadModelBadge({
      modelSelection: selection({
        model: "claude-opus-5",
        options: [{ id: "effort", value: "high" }],
      }),
      providerEntry: entry([
        model({ slug: "claude-opus-5", name: "Claude Opus 5", optionId: "effort" }),
      ]),
    });
    expect(badge).toEqual({ model: "Claude Opus 5", reasoning: "High" });
  });

  it("omits the tier for a model that exposes no reasoning option", () => {
    const badge = resolveThreadModelBadge({
      modelSelection: selection({ model: "gpt-5.6-sol" }),
      providerEntry: entry([model({ slug: "gpt-5.6-sol", name: "GPT-5.6-Sol" })]),
    });
    expect(badge).toEqual({ model: "GPT-5.6-Sol", reasoning: null });
  });

  it("keeps the raw slug when the provider instance is gone", () => {
    const badge = resolveThreadModelBadge({
      modelSelection: selection({ model: "gpt-5.6-sol" }),
      providerEntry: null,
    });
    expect(badge).toEqual({ model: "gpt-5.6-sol", reasoning: null });
  });

  it("renders nothing without a model selection", () => {
    expect(resolveThreadModelBadge({ modelSelection: null, providerEntry: null })).toBeNull();
  });
});
