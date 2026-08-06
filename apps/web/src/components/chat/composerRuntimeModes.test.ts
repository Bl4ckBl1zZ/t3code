import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveRuntimeModePicker } from "./composerRuntimeModes";

const hermes = ProviderDriverKind.make("hermes");
const claude = ProviderDriverKind.make("claude");

describe("resolveRuntimeModePicker", () => {
  it("keeps the four generic modes for a code provider", () => {
    const picker = resolveRuntimeModePicker(claude, "full-access");
    expect(picker.options.map((option) => option.mode)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    expect(picker.selected.label).toBe("Full access");
  });

  it("offers Hermes the two modes it distinguishes, with its own copy", () => {
    const picker = resolveRuntimeModePicker(hermes, "full-access");
    expect(picker.options.map((option) => option.mode)).toEqual([
      "approval-required",
      "full-access",
    ]);
    expect(picker.options.map((option) => option.label)).toEqual([
      "Approve risky commands",
      "Full access",
    ]);
    expect(picker.selected.mode).toBe("full-access");
  });

  it("shows a carried-in mode Hermes does not offer as the approval option", () => {
    // A thread created elsewhere can arrive on Hermes in any mode; the picker
    // still has to render a value that is in its own list.
    const picker = resolveRuntimeModePicker(hermes, "auto");
    expect(picker.selected.mode).toBe("approval-required");
    expect(picker.options).toContain(picker.selected);
  });
});
