import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCssColor, renderSwiftThemePalettes } from "./swiftThemePalettes";

const SWIFT_TABLE = resolve(
  import.meta.dirname,
  "../../../swift-ios/DesignSystem/T3ThemePalettes.generated.swift",
);

describe("parseCssColor", () => {
  it("reads the two shapes the palettes actually produce", () => {
    // Generated palettes come back as hex, the default one as rgba to match global.css.
    expect(parseCssColor("#ffffff")).toEqual({ red: 1, green: 1, blue: 1, alpha: 1 });
    expect(parseCssColor("rgba(255, 255, 255, 0.5)")).toEqual({
      red: 1,
      green: 1,
      blue: 1,
      alpha: 0.5,
    });
  });

  it("carries the alpha byte of an 8-digit hex", () => {
    expect(parseCssColor("#00000080").alpha).toBeCloseTo(0.502, 3);
  });

  it("refuses a color it would otherwise silently render as black", () => {
    expect(() => parseCssColor("oklch(0.5 0.1 200)")).toThrow(/Unsupported palette color/);
  });
});

describe("the Swift palette table", () => {
  it("matches what the shared palettes currently render", () => {
    const rendered = renderSwiftThemePalettes();

    if (process.env.UPDATE_SWIFT_THEME_PALETTES === "1") {
      writeFileSync(SWIFT_TABLE, rendered);
      return;
    }

    // The Swift client has no codegen, so nothing but this test notices when a
    // palette changes shared-side and iOS keeps painting the old colors.
    expect(readFileSync(SWIFT_TABLE, "utf8")).toBe(rendered);
  });

  it("covers every built-in palette in both appearances", () => {
    const rendered = renderSwiftThemePalettes();
    for (const id of ["t3-code", "t3-chat", "grove", "ocean", "ember", "iris"]) {
      expect(rendered).toContain(`id: "${id}"`);
    }
    expect(rendered.match(/light: T3PaletteColors\(/g)).toHaveLength(6);
    expect(rendered.match(/dark: T3PaletteColors\(/g)).toHaveLength(6);
  });
});
