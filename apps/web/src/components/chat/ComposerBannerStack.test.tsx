import { describe, expect, it } from "vite-plus/test";
import { orderComposerBanners, type ComposerBannerStackEntry } from "./ComposerBannerStack";

const notice = (
  id: string,
  options: Partial<ComposerBannerStackEntry> = {},
): ComposerBannerStackEntry => ({
  id,
  variant: "default",
  icon: null,
  title: id,
  ...options,
});

describe("composer notice ordering", () => {
  it("keeps live activity attached while surfacing urgent notices before ordinary notices", () => {
    const notices = [
      notice("info"),
      notice("urgent", { urgent: true }),
      notice("activity", { priority: "activity" }),
      notice("warning", { variant: "warning" }),
    ];
    expect(orderComposerBanners(notices).map((item) => item.id)).toEqual([
      "activity",
      "urgent",
      "warning",
      "info",
    ]);
    expect(notices.map((item) => item.id)).toEqual(["info", "urgent", "activity", "warning"]);
  });
  it("retains arrival order at equal priority and does not promote success notices", () => {
    expect(
      orderComposerBanners([
        notice("one", { variant: "success" }),
        notice("two"),
        notice("three", { variant: "info" }),
      ]).map((item) => item.id),
    ).toEqual(["one", "two", "three"]);
  });
});
