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

  it("shows downgrade guidance instead of a broken OpenCode inventory timeout", () => {
    const message = "This provider version is known to be incompatible. Use 1.14.19.";
    const broken: ServerProvider = {
      ...provider,
      driver: ProviderDriverKind.make("opencode"),
      version: "2.0.3",
      status: "error",
      auth: { status: "unknown" },
      message: "Failed to load OpenCode provider inventory: Timed out waiting for server start.",
      compatibilityAdvisory: {
        status: "broken",
        message,
        recommendedVersion: "1.14.19",
        recommendedRange: ">=1.14.19 <2.0.0",
      },
    };
    expect(shouldShowProviderStatusBanner(broken, null)).toBe(true);
    const timeoutOnly: ServerProvider = {
      ...broken,
      compatibilityAdvisory: {
        ...broken.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(shouldShowProviderStatusBanner(broken, getProviderStatusBannerKey(timeoutOnly))).toBe(
      true,
    );
    expect(shouldShowProviderStatusBanner(broken, getProviderStatusBannerKey(broken))).toBe(false);
    expect(
      shouldShowProviderStatusBanner(
        {
          ...broken,
          compatibilityAdvisory: { ...broken.compatibilityAdvisory!, message: "Use 1.14.20." },
        },
        getProviderStatusBannerKey(broken),
      ),
    ).toBe(true);
    expect(getProviderStatusMessage(broken)).toBe(message);
    expect(
      getProviderStatusMessage({
        ...broken,
        compatibilityAdvisory: {
          ...broken.compatibilityAdvisory!,
          status: "supported",
          message: null,
        },
      }),
    ).toBe(broken.message);
    expect(getProviderStatusMessage({ ...broken, auth: { status: "unauthenticated" } })).toBe(
      broken.message,
    );
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
