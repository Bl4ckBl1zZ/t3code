import { describe, expect, it } from "vite-plus/test";

import { accessibleWindowElementTree, findAccessibleWindow } from "./snapShot.ts";

describe("accessibleWindowElementTree", () => {
  it.each(["name", "value", "description"] as const)(
    "reports clipped %s text in partial trees",
    async (field) => {
      const tree = await accessibleWindowElementTree(
        {
          role: "window",
          children: async () => [{ role: "text_area", [field]: "x".repeat(8_001) }],
        },
        { x: 0, y: 0, width: 800, height: 600 },
        { width: 800, height: 600 },
      );

      expect(tree?.truncated).toBe(true);
      expect(tree?.root.children[0]?.[field]?.length).toBeLessThan(8_001);
    },
  );
});

describe("findAccessibleWindow", () => {
  const captured = {
    title: "Editor",
    bounds: { x: 100, y: 200, width: 800, height: 600 },
  };

  it("accepts one PID-scoped untitled window whose bounds match", () => {
    const windows = [{ name: null, bounds: captured.bounds }];

    expect(
      findAccessibleWindow(windows, captured, "wayland", { allowUntitledUniqueBounds: true }),
    ).toBe(windows[0]);
    expect(findAccessibleWindow(windows, captured, "wayland")).toBeUndefined();
  });

  it("rejects ambiguous PID-scoped untitled windows even when bounds match", () => {
    const windows = [
      { name: null, bounds: captured.bounds },
      { name: "", bounds: { ...captured.bounds, x: 0, y: 0 } },
    ];

    expect(
      findAccessibleWindow(windows, captured, "wayland", { allowUntitledUniqueBounds: true }),
    ).toBeUndefined();
  });

  it("does not fall back to a differently titled PID-scoped window with matching bounds", () => {
    const windows = [{ name: "Preferences", bounds: captured.bounds }];

    expect(
      findAccessibleWindow(windows, captured, "wayland", { allowUntitledUniqueBounds: true }),
    ).toBeUndefined();
  });

  it("does not use unique bounds when a titled match is already ambiguous", () => {
    const windows = [
      { name: "Editor", bounds: captured.bounds },
      { name: "Editor", bounds: { ...captured.bounds, x: 0, y: 0 } },
    ];

    expect(
      findAccessibleWindow(windows, captured, "wayland", { allowUntitledUniqueBounds: true }),
    ).toBeUndefined();
  });
});
