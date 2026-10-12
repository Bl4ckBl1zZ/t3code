import { describe, expect, it } from "vite-plus/test";

import { resolveRuntimeModePicker } from "./composerRuntimeModes";

describe("resolveRuntimeModePicker", () => {
  it("keeps the four generic modes for a code provider", () => {
    const picker = resolveRuntimeModePicker("full-access");
    expect(picker.options.map((option) => option.mode)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    expect(picker.selected.label).toBe("Full access");
  });

  it("offers only the modes a provider supports, showing an unsupported one as Supervised", () => {
    const supported = ["approval-required", "auto", "full-access"] as const;
    const picker = resolveRuntimeModePicker("full-access", supported);
    expect(picker.options.map((option) => option.mode)).toEqual(supported);
    expect(picker.selected.mode).toBe("full-access");
    // A thread stored as Auto-accept edits runs Supervised on this provider.
    const carried = resolveRuntimeModePicker("auto-accept-edits", supported);
    expect(carried.selected.mode).toBe("approval-required");
    expect(carried.options).toContain(carried.selected);
  });
});
