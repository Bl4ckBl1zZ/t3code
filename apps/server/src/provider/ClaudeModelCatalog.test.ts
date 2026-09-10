import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { compileClaudeModelSelection } from "../claudeModelOptions.ts";
import { applyManifestDefault, BUNDLED_MODEL_MANIFEST } from "./ModelManifest.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG as bundled,
  getClaudeCatalogModelCapabilities,
  resolveClaudeModelsForVersion,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "./ClaudeModelCatalog.ts";

const instanceId = ProviderInstanceId.make("claude-test");

describe("Claude manifest catalog", () => {
  it("advertises Fable 5.1 only on a supported CLI and carries its badge and aliases", () => {
    expect(
      resolveClaudeModelsForVersion(bundled, "2.1.256").some(
        (model) => model.slug === "claude-fable-5-1",
      ),
    ).toBe(false);
    const model = resolveClaudeModelsForVersion(bundled, "2.1.257").find(
      (model) => model.slug === "claude-fable-5-1",
    );
    expect(model).toMatchObject({
      badge: "new",
      aliases: ["fable", "fable-5.1", "claude-fable-5.1"],
    });
    expect(resolveClaudeModelSlug(bundled, "FABLE")).toBe("claude-fable-5-1");
    expect(
      resolveClaudeModelsForVersion(bundled, null).some(
        (model) => model.slug === "claude-fable-5-1",
      ),
    ).toBe(false);
  });

  it("compiles the new model's effort profile and the fork's real compaction threshold", () => {
    expect(
      compileClaudeModelSelection(
        {
          instanceId,
          model: "fable",
          options: [
            { id: "effort", value: "ultracode" },
            { id: "autoCompactWindow", value: "500k" },
          ],
        },
        bundled,
      ),
    ).toMatchObject({
      apiModelId: "claude-fable-5-1[1m]",
      effort: "xhigh",
      settings: { ultracode: true },
      autoCompactWindow: 500_000,
    });
    const descriptors = getClaudeCatalogModelCapabilities(bundled, "fable").optionDescriptors;
    expect(descriptors?.some((option) => option.id === "contextWindow")).toBe(false);
    expect(descriptors?.some((option) => option.id === "autoCompactWindow")).toBe(true);
  });

  it("keeps a custom alias opaque and uses its own descriptors without built-in mappings", () => {
    const catalog = scopeClaudeModelCatalog(bundled, [
      {
        slug: "fable",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [{ id: "custom", label: "Custom", isDefault: true }],
            },
          ],
        },
      },
    ]);
    expect(resolveClaudeModelSlug(catalog, "fable")).toBe("fable");
    expect(compileClaudeModelSelection({ instanceId, model: "fable" }, catalog)).toMatchObject({
      apiModelId: "fable",
      effort: "custom",
      autoCompactWindow: undefined,
    });
    expect(resolveClaudeModelSlug(scopeClaudeModelCatalog(bundled, ["fable"]), "fable")).toBe(
      "fable",
    );
  });

  it("assigns a manifest default even when discovery did not supply a previous default", () => {
    const models = [
      { slug: "claude-sonnet-5", name: "Sonnet", isCustom: false, capabilities: null },
    ];
    expect(
      applyManifestDefault(
        models,
        BUNDLED_MODEL_MANIFEST,
        ProviderDriverKind.make("claudeAgent"),
      )[0]?.isDefault,
    ).toBe(true);
  });
});
