import type { ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  BROWSER_TRANSFER_EXTENSION_SOURCE,
  BROWSER_TRANSFER_RESULT_MESSAGE,
  DEFAULT_BROWSER_TRANSFER_EXTENSION_PATH,
  buildBrowserTransferUrl,
  createBrowserTransferSetupRequest,
  inferBrowserTransferDevServerUrl,
  isBrowserTransferResultMessage,
  readBrowserTransferSetupRequestFromUrl,
  resolveBrowserRoutePath,
  shouldShowTransferToBrowser,
} from "./browserTransfer";

function script(command: string): ProjectScript {
  return {
    id: "dev",
    name: "Dev",
    command,
    icon: "play",
    runOnWorktreeCreate: false,
  };
}

describe("inferBrowserTransferDevServerUrl", () => {
  it("uses explicit script ports", () => {
    expect(inferBrowserTransferDevServerUrl([script("pnpm dev --port 4173")])).toBe(
      "http://localhost:4173/",
    );
  });

  it("defaults Next.js scripts to port 3000", () => {
    expect(inferBrowserTransferDevServerUrl([script("pnpm next dev")])).toBe(
      "http://localhost:3000/",
    );
  });

  it("defaults Vite scripts to port 5173", () => {
    expect(inferBrowserTransferDevServerUrl([script("pnpm vite --host 0.0.0.0")])).toBe(
      "http://localhost:5173/",
    );
  });
});

describe("resolveBrowserRoutePath", () => {
  it("converts Electron hash routes to browser-history routes", () => {
    const location = new URL("t3://app/#/_chat/environment-1/thread-1?panel=diff") as URL &
      Location;

    expect(resolveBrowserRoutePath(location)).toBe("/_chat/environment-1/thread-1?panel=diff");
  });

  it("keeps browser-history paths when no hash route is present", () => {
    const location = new URL("http://localhost:5733/settings?tab=general") as URL & Location;

    expect(resolveBrowserRoutePath(location)).toBe("/settings?tab=general");
  });
});

describe("buildBrowserTransferUrl", () => {
  it("adds the transfer request and pairing credential", () => {
    const url = new URL(
      buildBrowserTransferUrl({
        t3CodeBaseUrl: "http://127.0.0.1:49876/",
        routePath: "/_chat/environment-1/thread-1",
        pairingCredential: "pairing-token",
        devServerUrl: "http://localhost:3000/",
        groupTitle: "repo-name",
        extensionInstallPath: "/repo/apps/chrome-extension",
        transferId: "transfer-1",
      }),
    );

    expect(url.origin).toBe("http://127.0.0.1:49876");
    expect(url.pathname).toBe("/_chat/environment-1/thread-1");
    expect(url.searchParams.get("t3BrowserTransfer")).toBe("1");
    expect(url.searchParams.get("t3DevServerUrl")).toBe("http://localhost:3000/");
    expect(url.searchParams.get("t3BrowserTransferId")).toBe("transfer-1");
    expect(url.searchParams.get("t3GroupTitle")).toBe("repo-name");
    expect(url.searchParams.get("t3ExtensionPath")).toBe("/repo/apps/chrome-extension");
    expect(url.hash).toBe("#token=pairing-token");
  });
});

describe("readBrowserTransferSetupRequestFromUrl", () => {
  it("reads transfer setup metadata from transfer URLs", () => {
    expect(
      readBrowserTransferSetupRequestFromUrl(
        new URL(
          "http://localhost:5733/?t3BrowserTransfer=1&t3BrowserTransferId=transfer-1&t3DevServerUrl=http%3A%2F%2Flocalhost%3A3000%2F&t3GroupTitle=repo-name&t3ExtensionPath=%2Frepo%2Fapps%2Fchrome-extension",
        ),
      ),
    ).toEqual({
      id: "transfer-1",
      devServerUrl: "http://localhost:3000/",
      groupTitle: "repo-name",
      extensionInstallPath: "/repo/apps/chrome-extension",
    });
  });

  it("ignores regular URLs", () => {
    expect(readBrowserTransferSetupRequestFromUrl(new URL("http://localhost:5733/"))).toBe(null);
  });
});

describe("createBrowserTransferSetupRequest", () => {
  it("normalizes transfer metadata for extension requests", () => {
    expect(
      createBrowserTransferSetupRequest({
        id: "transfer-1",
        devServerUrl: "file:///tmp/index.html",
        groupTitle: "  repo-name  ",
        extensionInstallPath: "  ",
      }),
    ).toEqual({
      id: "transfer-1",
      devServerUrl: "http://localhost:3000/",
      groupTitle: "repo-name",
      extensionInstallPath: DEFAULT_BROWSER_TRANSFER_EXTENSION_PATH,
    });
  });
});

describe("isBrowserTransferResultMessage", () => {
  it("accepts transfer results from the extension bridge", () => {
    expect(
      isBrowserTransferResultMessage({
        source: BROWSER_TRANSFER_EXTENSION_SOURCE,
        type: BROWSER_TRANSFER_RESULT_MESSAGE,
        id: "transfer-1",
        ok: true,
        devTabId: 12,
        groupId: 34,
      }),
    ).toBe(true);
  });

  it("rejects malformed transfer results", () => {
    expect(
      isBrowserTransferResultMessage({
        source: BROWSER_TRANSFER_EXTENSION_SOURCE,
        type: BROWSER_TRANSFER_RESULT_MESSAGE,
        id: "transfer-1",
        ok: "true",
      }),
    ).toBe(false);
  });
});

describe("shouldShowTransferToBrowser", () => {
  it("shows only for desktop primary-environment project threads", () => {
    expect(
      shouldShowTransferToBrowser({
        activeProjectName: "app",
        activeThreadEnvironmentId: "environment-primary",
        primaryEnvironmentId: "environment-primary",
        hasDesktopBridge: true,
      }),
    ).toBe(true);
  });

  it("hides in regular browser sessions", () => {
    expect(
      shouldShowTransferToBrowser({
        activeProjectName: "app",
        activeThreadEnvironmentId: "environment-primary",
        primaryEnvironmentId: "environment-primary",
        hasDesktopBridge: false,
      }),
    ).toBe(false);
  });
});
