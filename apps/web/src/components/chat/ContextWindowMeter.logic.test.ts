import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { formatClaudeResumeCompactionQuestion } from "@t3tools/shared/claudeCompaction";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  shouldReserveContextWindowMeter,
  formatContextWindowCompactionMessage,
  hasAvailableClaudeCompactionProvider,
  hasDismissedResumeCompaction,
  resolveContextWindowModelDisplayName,
  shouldOfferResumeCompaction,
} from "./ContextWindowMeter.logic";

function claudeProvider(input: {
  instanceId: string;
  continuationGroupKey: string;
  enabled?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    continuation: { groupKey: input.continuationGroupKey },
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-24T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("hasAvailableClaudeCompactionProvider", () => {
  const originalInstanceId = ProviderInstanceId.make("claude_original");

  it("rejects a fallback in a different locked continuation group", () => {
    const providers = deriveProviderInstanceEntries([
      claudeProvider({
        instanceId: originalInstanceId,
        continuationGroupKey: "claude:home:/original",
        enabled: false,
      }),
      claudeProvider({
        instanceId: "claude_other",
        continuationGroupKey: "claude:home:/other",
      }),
    ]);

    expect(
      hasAvailableClaudeCompactionProvider({
        providers,
        instanceId: originalInstanceId,
        lockedInstanceId: originalInstanceId,
      }),
    ).toBe(false);
  });

  it("accepts an enabled fallback in the locked continuation group", () => {
    const providers = deriveProviderInstanceEntries([
      claudeProvider({
        instanceId: originalInstanceId,
        continuationGroupKey: "claude:home:/original",
        enabled: false,
      }),
      claudeProvider({
        instanceId: "claude_fallback",
        continuationGroupKey: "claude:home:/original",
      }),
    ]);

    expect(
      hasAvailableClaudeCompactionProvider({
        providers,
        instanceId: originalInstanceId,
        lockedInstanceId: originalInstanceId,
      }),
    ).toBe(true);
  });
});

describe("shouldOfferResumeCompaction", () => {
  const now = "2026-08-24T12:00:00.000Z";

  it("matches Claude's old-session age and context thresholds", () => {
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: 100_000,
        updatedAt: "2026-08-24T10:50:00.000Z",
        now,
      }),
    ).toBe(true);
  });

  it("does not offer for recent or smaller sessions", () => {
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: 99_999,
        updatedAt: "2026-08-24T10:00:00.000Z",
        now,
      }),
    ).toBe(false);
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: 200_000,
        updatedAt: "2026-08-24T10:51:00.000Z",
        now,
      }),
    ).toBe(false);
  });

  it("does not offer for another provider or an unknown timestamp", () => {
    expect(
      shouldOfferResumeCompaction({
        provider: "codex",
        usedTokens: 300_000,
        updatedAt: "2026-08-24T09:00:00.000Z",
        now,
      }),
    ).toBe(false);
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: 300_000,
        updatedAt: null,
        now,
      }),
    ).toBe(false);
  });
});

describe("hasDismissedResumeCompaction", () => {
  const question = formatClaudeResumeCompactionQuestion({
    ageMinutes: 120,
    estimatedTokens: 250_000,
  });

  it("recognizes the resume prompt's permanent dismissal", () => {
    expect(
      hasDismissedResumeCompaction([
        { kind: "user_input", status: "resolved", answers: { [question]: "Don't ask again" } },
      ]),
    ).toBe(true);
  });

  it("ignores the same answer on an unrelated question", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user_input",
          status: "resolved",
          answers: { "Show this setup reminder?": "Don't ask again" },
        },
        {
          kind: "user_input",
          status: "resolved",
          answers: {
            "The build cache is large. Compact it before continuing?": "Don't ask again",
          },
        },
      ]),
    ).toBe(false);
  });

  it("ignores unresolved requests and other answers", () => {
    expect(
      hasDismissedResumeCompaction([
        { kind: "user_input", status: "pending", answers: { [question]: "Don't ask again" } },
        { kind: "user_input", status: "resolved", answers: { [question]: "Keep full history" } },
        { kind: "user_input", status: "resolved" },
      ]),
    ).toBe(false);
  });
});

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

  it("shows the configured auto-compaction threshold", () => {
    expect(formatContextWindowCompactionMessage("Claude Sonnet 5", 300_000)).toBe(
      "Compacts automatically at 300,000 tokens.",
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
