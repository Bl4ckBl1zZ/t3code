import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { compileClaudeModelSelection } from "./claudeModelOptions.ts";

const selection = (
  model: string,
  options: NonNullable<ModelSelection["options"]>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude_test"),
  model,
  options,
});

describe("compileClaudeModelSelection", () => {
  it("compiles effort and settings together, at the model's own window", () => {
    // Fable 5 is natively 1M, so the id carries no `[1m]` suffix.
    expect(
      compileClaudeModelSelection(
        selection("claude-fable-5", [{ id: "effort", value: "ultracode" }]),
      ),
    ).toMatchObject({
      apiModelId: "claude-fable-5",
      effort: "xhigh",
      autoCompactWindow: undefined,
      settings: { ultracode: true },
    });
  });

  it("suffixes only the models that need it to reach 1M", () => {
    // Claude Code's registry: Opus 4.6 and Sonnet 4.6 are 200k natively and
    // reach 1M through the suffix; the rest are already there without it.
    expect(compileClaudeModelSelection(selection("claude-opus-4-6", [])).apiModelId).toBe(
      "claude-opus-4-6[1m]",
    );
    expect(compileClaudeModelSelection(selection("claude-sonnet-4-6", [])).apiModelId).toBe(
      "claude-sonnet-4-6[1m]",
    );
    for (const model of ["claude-opus-5", "claude-fable-5", "claude-sonnet-5"]) {
      expect(compileClaudeModelSelection(selection(model, [])).apiModelId).toBe(model);
    }
    // 200k models with no 1M form stay bare.
    expect(compileClaudeModelSelection(selection("claude-haiku-4-5", [])).apiModelId).toBe(
      "claude-haiku-4-5",
    );
  });

  it("compiles the context slider into a compaction threshold", () => {
    for (const [value, tokens] of [
      ["250k", 250_000],
      ["500k", 500_000],
      ["750k", 750_000],
    ] as const) {
      expect(
        compileClaudeModelSelection(
          selection("claude-opus-5", [{ id: "autoCompactWindow", value }]),
        ).autoCompactWindow,
      ).toBe(tokens);
    }
  });

  it("asks for no compaction cap at the top stop, which is the model ceiling", () => {
    // 1M is the default, so both the explicit pick and an absent selection mean
    // "let the model run to its own window" - the adapter then sends nothing.
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-5", [{ id: "autoCompactWindow", value: "1m" }]),
      ).autoCompactWindow,
    ).toBeUndefined();
    expect(
      compileClaudeModelSelection(selection("claude-opus-5", [])).autoCompactWindow,
    ).toBeUndefined();
  });

  it("ignores a slider value on a model that has no slider", () => {
    // Haiku is 200k; the option is not offered there, and a stale stored value
    // must not start capping it.
    expect(
      compileClaudeModelSelection(
        selection("claude-haiku-4-5", [{ id: "autoCompactWindow", value: "250k" }]),
      ).autoCompactWindow,
    ).toBeUndefined();
  });

  it("reopens the query when only the compaction threshold changed", () => {
    const at = (value: string) =>
      compileClaudeModelSelection(selection("claude-opus-5", [{ id: "autoCompactWindow", value }]))
        .queryIdentity;
    expect(at("250k")).not.toBe(at("500k"));
  });

  it("compiles fast mode only for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: true }]))
        .settings,
    ).toEqual({ fastMode: true });
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: false }]))
        .settings,
    ).toEqual({ fastMode: false });
  });

  it("uses the model default SDK effort alongside prompt-injected effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-sonnet-4-6", [{ id: "effort", value: "ultrathink" }]),
      ),
    ).toMatchObject({ effort: "high", promptEffort: "ultrathink" });
  });

  it("compiles the thinking toggle for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-haiku-4-5", [{ id: "thinking", value: false }]))
        .settings,
    ).toEqual({ alwaysThinkingEnabled: false });
  });
});
