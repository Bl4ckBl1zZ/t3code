import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  shouldReserveContextWindowMeter,
  formatContextWindowCompactionMessage,
  resolveContextWindowModelDisplayName,
} from "./ContextWindowMeter.logic";

describe("resolveContextWindowModelDisplayName", () => {
  it("uses the selected model from the exact provider instance", () => {
    const primaryInstanceId = ProviderInstanceId.make("codex");
    const selectedInstanceId = ProviderInstanceId.make("codex-work");
    const modelOptionsByInstance = new Map([
      [
        primaryInstanceId,
        [{ slug: "gpt-5.6-sol", name: "Primary profile model", shortName: "Primary" }],
      ],
      [selectedInstanceId, [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", shortName: "5.6 Sol" }]],
    ]);

    expect(
      resolveContextWindowModelDisplayName(
        {
          instanceId: selectedInstanceId,
          model: "gpt-5.6-sol",
        },
        modelOptionsByInstance,
      ),
    ).toBe("5.6 Sol");
  });

  it("falls back to the selected model slug when model metadata is unavailable", () => {
    const selectedInstanceId = ProviderInstanceId.make("codex-work");

    expect(
      resolveContextWindowModelDisplayName(
        {
          instanceId: selectedInstanceId,
          model: "custom-model",
        },
        new Map(),
      ),
    ).toBe("custom-model");
  });
});

describe("formatContextWindowCompactionMessage", () => {
  it("describes compaction in terms of the selected model", () => {
    expect(formatContextWindowCompactionMessage("GPT-5.6 Sol")).toBe(
      "Context for GPT-5.6 Sol compacts automatically when needed.",
    );
  });

  it("uses neutral copy when the model is unavailable", () => {
    expect(formatContextWindowCompactionMessage(null)).toBe(
      "Context compacts automatically when needed.",
    );
  });
});

describe("context meter loading footprint", () => {
  it("reserves for a started thread while usage is loading, including unknown providers", () => {
    for (const reports of [true, null])
      expect(
        shouldReserveContextWindowMeter({
          detailLoading: true,
          threadStarted: true,
          providerReportsContextWindow: reports,
        }),
      ).toBe(true);
  });
  it("does not reserve once loaded, before the first run, or for a known unsupported provider", () => {
    expect(
      shouldReserveContextWindowMeter({
        detailLoading: false,
        threadStarted: true,
        providerReportsContextWindow: true,
      }),
    ).toBe(false);
    expect(
      shouldReserveContextWindowMeter({
        detailLoading: true,
        threadStarted: false,
        providerReportsContextWindow: true,
      }),
    ).toBe(false);
    expect(
      shouldReserveContextWindowMeter({
        detailLoading: true,
        threadStarted: true,
        providerReportsContextWindow: false,
      }),
    ).toBe(false);
  });
});
