import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectBrowserDeviceType,
  resolvePreviewDeviceType,
  shouldOpenPreviewInNewTab,
} from "./PreviewButton.logic";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldOpenPreviewInNewTab", () => {
  it("opens same-machine paired client previews directly in a new tab", () => {
    expect(
      shouldOpenPreviewInNewTab({
        currentAuthPolicy: "loopback-browser",
        currentDeviceType: "desktop",
        currentSessionCanManageAccess: false,
      }),
    ).toBe(true);
  });

  it("keeps remote client sessions on the browser-agent flow", () => {
    expect(
      shouldOpenPreviewInNewTab({
        currentAuthPolicy: "remote-reachable",
        currentDeviceType: "desktop",
        currentSessionCanManageAccess: false,
      }),
    ).toBe(false);
  });

  it("opens mobile and tablet previews directly without the extension", () => {
    expect(
      shouldOpenPreviewInNewTab({
        currentAuthPolicy: "remote-reachable",
        currentDeviceType: "mobile",
        currentSessionCanManageAccess: false,
      }),
    ).toBe(true);
    expect(
      shouldOpenPreviewInNewTab({
        currentAuthPolicy: "remote-reachable",
        currentDeviceType: "tablet",
        currentSessionCanManageAccess: false,
      }),
    ).toBe(true);
  });

  it("keeps access-managing and unknown sessions on the browser-agent flow", () => {
    expect(
      shouldOpenPreviewInNewTab({
        currentAuthPolicy: "desktop-managed-local",
        currentDeviceType: "desktop",
        currentSessionCanManageAccess: true,
      }),
    ).toBe(false);
    expect(
      shouldOpenPreviewInNewTab({
        currentAuthPolicy: null,
        currentDeviceType: null,
        currentSessionCanManageAccess: false,
      }),
    ).toBe(false);
  });
});

describe("detectBrowserDeviceType", () => {
  it("uses the browser mobile client hint before user-agent parsing", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      userAgentData: {
        mobile: true,
      },
    });

    expect(detectBrowserDeviceType()).toBe("mobile");
  });

  it("detects Android tablet user agents", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    });

    expect(detectBrowserDeviceType()).toBe("tablet");
  });
});

describe("resolvePreviewDeviceType", () => {
  it("keeps mobile frontend detection when the session device looks desktop", () => {
    expect(
      resolvePreviewDeviceType({
        detectedDeviceType: "mobile",
        sessionDeviceType: "desktop",
      }),
    ).toBe("mobile");
  });

  it("keeps mobile session metadata when the frontend fallback looks desktop", () => {
    expect(
      resolvePreviewDeviceType({
        detectedDeviceType: "desktop",
        sessionDeviceType: "mobile",
      }),
    ).toBe("mobile");
  });
});
