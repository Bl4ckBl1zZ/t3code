import { describe, expect, it } from "vite-plus/test";

import { OrchestrationV2EventSupersession } from "./orchestrationV2EventSupersession.ts";

interface Item {
  readonly sequence: number;
  readonly key: string | null;
}

describe("OrchestrationV2EventSupersession", () => {
  it("keeps first and latest per key across a long undelivered run", () => {
    const supersession = new OrchestrationV2EventSupersession<Item>((item) => item.key);
    const keys = ["a", "b", null, "c"];
    for (let sequence = 1; sequence <= 1_000; sequence += 1) {
      supersession.push({ sequence, key: keys[sequence % keys.length] ?? null });
    }
    // Every structural item, plus first and last of each keyed entity, in order.
    const expected = Array.from({ length: 1_000 }, (_, index) => index + 1).filter(
      (sequence) => sequence % 4 === 2 || sequence <= 4 || sequence > 996,
    );
    expect(supersession.size).toBe(expected.length);
    expect(supersession.take().map((item) => item.sequence)).toEqual(expected);
  });

  it("keeps only the latest for keys already delivered, and nothing after clear", () => {
    const supersession = new OrchestrationV2EventSupersession<Item>((item) => item.key);
    supersession.push({ sequence: 1, key: "a" });
    supersession.take();
    supersession.push({ sequence: 2, key: "a" });
    supersession.push({ sequence: 3, key: "b" });
    supersession.push({ sequence: 4, key: "a" });
    expect(supersession.take().map((item) => item.sequence)).toEqual([3, 4]);

    supersession.push({ sequence: 5, key: "c" });
    supersession.clear();
    expect(supersession.size).toBe(0);
    expect(supersession.take()).toEqual([]);
  });
});
