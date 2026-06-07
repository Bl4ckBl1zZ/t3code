import {
  LOCAL_BROWSER_AGENT_SESSION_ID,
  type BrowserAgentListResult,
  type BrowserAgentSessionResult,
} from "@t3tools/contracts";
import {
  BROWSER_AGENT_AUTO_PAIR_PATH,
  BROWSER_AGENT_EXTENSION_DOWNLOAD_PATH,
} from "@t3tools/shared/browserAgent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  autoPairBrowserAgent,
  BrowserAgentExtensionUnavailableError,
  buildBrowserAgentAutoPairUrl,
  buildBrowserAgentExtensionDownloadUrl,
  isBrowserAgentExtensionUnavailableError,
  isNoBrowserAgentConnectedError,
  resolveBrowserAgentAutoConnectBaseUrls,
  resolveBrowserAgentBackendBaseUrl,
  waitForBrowserAgentConnection,
} from "./browserAgentPairing";
import { useUiStateStore } from "./uiStateStore";

function installWindow(url: string, desktopBridge?: unknown) {
  vi.stubGlobal("window", {
    location: new URL(url),
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    postMessage: vi.fn(),
    ...(desktopBridge ? { desktopBridge } : {}),
  });
}

function snapshot(connected: boolean): BrowserAgentListResult {
  return {
    currentSessionId: null,
    agents: connected ? [{ connected }] : [],
    tabs: [],
    workspaceLinks: [],
  } as unknown as BrowserAgentListResult;
}

