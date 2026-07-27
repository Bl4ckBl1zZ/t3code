import type { HermesSkillsProviderProjection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatSkillNames,
  formatSkillsReloadSummary,
  skillsBlockedDiagnostic,
} from "./HermesSkillsSettings.logic";

const provider = (
  overrides: Partial<HermesSkillsProviderProjection>,
): HermesSkillsProviderProjection => ({
  providerInstanceId: "hermes_main",
  displayName: "Hermes",
  profileKey: "work",
  status: "ready",
  protocolClassification: "supported",
  capabilities: { inventory: true, search: true, inspect: true, reload: true },
  skills: [],
  diagnostics: [],
  ...overrides,
});

describe("formatSkillsReloadSummary", () => {
  it("includes the total only when the gateway reports one", () => {
    expect(formatSkillsReloadSummary({ added: ["a"], removed: [], total: 4, output: null })).toBe(
      "1 added, 0 removed, 4 total",
    );
    expect(
      formatSkillsReloadSummary({ added: [], removed: ["b"], total: null, output: null }),
    ).toBe("0 added, 1 removed");
  });
});

describe("formatSkillNames", () => {
  it("joins names and hides empty lists", () => {
    expect(formatSkillNames(["a", "b"])).toBe("a, b");
    expect(formatSkillNames([])).toBeNull();
  });
});

describe("skillsBlockedDiagnostic", () => {
  it("returns no diagnostic for ready providers", () => {
    expect(skillsBlockedDiagnostic(provider({ status: "ready" }))).toBeNull();
  });

  it("surfaces the first diagnostic for blocked providers", () => {
    expect(
      skillsBlockedDiagnostic(
        provider({
          status: "unavailable",
          diagnostics: ["Gateway capabilities are not negotiated"],
        }),
      ),
    ).toBe("Gateway capabilities are not negotiated");
    expect(skillsBlockedDiagnostic(provider({ status: "error", diagnostics: [] }))).toBe(
      "Hermes skills are unavailable for this provider.",
    );
  });
});
