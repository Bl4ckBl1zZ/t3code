import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewDevice, resolvePreviewViewport } from "./previewViewport.ts";

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
