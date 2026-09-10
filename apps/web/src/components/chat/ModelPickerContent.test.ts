import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { shouldIncludeModelPickerOption, shouldOfferModelPickerSetup } from "./ModelPickerContent";

function entry(status: ServerProvider["status"]) {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("opencode_work"),
      driver: ProviderDriverKind.make("opencode"),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ])[0]!;
}

describe("shouldIncludeModelPickerOption", () => {
  it.each(["error", "warning"] as const)(
    "keeps only the active synthetic OpenCode row when the provider status is %s",
    (status) => {
      const providerEntry = entry(status);
      const activeInstanceId = ProviderInstanceId.make("opencode_work");
      const activeModel = "openrouter/kimi-k3";

      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: activeModel,
            name: activeModel,
            isUnavailable: true,
          },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(true);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: "stale/model", name: "Stale model" },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(false);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: "other/missing",
            name: "Other missing",
            isUnavailable: true,
          },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(false);
    },
  );
});

describe("model picker account setup", () => {
  function account(overrides: Partial<ServerProvider> = {}) {
    return deriveProviderInstanceEntries([
      {
        ...entry("ready").snapshot,
        instanceId: ProviderInstanceId.make("codex_work"),
        driver: ProviderDriverKind.make("codex"),
        ...overrides,
      },
    ])[0]!;
  }
  const models = [{ slug: "model", name: "Model" }];
  it("offers setup when an enabled account lacks an install, authentication or models", () => {
    expect(
      shouldOfferModelPickerSetup(account({ installed: false, status: "error" }), models),
    ).toBe(true);
    expect(
      shouldOfferModelPickerSetup(
        account({ auth: { status: "unauthenticated" }, status: "warning" }),
        models,
      ),
    ).toBe(true);
    expect(shouldOfferModelPickerSetup(account(), [])).toBe(true);
    expect(shouldOfferModelPickerSetup(account(), models)).toBe(false);
  });
  it("does not offer unsupported or disabled account flows", () => {
    expect(shouldOfferModelPickerSetup(account({ enabled: false, installed: false }), [])).toBe(
      false,
    );
    expect(shouldOfferModelPickerSetup(account({ status: "disabled" }), [])).toBe(false);
    expect(shouldOfferModelPickerSetup(entry("error"), [])).toBe(false);
  });
});
