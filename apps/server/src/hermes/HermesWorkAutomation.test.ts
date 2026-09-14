import { describe, expect, it } from "vite-plus/test";
import {
  decodeHermesWorkAutomation,
  hermesWorkAutomationPatch,
  hermesWorkContinuitySources,
} from "./HermesWorkAutomation.ts";

describe("native Hermes automation configuration", () => {
  it("defaults scheduled agent self-management off", () => {
    expect(decodeHermesWorkAutomation({})).toEqual({ timezone: "", allowAgentScheduling: false });
    expect(
      decodeHermesWorkAutomation({
        timezone: "Europe/Luxembourg",
        cron: { allow_agent_scheduling: true },
        agent: { model: "private" },
      }),
    ).toEqual({ timezone: "Europe/Luxembourg", allowAgentScheduling: true });
  });
  it("patches profile configuration without overwriting other settings", () => {
    expect(hermesWorkAutomationPatch(" UTC ", true)).toEqual({
      config: { timezone: "UTC", cron: { allow_agent_scheduling: true } },
    });
    expect(() => hermesWorkAutomationPatch("invalid/timezone", false)).toThrow();
  });
  it("toggles previous-run continuity without losing upstream context", () => {
    expect(hermesWorkContinuitySources(["upstream", "self", "upstream"], false)).toEqual([
      "upstream",
    ]);
    expect(hermesWorkContinuitySources(["upstream", "self"], true)).toEqual(["upstream", "self"]);
  });
});
