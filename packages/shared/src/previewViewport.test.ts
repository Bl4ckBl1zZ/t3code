import { describe, expect, it } from "vite-plus/test";

import {
  PREVIEW_VIEWPORT_PRESETS,
  resolvePreviewDevice,
  resolvePreviewViewport,
} from "./previewViewport.ts";

describe("previewViewport", () => {
  it("resolves fill and exact freeform viewports", () => {
    expect(resolvePreviewViewport({ mode: "fill" })).toEqual({ _tag: "fill" });
    expect(resolvePreviewViewport({ mode: "freeform", width: 1024, height: 768 })).toEqual({
      _tag: "freeform",
      width: 1024,
      height: 768,
    });
  });

  it("resolves device presets in either orientation", () => {
    expect(resolvePreviewViewport({ mode: "preset", preset: "iphone-12-pro" })).toEqual({
      _tag: "preset",
      width: 390,
      height: 844,
      presetId: "iphone-12-pro",
    });
    expect(
      resolvePreviewViewport({
        mode: "preset",
        preset: "iphone-12-pro",
        orientation: "landscape",
      }),
    ).toEqual({
      _tag: "preset",
      width: 844,
      height: 390,
      presetId: "iphone-12-pro",
    });
  });

  it("matches Chrome's standard device catalog ordering", () => {
    expect(PREVIEW_VIEWPORT_PRESETS.map((preset) => preset.label)).toEqual([
      "iPhone SE",
      "iPhone XR",
      "iPhone 12 Pro",
      "iPhone 14 Pro Max",
      "Pixel 7",
      "Samsung Galaxy S8+",
      "Samsung Galaxy S20 Ultra",
      "iPad Mini",
      "iPad Air",
      "iPad Pro",
      "Surface Pro 7",
      "Surface Duo",
      "Galaxy Z Fold 5",
      "Asus Zenbook Fold",
      "Samsung Galaxy A51/71",
      "Nest Hub",
      "Nest Hub Max",
    ]);
  });

  it("presents only device presets as a device", () => {
    expect(
      resolvePreviewDevice(resolvePreviewViewport({ mode: "preset", preset: "iphone-12-pro" })),
    ).toEqual({ mobile: true, deviceScaleFactor: 3, userAgent: "iphone" });
    // Touch laptops and smart displays keep the desktop site.
    expect(
      resolvePreviewDevice(resolvePreviewViewport({ mode: "preset", preset: "surface-pro-7" })),
    ).toEqual({ mobile: false, deviceScaleFactor: 2, userAgent: null });
    expect(resolvePreviewDevice({ _tag: "fill" })).toBeNull();
    expect(resolvePreviewDevice({ _tag: "freeform", width: 390, height: 844 })).toBeNull();
    // Presets saved before the current catalog only keep their size.
    expect(
      resolvePreviewDevice({ _tag: "preset", width: 393, height: 852, presetId: "iphone-15-pro" }),
    ).toBeNull();
  });
});
