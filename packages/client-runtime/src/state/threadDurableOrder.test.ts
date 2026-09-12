import { EnvironmentId } from "@t3tools/contracts";
import { presentThreadShell } from "./models";
import { v2ThreadShell } from "./orchestrationV2TestFixtures";
import { describe, expect, it } from "vite-plus/test";
import { applyDurableThreadOrder, planDurableThreadReorder } from "./threadSort";

describe("durable sidebar order", () => {
  it("carries server active-order keys through the client projection, including reset", () => {
    const environment = EnvironmentId.make("remote");
    expect(
      presentThreadShell(environment, { ...v2ThreadShell, activeOrderKey: "mn" }).activeOrderKey,
    ).toBe("mn");
    expect(
      presentThreadShell(environment, { ...v2ThreadShell, activeOrderKey: null }).activeOrderKey,
    ).toBeNull();
    expect(presentThreadShell(environment, v2ThreadShell).activeOrderKey).toBeNull();
  });
  it("keeps new active threads above arranged threads and arranged pins above legacy pins", () => {
    const rows = [
      { id: "active-z", key: "z", pinned: false },
      { id: "new-active", key: null, pinned: false },
      { id: "legacy-pin", key: null, pinned: true },
      { id: "active-b", key: "b", pinned: false },
      { id: "pin-z", key: "z", pinned: true },
      { id: "pin-b", key: "b", pinned: true },
    ];
    expect(
      applyDurableThreadOrder(
        rows,
        (r) => r.key,
        (r) => r.pinned,
        (r) => r.id,
      ).map((r) => r.id),
    ).toEqual(["pin-b", "pin-z", "legacy-pin", "new-active", "active-b", "active-z"]);
  });

  it("assigns only the moved thread when its neighbors already have usable keys", () => {
    const keys = new Map([
      ["a", "b"],
      ["b", "m"],
      ["c", "z"],
    ]);
    const updates = planDurableThreadReorder(["a", "c", "b"], "c", keys);
    expect(updates.size).toBe(1);
    expect(updates.get("c")! > "b" && updates.get("c")! < "m").toBe(true);
  });

  it("reserves hidden thread keys during a single-row move", () => {
    const keys = new Map([
      ["a", "b"],
      ["b", "z"],
      ["c", "m"],
      ["hidden", "n"],
    ]);
    const updates = planDurableThreadReorder(["a", "c", "b"], "c", keys);
    expect(updates.get("c")).not.toBe("n");
    expect(updates.has("hidden")).toBe(false);
  });

  it("materializes all keyless neighbors so sorting reproduces the requested order", () => {
    const keys = new Map<string, string | null>([
      ["a", "b"],
      ["b", null],
      ["c", "z"],
      ["hidden", "gn"],
    ]);
    const order = ["c", "a", "b"];
    const updates = planDurableThreadReorder(order, "c", keys);
    expect(updates.size).toBe(3);
    expect([...updates.values()]).not.toContain("gn");
    expect([...order].sort((a, b) => (updates.get(a)! < updates.get(b)! ? -1 : 1))).toEqual(order);
  });

  it("supports large imported histories without duplicate or invalid keys", () => {
    const order = Array.from({ length: 2000 }, (_, i) => `thread-${i}`);
    const keys = new Map<string, string | null>(order.map((id) => [id, null]));
    for (let i = 0; i < 100; i += 1)
      keys.set(`hidden-${i}`, `${String.fromCharCode(97 + (i % 26))}n`);
    const updates = planDurableThreadReorder(order, order[0]!, keys);
    const values = [...updates.values()];
    expect(new Set(values).size).toBe(order.length);
    expect(values.every((key) => /^[a-z]*[b-z]$/.test(key) && key.length <= 256)).toBe(true);
    expect(values).toEqual([...values].sort());
    const hidden = new Set(
      [...keys].filter(([id]) => id.startsWith("hidden-")).map(([, key]) => key),
    );
    expect(values.some((key) => hidden.has(key))).toBe(false);
  });

  it("repairs duplicate or non-monotonic neighbor keys", () => {
    for (const keys of [
      new Map([
        ["a", "m"],
        ["b", "m"],
        ["c", "z"],
      ]),
      new Map([
        ["a", "z"],
        ["b", "b"],
        ["c", "m"],
      ]),
    ]) {
      const updates = planDurableThreadReorder(["a", "b", "c"], "c", keys);
      const final = ["a", "b", "c"].map((id) => updates.get(id) ?? keys.get(id)!);
      expect(final[0]! < final[1]! && final[1]! < final[2]!).toBe(true);
    }
  });

  it("resolves equal server keys identically across devices while preserving keyless automatic order", () => {
    const keys = new Map<string, string | null>([
      ["env-b:thread", "m"],
      ["env-a:thread", "m"],
      ["new-2", null],
      ["new-1", null],
    ]);
    expect(
      applyDurableThreadOrder(
        [...keys.keys()],
        (id) => keys.get(id),
        () => false,
        (id) => id,
      ),
    ).toEqual(["new-2", "new-1", "env-a:thread", "env-b:thread"]);
  });
});
