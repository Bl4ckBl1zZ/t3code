import type { MenuAction } from "@react-native-menu/menu";
import { describe, expect, it } from "vite-plus/test";

import { withTitleRegenerationMenuAction } from "./threadRowMenu";

const BASE: MenuAction[] = [
  { id: "settle", title: "Settle" },
  { id: "copy-handoff-script", title: "Copy handoff script" },
  { id: "delete", title: "Delete", attributes: { destructive: true } },
];

describe("withTitleRegenerationMenuAction", () => {
  it("omits the action on servers without the capability", () => {
    const actions = withTitleRegenerationMenuAction(BASE, {
      supported: false,
      regenerating: false,
    });
    expect(actions.map((action) => action.id)).toEqual(["settle", "copy-handoff-script", "delete"]);
  });

  it("inserts the action directly above Delete", () => {
    const actions = withTitleRegenerationMenuAction(BASE, {
      supported: true,
      regenerating: false,
    });
    expect(actions.map((action) => action.id)).toEqual([
      "settle",
      "copy-handoff-script",
      "regenerate-title",
      "delete",
    ]);
    expect(actions[2]?.title).toBe("Regenerate title");
    expect(actions[2]?.attributes?.disabled).toBe(false);
  });

  it("disables and relabels the action while a regeneration is in flight", () => {
    const actions = withTitleRegenerationMenuAction(BASE, {
      supported: true,
      regenerating: true,
    });
    const regenerate = actions.find((action) => action.id === "regenerate-title");
    expect(regenerate?.title).toBe("Regenerating…");
    expect(regenerate?.attributes?.disabled).toBe(true);
  });

  it("appends when the menu has no delete item", () => {
    const actions = withTitleRegenerationMenuAction([{ id: "archive", title: "Archive" }], {
      supported: true,
      regenerating: false,
    });
    expect(actions.map((action) => action.id)).toEqual(["archive", "regenerate-title"]);
  });

  it("never mutates the source array", () => {
    const base: MenuAction[] = [{ id: "delete", title: "Delete" }];
    withTitleRegenerationMenuAction(base, { supported: true, regenerating: false });
    expect(base).toHaveLength(1);
  });
});
