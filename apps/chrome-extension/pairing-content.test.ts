import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { expect, it, vi } from "vite-plus/test";

const pairingContentPath = fileURLToPath(new URL("./pairing-content.js", import.meta.url));

function makeDocument() {
  const createElement = (tagName: string) => ({
    tagName,
    textContent: "",
    style: {} as Record<string, string>,
    append: vi.fn(),
  });
  return {
    title: "T3 Code",
    documentElement: { style: {} as Record<string, string> },
    createElement,
    body: {
      innerHTML: "",
      style: {} as Record<string, string>,
      append: vi.fn(),
    },
  };
}

it("retries setup URL pairing with a fresh browser-agent session when the embedded token is rejected", async () => {
  const runtimeMessages: Array<Record<string, unknown>> = [];
  const pairingContentSource = readFileSync(pairingContentPath, "utf8");
  const url =
    "https://desktop.tail.ts.net/browser-agent/auto-pair?" +
    "t3BrowserAgentPair=1&t3BrowserAgentBaseUrl=https%3A%2F%2Fdesktop.tail.ts.net%2F" +
    "#t3BrowserAgentSessionToken=stale-token";
  const document = makeDocument();
  const context = {
    URL,
    URLSearchParams,
    console,
    document,
    globalThis: {} as Record<string, unknown>,
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          sessionId: "fresh-session",
          sessionToken: "fresh-token",
        }),
    }),
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage: vi.fn(
          (message: Record<string, unknown>, callback: (response: unknown) => void) => {
            runtimeMessages.push(message);
            callback(
              runtimeMessages.length === 1
                ? {
                    ok: false,
                    error: "The backend rejected the browser agent session token.",
                  }
                : { ok: true },
            );
          },
        ),
      },
    },
    window: {
      location: new URL(url),
      history: {
        replaceState: vi.fn(),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  };
  context.globalThis = context;

  vm.runInNewContext(pairingContentSource, context);

  await vi.waitFor(() => {
    expect(runtimeMessages).toHaveLength(2);
  });

  expect(runtimeMessages[0]).toMatchObject({
    type: "t3code.browserAgent.pair",
    baseUrl: "https://desktop.tail.ts.net/",
    sessionToken: "stale-token",
  });
  expect(context.fetch).toHaveBeenCalledWith(new URL("/browser-agent/session", url), {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "application/json",
    },
  });
  expect(runtimeMessages[1]).toMatchObject({
    type: "t3code.browserAgent.pair",
    baseUrl: "https://desktop.tail.ts.net/",
    sessionToken: "fresh-token",
  });
  const renderedPanel = document.body.append.mock.calls.at(-1)?.[0];
  expect(renderedPanel?.append).toHaveBeenLastCalledWith(
    expect.objectContaining({
      textContent: "Browser paired",
    }),
    expect.objectContaining({
      textContent: "Returning to T3 Code.",
    }),
  );
});

it("uses browser-session issuance before an embedded token on setup URLs", async () => {
  const runtimeMessages: Array<Record<string, unknown>> = [];
  const pairingContentSource = readFileSync(pairingContentPath, "utf8");
  const url =
    "https://desktop.tail.ts.net/browser-agent/auto-pair?" +
    "t3BrowserAgentPair=1&t3BrowserAgentBaseUrl=https%3A%2F%2Fdesktop.tail.ts.net%2F" +
    "&t3BrowserAgentUseBrowserSession=1" +
    "#t3BrowserAgentSessionToken=stale-token";
  const document = makeDocument();
  const context = {
    URL,
    URLSearchParams,
    console,
    document,
    globalThis: {} as Record<string, unknown>,
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          sessionId: "browser-session",
          sessionToken: "browser-session-token",
        }),
    }),
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage: vi.fn(
          (message: Record<string, unknown>, callback: (response: unknown) => void) => {
            runtimeMessages.push(message);
            callback({ ok: true });
          },
        ),
      },
    },
    window: {
      location: new URL(url),
      history: {
        replaceState: vi.fn(),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  };
  context.globalThis = context;

  vm.runInNewContext(pairingContentSource, context);

  await vi.waitFor(() => {
    expect(runtimeMessages).toHaveLength(1);
  });

  expect(runtimeMessages[0]).toMatchObject({
    type: "t3code.browserAgent.pair",
    baseUrl: "https://desktop.tail.ts.net/",
    sessionToken: "browser-session-token",
  });
  expect(runtimeMessages[0]).not.toMatchObject({
    sessionToken: "stale-token",
  });
  expect(context.fetch).toHaveBeenCalledWith(new URL("/browser-agent/session", url), {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "application/json",
    },
  });
});
