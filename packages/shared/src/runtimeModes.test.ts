import { describe, expect, it } from "vite-plus/test";

import { HERMES_RUNTIME_MODE_CHOICES, hermesRuntimeModeChoice } from "./runtimeModes.ts";

describe("hermesRuntimeModeChoice", () => {
  it("offers only the two behaviors Hermes distinguishes", () => {
    expect(HERMES_RUNTIME_MODE_CHOICES.map((choice) => choice.mode)).toEqual([
      "approval-required",
      "full-access",
    ]);
  });

  it("reads a mode Hermes does not offer as the approval choice", () => {
    expect(hermesRuntimeModeChoice("auto").mode).toBe("approval-required");
    expect(hermesRuntimeModeChoice("auto-accept-edits").mode).toBe("approval-required");
    expect(hermesRuntimeModeChoice("approval-required").mode).toBe("approval-required");
    expect(hermesRuntimeModeChoice("full-access").mode).toBe("full-access");
  });
});
