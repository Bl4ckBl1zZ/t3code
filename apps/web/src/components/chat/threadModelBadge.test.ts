import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { resolveSubagentModelTraits, resolveThreadModelBadge } from "./threadModelBadge";

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

describe("resolveSubagentModelTraits", () => {
  const serviceTier: ProviderOptionDescriptor = {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    currentValue: "priority",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "ultrafast", label: "Ultrafast" },
      { id: "flex", label: "Flex" },
    ],
  };
  const fastMode: ProviderOptionDescriptor = {
    id: "fastMode",
    label: "Fast Mode",
    type: "boolean",
    currentValue: true,
  };
  const reasoning: ProviderOptionDescriptor = {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options: [
      { id: "medium", label: "Medium", isDefault: true },
      { id: "high", label: "High" },
    ],
  };
  const subagent = {
    origin: "app_owned" as const,
    model: "gpt-5.4",
    providerInstanceId: "codex" as ProviderInstanceId,
  };
  function providerEntry(driverKind: string, descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
    return {
      instanceId: "codex",
      driverKind,
      models: [
        {
          slug: "gpt-5.4",
          name: "My GPT",
          isCustom: false,
          capabilities: { optionDescriptors: [reasoning, ...descriptors] },
        },
      ],
    } as unknown as ProviderInstanceEntry;
  }
  function childSelection(
    options: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>,
    overrides: Partial<{ instanceId: string; model: string }> = {},
  ): ModelSelection {
    return { instanceId: "codex", model: "gpt-5.4", options, ...overrides } as ModelSelection;
  }

  it("names the reasoning tier and saved speed of a T3-owned subagent", () => {
    for (const [driver, descriptor, value, expected] of [
      ["codex", serviceTier, "default", null],
      ["codex", serviceTier, "priority", "fast"],
      ["codex", serviceTier, "ultrafast", "ultrafast"],
      ["codex", serviceTier, "flex", null],
      ["codex", serviceTier, "unknown", null],
      ["codex", serviceTier, true, null],
      ["codex", serviceTier, undefined, null],
      ["claudeAgent", fastMode, true, "fast"],
      ["claudeAgent", fastMode, false, null],
      ["cursor", fastMode, "true", null],
      // Only Codex reports speed as a service tier.
      ["cursor", serviceTier, "priority", null],
    ] as const) {
      const traits = resolveSubagentModelTraits({
        subagent,
        modelSelection: childSelection([
          { id: "reasoningEffort", value: "high" },
          ...(value === undefined ? [] : [{ id: descriptor.id, value }]),
        ]),
        providerEntry: providerEntry(driver, [descriptor]),
      });
      expect(traits, `${driver} ${descriptor.id}=${String(value)}`).toEqual({
        reasoning: "High",
        speedIcon: expected,
      });
    }
  });

  it("resolves a subagent model reported by display name", () => {
    expect(
      resolveSubagentModelTraits({
        subagent: { ...subagent, model: "My GPT" },
        modelSelection: childSelection([{ id: "fastMode", value: true }]),
        providerEntry: providerEntry("claudeAgent", [fastMode]),
      }),
    ).toEqual({ reasoning: "Medium", speedIcon: "fast" });
  });

  it("claims nothing for a selection the subagent does not run on", () => {
    const options = [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ];
    const entry = providerEntry("codex", [serviceTier]);
    for (const input of [
      { subagent: { ...subagent, origin: "provider_native" as const } },
      { subagent: { ...subagent, model: null } },
      { subagent: { ...subagent, model: " " } },
      { subagent: { ...subagent, model: "gpt-5.5" } },
      { modelSelection: childSelection(options, { instanceId: "other" }) },
      { modelSelection: childSelection(options, { model: "gpt-5.5" }) },
      { modelSelection: null },
    ]) {
      expect(
        resolveSubagentModelTraits({
          subagent,
          modelSelection: childSelection(options),
          providerEntry: entry,
          ...input,
        }),
      ).toBeNull();
    }
  });

  it("uses the selection the provider reported for any subagent, after it completes", () => {
    const entry = providerEntry("codex", [serviceTier]);
    const reported = childSelection([
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "ultrafast" },
    ]);
    for (const origin of ["provider_native", "app_owned"] as const) {
      expect(
        resolveSubagentModelTraits({
          subagent: { ...subagent, origin, modelSelection: reported },
          // A provider-native child mirrors the parent; a stale child selection loses.
          modelSelection: childSelection([{ id: "reasoningEffort", value: "medium" }]),
          providerEntry: entry,
        }),
        origin,
      ).toEqual({ reasoning: "High", speedIcon: "ultrafast" });
    }
    // A reported selection on another model still does not describe this agent.
    expect(
      resolveSubagentModelTraits({
        subagent: {
          ...subagent,
          origin: "provider_native",
          modelSelection: { ...reported, model: "gpt-5.5" },
        },
        modelSelection: null,
        providerEntry: entry,
      }),
    ).toBeNull();
  });

  it("keeps the match but no traits once the provider instance is gone", () => {
    expect(
      resolveSubagentModelTraits({
        subagent,
        modelSelection: childSelection([{ id: "reasoningEffort", value: "high" }]),
        providerEntry: null,
      }),
    ).toEqual({ reasoning: null, speedIcon: null });
  });
});
