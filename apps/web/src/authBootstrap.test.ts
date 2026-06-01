import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    ...init,
  });
}

type TestWindow = {
  location: URL;
  history: {
    replaceState: (_data: unknown, _unused: string, url: string) => void;
  };
  sessionStorage: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
  };
  desktopBridge?: DesktopBridge;
};

function installTestBrowser(url: string) {
  const sessionStorage = new Map<string, string>();
  const testWindow: TestWindow = {
    location: new URL(url),
    history: {
      replaceState: (_data, _unused, nextUrl) => {
        testWindow.location = new URL(nextUrl, testWindow.location.href);
      },
    },
    sessionStorage: {
      getItem: (key) => sessionStorage.get(key) ?? null,
      setItem: (key, value) => {
        sessionStorage.set(key, value);
      },
    },
  };

  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("document", { title: "T3 Code" });

  return testWindow;
}

function sessionResponse(body: unknown, init?: ResponseInit) {
  return jsonResponse(body, init);
}

describe("resolveInitialServerAuthGateState", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    installTestBrowser("http://localhost/");
  });

  afterEach(async () => {
    const { __resetServerAuthBootstrapForTests } = await import("./environments/primary");
    __resetServerAuthBootstrapForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reuses an in-flight silent bootstrap attempt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const testWindow = installTestBrowser("http://localhost/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstrap: () => ({
        label: "Local environment",
        httpBaseUrl: "http://localhost:3773",
        wsBaseUrl: "ws://localhost:3773",
        bootstrapToken: "desktop-bootstrap-token",
      }),
    } as DesktopBridge;

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await Promise.all([resolveInitialServerAuthGateState(), resolveInitialServerAuthGateState()]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:3773/api/auth/session");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:3773/api/auth/bootstrap");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("http://localhost:3773/api/auth/session");
  });

  it("uses https fetch urls when the primary environment uses wss", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/api/auth/session", {
      credentials: "include",
    });
  });

  it("uses the current origin as an auth proxy base for local dev environments", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    installTestBrowser("http://localhost:5735/");

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:5735/api/auth/session", {
      credentials: "include",
    });
  });

  it("uses the vite proxy for desktop-managed loopback auth requests during local dev", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "desktop-managed-local",
          bootstrapMethods: ["desktop-bootstrap"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5733");

    const testWindow = installTestBrowser("http://127.0.0.1:5733/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstrap: () => ({
        label: "Local environment",
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
      }),
    } as DesktopBridge;

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "desktop-managed-local",
        bootstrapMethods: ["desktop-bootstrap"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:5733/api/auth/session", {
      credentials: "include",
    });
  });

  it("returns a requires-auth state instead of throwing when no bootstrap credential exists", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });
  });

  it("uses a browser transfer pairing token before route redirects can drop it", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const testWindow = installTestBrowser(
      "http://localhost/_chat/environment-1/thread-1?t3BrowserTransfer=1#token=pairing-token",
    );

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(testWindow.location.hash).toBe("");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/api/auth/bootstrap", {
      body: JSON.stringify({ credential: "pairing-token" }),
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
  });

  it("accepts same-session bearer tokens for browser-agent sidebar chat frames", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: true,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie", "bearer-session-token"],
          sessionCookieName: "t3_session",
        },
        role: "client",
        sessionMethod: "bearer-session-token",
        expiresAt: "2026-04-05T00:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const testWindow = installTestBrowser(
      "http://localhost/environment-1/thread-1?browserAgentSidebar=1#token=sidebar-session-token",
    );

    const { readPrimaryBrowserAgentSidebarSessionToken, resolveInitialServerAuthGateState } =
      await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(testWindow.location.hash).toBe("");
    expect(readPrimaryBrowserAgentSidebarSessionToken()).toBe("sidebar-session-token");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/api/auth/session", {
      credentials: "include",
      headers: {
        authorization: "Bearer sidebar-session-token",
      },
    });
  });

  it("prioritizes browser-agent sidebar bearer tokens over existing cookie sessions", async () => {
    const auth = {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
    } as const;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.authorization === "Bearer sidebar-session-token") {
        return sessionResponse({
          authenticated: true,
          auth,
          role: "client",
          sessionMethod: "bearer-session-token",
          expiresAt: "2026-04-05T00:00:00.000Z",
        });
      }

      return sessionResponse({
        authenticated: true,
        auth,
        role: "owner",
        sessionMethod: "browser-session-cookie",
        expiresAt: "2026-04-05T00:00:00.000Z",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const testWindow = installTestBrowser(
      "http://localhost/environment-1/thread-1?browserAgentSidebar=1#token=sidebar-session-token",
    );

    const { readPrimaryBrowserAgentSidebarSessionToken, resolveInitialServerAuthGateState } =
      await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(testWindow.location.hash).toBe("");
    expect(readPrimaryBrowserAgentSidebarSessionToken()).toBe("sidebar-session-token");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/api/auth/session", {
      credentials: "include",
      headers: {
        authorization: "Bearer sidebar-session-token",
      },
    });
  });

  it("retries transient auth session bootstrap failures after restart", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    const gateStatePromise = resolveInitialServerAuthGateState();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(gateStatePromise).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("takes a pairing token from the location hash and strips it immediately", async () => {
    const testWindow = installTestBrowser("http://localhost/#token=pairing-token");
    const { takePairingTokenFromUrl } = await import("./environments/primary");

    expect(takePairingTokenFromUrl()).toBe("pairing-token");
    expect(testWindow.location.hash).toBe("");
    expect(testWindow.location.searchParams.get("token")).toBeNull();
  });

  it("accepts query-string pairing tokens as a backward-compatible fallback", async () => {
    const testWindow = installTestBrowser("http://localhost/?token=pairing-token");
    const { takePairingTokenFromUrl } = await import("./environments/primary");

    expect(takePairingTokenFromUrl()).toBe("pairing-token");
    expect(testWindow.location.searchParams.get("token")).toBeNull();
  });

  it("allows manual token submission after the initial auth check requires pairing", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    installTestBrowser("http://localhost/");

    const { resolveInitialServerAuthGateState, submitServerAuthCredential } =
      await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });
    await expect(submitServerAuthCredential("retry-token")).resolves.toBeUndefined();
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces a friendly error message when an invalid pairing token is submitted", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(
        {
          error: "Invalid bootstrap credential.",
        },
        {
          status: 401,
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { submitServerAuthCredential } = await import("./environments/primary");

    await expect(submitServerAuthCredential("bad-token")).rejects.toThrow(
      "Invalid pairing token. Check the token and try again.",
    );
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/api/auth/bootstrap", {
      body: JSON.stringify({ credential: "bad-token" }),
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
  });

  it("waits for the authenticated session to become observable after silent desktop bootstrap", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const testWindow = installTestBrowser("http://localhost/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstrap: () => ({
        label: "Local environment",
        httpBaseUrl: "http://localhost:3773",
        wsBaseUrl: "ws://localhost:3773",
        bootstrapToken: "desktop-bootstrap-token",
      }),
    } as DesktopBridge;

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    const gateStatePromise = resolveInitialServerAuthGateState();
    await vi.advanceTimersByTimeAsync(100);

    await expect(gateStatePromise).resolves.toEqual({
      status: "authenticated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("http://localhost:3773/api/auth/session");
    expect(fetchMock.mock.calls[3]?.[0]).toBe("http://localhost:3773/api/auth/session");
  });

  it("memoizes the authenticated gate state after the first successful read", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates a pairing credential from the authenticated auth endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        id: "pairing-link-1",
        credential: "pairing-token",
        label: "Julius iPhone",
        expiresAt: "2026-04-05T00:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createServerPairingCredential } = await import("./environments/primary");

    await expect(createServerPairingCredential("Julius iPhone")).resolves.toEqual({
      id: "pairing-link-1",
      credential: "pairing-token",
      label: "Julius iPhone",
      expiresAt: "2026-04-05T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/api/auth/pairing-token", {
      body: JSON.stringify({ label: "Julius iPhone" }),
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
  });

  it("creates a same-session bearer token from the authenticated auth endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        authenticated: true,
        role: "client",
        sessionMethod: "bearer-session-token",
        sessionToken: "session-token",
        expiresAt: "2026-04-05T00:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createServerSessionBearerToken } = await import("./environments/primary");

    await expect(createServerSessionBearerToken()).resolves.toEqual({
      authenticated: true,
      role: "client",
      sessionMethod: "bearer-session-token",
      sessionToken: "session-token",
      expiresAt: "2026-04-05T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/api/auth/session/bearer-token", {
      credentials: "include",
      method: "POST",
    });
  });
});
