import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  getProviderStatusMessage,
  getProviderStatusBannerKey,
  hasProviderSetup,
  shouldShowProviderStatusBanner,
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

const incompatibleProvider: ServerProvider = {
  ...provider,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  compatibilityAdvisory: {
    status: "unsupported",
    message: "Unsupported version. Use 2.0.0.",
    recommendedVersion: "2.0.0",
    recommendedRange: null,
  },
};

describe("compatibility banners", () => {
  it("shows and dismisses a warning on a healthy provider, then clears it after policy relaxation", () => {
    expect(shouldShowProviderStatusBanner(incompatibleProvider, null)).toBe(true);
    expect(
      shouldShowProviderStatusBanner(
        incompatibleProvider,
        getProviderStatusBannerKey(incompatibleProvider),
      ),
    ).toBe(false);
    expect(
      shouldShowProviderStatusBanner(
        { ...incompatibleProvider, version: "1.0.1" },
        getProviderStatusBannerKey(incompatibleProvider),
      ),
    ).toBe(true);
    const relaxed: ServerProvider = {
      ...incompatibleProvider,
      compatibilityAdvisory: {
        ...incompatibleProvider.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(getProviderStatusBannerKey(relaxed)).toBeNull();
    expect(getProviderStatusBannerKey({ ...incompatibleProvider, status: "disabled" })).toBeNull();
    expect(
      getProviderStatusBannerKey({
        ...incompatibleProvider,
        compatibilityAdvisory: {
          ...incompatibleProvider.compatibilityAdvisory!,
          status: "graceful",
        },
      }),
    ).toBeNull();
  });

  it("keeps authentication failures ahead of compatibility warnings even without a probe message", () => {
    const unauthenticated: ServerProvider = {
      ...incompatibleProvider,
      status: "error",
      auth: { status: "unauthenticated" },
    };
    expect(getProviderStatusMessage(unauthenticated)).toBe("Open provider setup to sign in.");
    expect(getProviderStatusMessage({ ...unauthenticated, message: "Credentials expired" })).toBe(
      "Credentials expired",
    );
  });
});