describe("browser agent pairing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: null });
  });

  it("builds an auto-pair URL on the backend origin", () => {
    const url = new URL(
      buildBrowserAgentAutoPairUrl({
        baseUrl: "http://100.105.249.96:3773/some/path",
        credential: "pairing-token",
      }),
    );

    expect(url.origin).toBe("http://100.105.249.96:3773");
    expect(url.pathname).toBe(BROWSER_AGENT_AUTO_PAIR_PATH);
    expect(url.searchParams.get("t3BrowserAgentPair")).toBe("1");
    expect(url.searchParams.get("t3BrowserAgentBaseUrl")).toBe("http://100.105.249.96:3773/");
    expect(url.toString()).not.toContain("t3BrowserAgentSessionToken");
    expect(new URLSearchParams(url.hash.slice(1)).get("t3BrowserAgentCredential")).toBe(
      "pairing-token",
    );
  });

  it("builds an auto-pair URL that can reuse the current browser session", () => {
    const url = new URL(
      buildBrowserAgentAutoPairUrl({
        baseUrl: "http://100.105.249.96:3773/some/path",
        useBrowserSession: true,
      }),
    );

    expect(url.origin).toBe("http://100.105.249.96:3773");
    expect(url.pathname).toBe(BROWSER_AGENT_AUTO_PAIR_PATH);
    expect(url.searchParams.get("t3BrowserAgentPair")).toBe("1");
    expect(url.searchParams.get("t3BrowserAgentUseBrowserSession")).toBe("1");
    expect(new URLSearchParams(url.hash.slice(1)).get("t3BrowserAgentCredential")).toBeNull();
  });

  it("builds an extension download URL on the backend origin", () => {
    const url = new URL(
      buildBrowserAgentExtensionDownloadUrl({
        baseUrl: "http://100.105.249.96:3773/some/path",
      }),
    );

    expect(url.origin).toBe("http://100.105.249.96:3773");
    expect(url.pathname).toBe(BROWSER_AGENT_EXTENSION_DOWNLOAD_PATH);
  });

  it("uses the configured backend target instead of the current dev proxy origin", async () => {
    installWindow("http://127.0.0.1:5733/", {
      getLocalEnvironmentBootstrap: () => ({
        environmentId: "environment-local",
        httpBaseUrl: "http://100.105.249.96:3773/",
        wsBaseUrl: "ws://100.105.249.96:3773/",
      }),
    });

    await expect(resolveBrowserAgentBackendBaseUrl()).resolves.toBe("http://100.105.249.96:3773/");
  });

  it("uses the saved default advertised endpoint for browser agent pairing", async () => {
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: "tailscale:ip:http" });
    installWindow("http://127.0.0.1:5733/", {
      getAdvertisedEndpoints: () =>
        Promise.resolve([
          {
            id: "desktop-loopback:127.0.0.1",
            label: "This machine",
            provider: {
              id: "desktop-core",
              label: "Desktop",
              kind: "core",
              isAddon: false,
            },
            httpBaseUrl: "http://127.0.0.1:3773/",
            wsBaseUrl: "ws://127.0.0.1:3773/",
            reachability: "loopback",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "desktop-core",
            status: "available",
            isDefault: true,
          },
          {
            id: "tailscale-ip:100.105.249.96",
            label: "Tailscale IP",
            provider: {
              id: "tailscale",
              label: "Tailscale",
              kind: "addon",
              isAddon: true,
            },
            httpBaseUrl: "http://100.105.249.96:3773/",
            wsBaseUrl: "ws://100.105.249.96:3773/",
            reachability: "private-network",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "desktop-core",
            status: "available",
          },
        ]),
      getLocalEnvironmentBootstrap: () => ({
        environmentId: "environment-local",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      }),
    });

    await expect(resolveBrowserAgentBackendBaseUrl()).resolves.toBe("http://100.105.249.96:3773/");
  });

  it("prefers Tailscale HTTPS for browser agent pairing when the saved default is Tailscale IP", async () => {
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: "tailscale:ip:http" });
    installWindow("http://127.0.0.1:5733/", {
      getAdvertisedEndpoints: () =>
        Promise.resolve([
          {
            id: "tailscale-ip:100.105.249.96",
            label: "Tailscale IP",
            provider: {
              id: "tailscale",
              label: "Tailscale",
              kind: "private-network",
              isAddon: true,
            },
            httpBaseUrl: "http://100.105.249.96:3773/",
            wsBaseUrl: "ws://100.105.249.96:3773/",
            reachability: "private-network",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "desktop-addon",
            status: "available",
          },
          {
            id: "tailscale-magicdns:https://desktop.tail.ts.net/",
            label: "Tailscale HTTPS",
            provider: {
              id: "tailscale",
              label: "Tailscale",
              kind: "private-network",
              isAddon: true,
            },
            httpBaseUrl: "https://desktop.tail.ts.net/",
            wsBaseUrl: "wss://desktop.tail.ts.net/",
            reachability: "private-network",
            compatibility: {
              hostedHttpsApp: "compatible",
              desktopApp: "compatible",
            },
            source: "desktop-addon",
            status: "available",
          },
        ]),
      getLocalEnvironmentBootstrap: () => ({
        environmentId: "environment-local",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      }),
    });

    await expect(resolveBrowserAgentBackendBaseUrl()).resolves.toBe("https://desktop.tail.ts.net/");
  });

  it("tries loopback advertised endpoints first for browser agent auto-connect", async () => {
    installWindow("http://100.105.249.96:3773/", {
      getAdvertisedEndpoints: () =>
        Promise.resolve([
          {
            httpBaseUrl: "http://100.105.249.96:3773/",
            reachability: "private-network",
          },
          {
            httpBaseUrl: "http://127.0.0.1:4277/",
            reachability: "loopback",
          },
        ]),
      getLocalEnvironmentBootstrap: () => ({
        environmentId: "environment-local",
        httpBaseUrl: "http://127.0.0.1:4277/",
        wsBaseUrl: "ws://127.0.0.1:4277/",
      }),
    });

    await expect(
      resolveBrowserAgentAutoConnectBaseUrls("http://100.105.249.96:3773/"),
    ).resolves.toEqual(["http://127.0.0.1:4277/", "http://100.105.249.96:3773/"]);
  });

  it("pairs the same-origin extension through the browser's host session", async () => {
    let messageListener: ((event: MessageEvent) => void) | null = null;
    let pairRequest: Record<string, unknown> | null = null;
    const windowStub = {
      location: new URL("https://desktop.tail.ts.net/"),
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "message" && typeof listener === "function") {
          messageListener = listener as (event: MessageEvent) => void;
        }
      }),
      removeEventListener: vi.fn(),
      postMessage: vi.fn((message: Record<string, unknown>) => {
        pairRequest = message;
        setTimeout(() => {
          messageListener?.({
            source: windowStub,
            data: {
              type: "t3code.browserAgent.autoPair.result",
              requestId: message.requestId,
              ok: true,
              sessionId: "session-browser",
            },
          } as unknown as MessageEvent);
        }, 0);
      }),
    };
    vi.stubGlobal("window", windowStub);
    const fetchMock = vi.fn<(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      browserAgents: {
        list: vi.fn<() => Promise<BrowserAgentListResult>>().mockResolvedValue({
          currentSessionId: "session-page",
          agents: [{ id: "browser-agent:issued", connected: true, sessionId: "session-browser" }],
          tabs: [],
          workspaceLinks: [],
        } as unknown as BrowserAgentListResult),
      },
    };

    await expect(
      autoPairBrowserAgent(client, {
        baseUrl: "https://desktop.tail.ts.net/",
        allowExternalBrowserLaunch: false,
      }),
    ).resolves.toEqual({
      preferredAgentId: "browser-agent:issued",
      preferredSessionId: "session-browser",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(pairRequest).toMatchObject({
      type: "t3code.browserAgent.autoPair",
      baseUrl: "https://desktop.tail.ts.net/",
      useBrowserSession: true,
    });
    expect(pairRequest).not.toHaveProperty("sessionToken");
    expect(client.browserAgents.list).toHaveBeenCalledTimes(1);
  });

  it("does not mint a browser-agent token through the authenticated RPC connection", async () => {
    let messageListener: ((event: MessageEvent) => void) | null = null;
    let pairRequest: Record<string, unknown> | null = null;
    const windowStub = {
      location: new URL("https://desktop.tail.ts.net/"),
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "message" && typeof listener === "function") {
          messageListener = listener as (event: MessageEvent) => void;
        }
      }),
      removeEventListener: vi.fn(),
      postMessage: vi.fn((message: Record<string, unknown>) => {
        pairRequest = message;
        setTimeout(() => {
          messageListener?.({
            source: windowStub,
            data: {
              type: "t3code.browserAgent.autoPair.result",
              requestId: message.requestId,
              ok: true,
              sessionId: "session-browser",
            },
          } as unknown as MessageEvent);
        }, 0);
      }),
    };
    vi.stubGlobal("window", windowStub);
    const fetchMock = vi.fn<(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
    const issueSession = vi.fn<() => Promise<BrowserAgentSessionResult>>().mockResolvedValue({
      sessionId: "session-rpc" as BrowserAgentSessionResult["sessionId"],
      sessionToken: "token-rpc" as BrowserAgentSessionResult["sessionToken"],
    });
    const client = {
      browserAgents: {
        issueSession,
        list: vi.fn<() => Promise<BrowserAgentListResult>>().mockResolvedValue({
          currentSessionId: "session-page",
          agents: [{ id: "browser-agent:rpc", connected: true, sessionId: "session-browser" }],
          tabs: [],
          workspaceLinks: [],
        } as unknown as BrowserAgentListResult),
      },
    };

    await expect(
      autoPairBrowserAgent(client, {
        baseUrl: "https://desktop.tail.ts.net/",
        allowExternalBrowserLaunch: false,
      }),
    ).resolves.toEqual({
      preferredAgentId: "browser-agent:rpc",
      preferredSessionId: "session-browser",
    });

    expect(issueSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pairRequest).toMatchObject({
      type: "t3code.browserAgent.autoPair",
      baseUrl: "https://desktop.tail.ts.net/",
      useBrowserSession: true,
    });
    expect(pairRequest).not.toHaveProperty("sessionToken");
    expect(client.browserAgents.list).toHaveBeenCalledTimes(1);
  });

  it("falls back to browser-host setup when browser-session pairing is rejected", async () => {
    let messageListener: ((event: MessageEvent) => void) | null = null;
    const pairRequests: Record<string, unknown>[] = [];
    const windowStub = {
      location: new URL("https://desktop.tail.ts.net/"),
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "message" && typeof listener === "function") {
          messageListener = listener as (event: MessageEvent) => void;
        }
      }),
      removeEventListener: vi.fn(),
      postMessage: vi.fn((message: Record<string, unknown>) => {
        pairRequests.push(message);
        setTimeout(() => {
          messageListener?.({
            source: windowStub,
            data: {
              type: "t3code.browserAgent.autoPair.result",
              requestId: message.requestId,
              ok: false,
              error:
                "This browser is not authenticated to this T3 Code host. Open the T3 Code host in this browser, pair or sign in there, then retry Preview.",
            },
          } as unknown as MessageEvent);
        }, 0);
      }),
    };
    vi.stubGlobal("window", windowStub);
    const fetchMock = vi.fn<(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
    const issueSession = vi.fn<() => Promise<BrowserAgentSessionResult>>().mockResolvedValue({
      sessionId: "session-rpc" as BrowserAgentSessionResult["sessionId"],
      sessionToken: "token-rpc" as BrowserAgentSessionResult["sessionToken"],
    });
    const client = {
      browserAgents: {
        issueSession,
        list: vi.fn<() => Promise<BrowserAgentListResult>>().mockResolvedValue({
          currentSessionId: "session-page",
          agents: [{ id: "browser-agent:http", connected: true, sessionId: "session-http" }],
          tabs: [],
          workspaceLinks: [],
        } as unknown as BrowserAgentListResult),
      },
    };

    let caught: unknown = null;
    try {
      await autoPairBrowserAgent(client, {
        baseUrl: "https://desktop.tail.ts.net/",
        allowExternalBrowserLaunch: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(isBrowserAgentExtensionUnavailableError(caught)).toBe(true);
    if (!isBrowserAgentExtensionUnavailableError(caught)) {
      throw new Error("Expected BrowserAgentExtensionUnavailableError.");
    }
    expect(issueSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pairRequests).toHaveLength(1);
    expect(pairRequests[0]).toMatchObject({
      type: "t3code.browserAgent.autoPair",
      baseUrl: "https://desktop.tail.ts.net/",
      useBrowserSession: true,
    });
    expect(pairRequests[0]).not.toHaveProperty("sessionToken");
    const setupUrl = new URL(caught.setupUrl);
    expect(setupUrl.searchParams.get("t3BrowserAgentUseBrowserSession")).toBe("1");
    expect(
      new URLSearchParams(setupUrl.hash.slice(1)).get("t3BrowserAgentSessionToken"),
    ).toBeNull();
  });

  it("keeps manual setup browser-session based when browser-session pairing is rejected", async () => {
    let messageListener: ((event: MessageEvent) => void) | null = null;
    const pairRequests: Record<string, unknown>[] = [];
    const windowStub = {
      location: new URL("https://desktop.tail.ts.net/"),
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "message" && typeof listener === "function") {
          messageListener = listener as (event: MessageEvent) => void;
        }
      }),
      removeEventListener: vi.fn(),
      postMessage: vi.fn((message: Record<string, unknown>) => {
        pairRequests.push(message);
        setTimeout(() => {
          messageListener?.({
            source: windowStub,
            data: {
              type: "t3code.browserAgent.autoPair.result",
              requestId: message.requestId,
              ok: false,
              error: "The backend rejected the browser agent session token.",
            },
          } as unknown as MessageEvent);
        }, 0);
      }),
    };
    vi.stubGlobal("window", windowStub);
    const fetchMock = vi.fn<(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
    const issueSession = vi.fn<() => Promise<BrowserAgentSessionResult>>().mockResolvedValue({
      sessionId: "session-rpc" as BrowserAgentSessionResult["sessionId"],
      sessionToken: "token-rpc" as BrowserAgentSessionResult["sessionToken"],
    });
    const client = {
      browserAgents: {
        issueSession,
        list: vi.fn<() => Promise<BrowserAgentListResult>>().mockResolvedValue({
          currentSessionId: "session-page",
          agents: [],
          tabs: [],
          workspaceLinks: [],
        } as unknown as BrowserAgentListResult),
      },
    };

    let caught: unknown = null;
    try {
      await autoPairBrowserAgent(client, {
        baseUrl: "https://desktop.tail.ts.net/",
        allowExternalBrowserLaunch: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(isBrowserAgentExtensionUnavailableError(caught)).toBe(true);
    if (!isBrowserAgentExtensionUnavailableError(caught)) {
      throw new Error("Expected BrowserAgentExtensionUnavailableError.");
    }
    expect(issueSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pairRequests).toHaveLength(1);
    expect(pairRequests[0]).toMatchObject({
      type: "t3code.browserAgent.autoPair",
      baseUrl: "https://desktop.tail.ts.net/",
      useBrowserSession: true,
    });
    expect(pairRequests[0]).not.toHaveProperty("sessionToken");
    const setupUrl = new URL(caught.setupUrl);
    expect(setupUrl.searchParams.get("t3BrowserAgentUseBrowserSession")).toBe("1");
    expect(
      new URLSearchParams(setupUrl.hash.slice(1)).get("t3BrowserAgentSessionToken"),
    ).toBeNull();
  });

  it("uses the connected local-control extension when the browser-issued session does not register", async () => {
    let messageListener: ((event: MessageEvent) => void) | null = null;
    const windowStub = {
      location: new URL("https://desktop.tail.ts.net/"),
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "message" && typeof listener === "function") {
          messageListener = listener as (event: MessageEvent) => void;
        }
      }),
      removeEventListener: vi.fn(),
      postMessage: vi.fn((message: Record<string, unknown>) => {
        setTimeout(() => {
          messageListener?.({
            source: windowStub,
            data: {
              type: "t3code.browserAgent.autoPair.result",
              requestId: message.requestId,
              ok: true,
              sessionId: "session-issued",
            },
          } as unknown as MessageEvent);
        }, 0);
      }),
    };
    vi.stubGlobal("window", windowStub);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              sessionId: "session-issued",
              sessionToken: "token-issued",
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          ),
        ),
    );
    const client = {
      browserAgents: {
        list: vi.fn<() => Promise<BrowserAgentListResult>>().mockResolvedValue({
          currentSessionId: "session-page",
          agents: [
            {
              id: "browser-agent:local-control",
              connected: true,
              sessionId: LOCAL_BROWSER_AGENT_SESSION_ID,
              lastSeenAt: "2026-01-01T00:00:02.000Z",
            },
            {
              id: "browser-agent:remote",
              connected: true,
              sessionId: "session-saved",
              lastSeenAt: "2026-01-01T00:00:01.000Z",
            },
          ],
          tabs: [],
          workspaceLinks: [],
        } as unknown as BrowserAgentListResult),
      },
    };

    await expect(
      autoPairBrowserAgent(client, {
        baseUrl: "https://desktop.tail.ts.net/",
        allowExternalBrowserLaunch: false,
      }),
    ).resolves.toEqual({
      preferredAgentId: "browser-agent:local-control",
      preferredSessionId: null,
    });
  });

  it("uses an already connected extension when the app tab has no pairing content script", async () => {
    const windowStub = {
      location: new URL("https://desktop.tail.ts.net/"),
      setTimeout: vi.fn((callback: () => void) => {
        callback();
        return 1;
      }),
      clearTimeout: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
    };
    vi.stubGlobal("window", windowStub);
    const client = {
      browserAgents: {
        list: vi.fn<() => Promise<BrowserAgentListResult>>().mockResolvedValue({
          currentSessionId: "session-page",
          agents: [
            {
              id: "browser-agent:local-control",
              connected: true,
              sessionId: LOCAL_BROWSER_AGENT_SESSION_ID,
              lastSeenAt: "2026-01-01T00:00:02.000Z",
            },
          ],
          tabs: [],
          workspaceLinks: [],
        } as unknown as BrowserAgentListResult),
      },
    };

    await expect(
      autoPairBrowserAgent(client, {
        baseUrl: "https://desktop.tail.ts.net/",
        allowExternalBrowserLaunch: false,
      }),
    ).resolves.toEqual({
      preferredAgentId: "browser-agent:local-control",
      preferredSessionId: null,
    });

    expect(windowStub.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "t3code.browserAgent.autoPair",
        useBrowserSession: true,
      }),
      "https://desktop.tail.ts.net",
    );
    expect(client.browserAgents.list).toHaveBeenCalledTimes(1);
  });

  it("opens manual setup with browser-session issuance when the content script is unavailable", async () => {
    const windowStub = {
      location: new URL("https://desktop.tail.ts.net/"),
      setTimeout: vi.fn((callback: () => void) => {
        callback();
        return 1;
      }),
      clearTimeout: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
    };
    vi.stubGlobal("window", windowStub);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              sessionId: "session-issued",
              sessionToken: "token-issued",
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          ),
        ),
    );
    const client = {
      browserAgents: {
        list: vi.fn<() => Promise<BrowserAgentListResult>>().mockResolvedValue({
          currentSessionId: "session-page",
          agents: [],
          tabs: [],
          workspaceLinks: [],
        } as unknown as BrowserAgentListResult),
      },
    };

    let caught: unknown = null;
    try {
      await autoPairBrowserAgent(client, {
        baseUrl: "https://desktop.tail.ts.net/",
        allowExternalBrowserLaunch: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(isBrowserAgentExtensionUnavailableError(caught)).toBe(true);
    if (!isBrowserAgentExtensionUnavailableError(caught)) {
      throw new Error("Expected BrowserAgentExtensionUnavailableError.");
    }
    const setupUrl = new URL(caught.setupUrl);
    expect(setupUrl.searchParams.get("t3BrowserAgentUseBrowserSession")).toBe("1");
    expect(
      new URLSearchParams(setupUrl.hash.slice(1)).get("t3BrowserAgentSessionToken"),
    ).toBeNull();
  });

  it("detects the no-agent RPC failure", () => {
    expect(isNoBrowserAgentConnectedError({ code: "no-agent-connected" })).toBe(true);
    expect(
      isNoBrowserAgentConnectedError(new Error("No paired browser extension is connected.")),
    ).toBe(true);
    expect(
      isNoBrowserAgentConnectedError(
        new Error("No browser extension local-control session is connected."),
      ),
    ).toBe(true);
    expect(isNoBrowserAgentConnectedError(new Error("Different failure"))).toBe(false);
  });

  it("detects the extension unavailable pairing failure", () => {
    const error = new BrowserAgentExtensionUnavailableError({
      downloadUrl: "http://localhost:3773/downloads/t3-code-browser-agent.zip",
    });

    expect(isBrowserAgentExtensionUnavailableError(error)).toBe(true);
    expect(isBrowserAgentExtensionUnavailableError(new Error("Different failure"))).toBe(false);
  });

  it("waits until a browser agent connects", async () => {
    installWindow("http://localhost/");
    const client = {
      browserAgents: {
        list: vi
          .fn<() => Promise<BrowserAgentListResult>>()
          .mockResolvedValueOnce(snapshot(false))
          .mockResolvedValueOnce(snapshot(true)),
      },
    };

    await expect(
      waitForBrowserAgentConnection(client, {
        timeoutMs: 100,
        pollIntervalMs: 1,
      }),
    ).resolves.toBeUndefined();
    expect(client.browserAgents.list).toHaveBeenCalledTimes(2);
  });

  it("waits until the requested browser agent session connects", async () => {
    installWindow("http://localhost/");
    const client = {
      browserAgents: {
        list: vi
          .fn<() => Promise<BrowserAgentListResult>>()
          .mockResolvedValueOnce({
            currentSessionId: "session-current",
            agents: [{ connected: true, sessionId: "session-other" }],
            tabs: [],
            workspaceLinks: [],
          } as unknown as BrowserAgentListResult)
          .mockResolvedValueOnce({
            currentSessionId: "session-current",
            agents: [{ connected: true, sessionId: "session-extension" }],
            tabs: [],
            workspaceLinks: [],
          } as unknown as BrowserAgentListResult),
      },
    };

    await expect(
      waitForBrowserAgentConnection(client, {
        sessionId: "session-extension",
        timeoutMs: 100,
        pollIntervalMs: 1,
      }),
    ).resolves.toBeUndefined();
    expect(client.browserAgents.list).toHaveBeenCalledTimes(2);
  });

  it("accepts a browser agent connected from a different client session", async () => {
    installWindow("http://localhost/");
    const client = {
      browserAgents: {
        list: vi.fn<() => Promise<BrowserAgentListResult>>().mockResolvedValue({
          currentSessionId: "session-current",
          agents: [{ connected: true, sessionId: "session-other" }],
          tabs: [],
          workspaceLinks: [],
        } as unknown as BrowserAgentListResult),
      },
    };

    await expect(
      waitForBrowserAgentConnection(client, {
        timeoutMs: 100,
        pollIntervalMs: 1,
      }),
    ).resolves.toBeUndefined();
    expect(client.browserAgents.list).toHaveBeenCalledTimes(1);
  });

  it("includes the last browser-agent snapshot when pairing times out", async () => {
    installWindow("http://localhost/");
    const client = {
      browserAgents: {
        list: vi.fn<() => Promise<BrowserAgentListResult>>().mockResolvedValue({
          currentSessionId: "session-current",
          agents: [{ connected: false, sessionId: "session-other" }],
          tabs: [],
          workspaceLinks: [],
        } as unknown as BrowserAgentListResult),
      },
    };

    await expect(
      waitForBrowserAgentConnection(client, {
        timeoutMs: 1,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(
      "currentSessionId=session-current, currentSessionAgents=0, connectedAgents=0",
    );
  });
});
