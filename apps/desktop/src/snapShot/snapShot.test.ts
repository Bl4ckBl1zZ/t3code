import { describe, expect, it } from "vite-plus/test";

import { accessibleWindowElementTree } from "./snapShot.ts";

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
