import { describe, expect, it } from "vite-plus/test";
import { accessibleWindowElementTree, boundedSnapShotString } from "./snapShot.ts";

describe("SnapShot accessibility truncation", () => {
  it.each(["name", "value", "description"] as const)(
    "reports clipped %s text so capture can prefer the complete flat read",
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

  it("keeps complete strings and avoids cutting a surrogate pair", () => {
    let truncated = false;
    expect(
      boundedSnapShotString("hello", 5, () => {
        truncated = true;
      }),
    ).toBe("hello");
    expect(truncated).toBe(false);
    expect(
      boundedSnapShotString("ab😀c", 3, () => {
        truncated = true;
      }),
    ).toBe("ab");
    expect(truncated).toBe(true);
  });
});
