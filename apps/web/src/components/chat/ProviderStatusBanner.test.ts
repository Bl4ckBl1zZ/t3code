import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  getProviderStatusMessage,
  getProviderStatusBannerKey,
  hasProviderSetup,
} from "./ProviderStatusBanner";
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex_work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "error",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-09-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
it("preserves the environment's specific error instead of replacing it with generic login advice", () => {
  expect(
    getProviderStatusMessage({ ...provider, message: "Account token expired on Studio" }),
  ).toBe("Account token expired on Studio");
  expect(getProviderStatusMessage(provider)).toBe("Open provider setup to sign in.");
});
it("offers reviewed install/login paths and hides healthy or disabled banners", () => {
  expect(hasProviderSetup(provider)).toBe(true);
  expect(hasProviderSetup({ ...provider, driver: ProviderDriverKind.make("opencode") })).toBe(
    false,
  );
  expect(getProviderStatusBannerKey({ ...provider, status: "ready" })).toBeNull();
  expect(getProviderStatusBannerKey({ ...provider, status: "disabled" })).toBeNull();
});
