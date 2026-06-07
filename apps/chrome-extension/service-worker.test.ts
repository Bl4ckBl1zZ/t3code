import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { expect, it, vi } from "vite-plus/test";

const serviceWorkerPath = fileURLToPath(new URL("./service-worker.js", import.meta.url));

const BACKEND_KEY = "t3code.browserAgent.backend";
const LINKS_KEY = "t3code.browserAgent.workspaceLinks";
const ACTIVE_LINK_KEY = "t3code.browserAgent.activeWorkspaceLink";
const SIDE_PANEL_PATH = "sidepanel.html";

type ChromeTab = {
  active?: boolean;
  groupId?: number;
  id: number;
  title?: string;
  url?: string;
  windowId: number;
};

type EventMock<T extends (...args: Array<never>) => unknown = (...args: Array<never>) => unknown> =
  {
    addListener: ReturnType<typeof vi.fn>;
    listeners: Array<T>;
  };

function makeEvent<T extends (...args: Array<never>) => unknown>(): EventMock<T> {
  const listeners: Array<T> = [];
  return {
    addListener: vi.fn((listener: T) => {
      listeners.push(listener);
    }),
    listeners,
  };
}

function storageChanges(previous: Record<string, unknown>, next: Record<string, unknown>) {
  const changes: Record<string, { oldValue: unknown; newValue: unknown }> = {};
  for (const [key, newValue] of Object.entries(next)) {
    changes[key] = {
      oldValue: previous[key],
      newValue,
    };
  }
  return changes;
}

function makeStorageArea(
  data: Record<string, unknown>,
  onChanged: EventMock<(changes: Record<string, unknown>, areaName: string) => void>,
  areaName: string,
) {
  return {
    get: vi.fn(async (key: string | Array<string>) => {
      if (Array.isArray(key)) {
        return Object.fromEntries(key.map((entry) => [entry, data[entry]]));
      }
      return { [key]: data[key] };
    }),
    remove: vi.fn(async (key: string | Array<string>) => {
      const keys = Array.isArray(key) ? key : [key];
      const changes: Record<string, { oldValue: unknown; newValue: undefined }> = {};
      for (const entry of keys) {
        changes[entry] = {
          oldValue: data[entry],
          newValue: undefined,
        };
        delete data[entry];
      }
      for (const listener of onChanged.listeners) {
        listener(changes, areaName);
      }
    }),
    set: vi.fn(async (value: Record<string, unknown>) => {
      const previous = { ...data };
      Object.assign(data, value);
      const changes = storageChanges(previous, value);
      for (const listener of onChanged.listeners) {
        listener(changes, areaName);
      }
    }),
  };
}

function makeWebSocketClass(options: { openLocalControl?: boolean } = {}) {
  const sentMessages: Array<string> = [];

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
    readonly url: string;
    readyState = MockWebSocket.CONNECTING;

    constructor(url: string) {
      this.url = url;
      queueMicrotask(() => {
        if (options.openLocalControl === true && url.includes("/browser-agent/local-ws")) {
          this.readyState = MockWebSocket.OPEN;
          this.emit("open");
          return;
        }
        this.emit("error");
        this.close();
      });
    }

    addEventListener(type: string, listener: (event?: unknown) => void) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    close() {
      if (this.readyState === MockWebSocket.CLOSED) {
        return;
      }
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close");
    }

    emit(type: string, event?: unknown) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }

    send(message: string) {
      sentMessages.push(message);
    }
  }

  return { MockWebSocket, sentMessages };
}

function makeChromeMock(
  input: {
    localStorage?: Record<string, unknown>;
    tabs?: Array<ChromeTab>;
  } = {},
) {
  const storageOnChanged =
    makeEvent<(changes: Record<string, unknown>, areaName: string) => void>();
  const localStorage = { ...input.localStorage };
  const sessionStorage: Record<string, unknown> = {};
  const tabs = [...(input.tabs ?? [])];
  let nextTabId = 100;

  const actionOnClicked = makeEvent<(tab: ChromeTab) => void>();
  const runtimeOnMessage =
    makeEvent<
      (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean
    >();
  const runtimeOnStartup = makeEvent<() => void>();
  const runtimeOnInstalled = makeEvent<() => void>();
  const tabsOnCreated = makeEvent<(tab: ChromeTab) => void>();
  const tabsOnUpdated =
    makeEvent<(tabId: number, changeInfo: Record<string, unknown>, tab: ChromeTab) => void>();
  const tabsOnRemoved = makeEvent<(tabId: number, removeInfo: { windowId?: number }) => void>();
  const tabsOnActivated = makeEvent<(activeInfo: { tabId: number }) => void>();

  const chrome = {
    action: {
      onClicked: actionOnClicked,
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setBadgeText: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    alarms: {
      create: vi.fn(async () => undefined),
      onAlarm: makeEvent<(alarm: { name: string }) => void>(),
    },
    runtime: {
      getManifest: vi.fn(() => ({ version: "0.0.4" })),
      getURL: vi.fn((path: string) => `chrome-extension://t3-code/${path}`),
      id: "extension-id",
      onInstalled: runtimeOnInstalled,
      onMessage: runtimeOnMessage,
      onStartup: runtimeOnStartup,
      reload: vi.fn(),
      sendMessage: vi.fn(),
    },
    sidePanel: {
      close: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
      setOptions: vi.fn(async () => undefined),
      setPanelBehavior: vi.fn(async () => undefined),
    },
    storage: {
      local: makeStorageArea(localStorage, storageOnChanged, "local"),
      onChanged: storageOnChanged,
      session: makeStorageArea(sessionStorage, storageOnChanged, "session"),
    },
    tabGroups: {
      get: vi.fn(async (id: number) => ({ id, title: "group" })),
      update: vi.fn(async () => undefined),
    },
    tabs: {
      create: vi.fn(async (properties: { active?: boolean; url: string; windowId?: number }) => {
        const tab = {
          active: properties.active,
          id: nextTabId++,
          title: "",
          url: properties.url,
          windowId: properties.windowId ?? 1,
        };
        tabs.push(tab);
        return tab;
      }),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.find((entry) => entry.id === tabId);
        if (!tab) {
          throw new Error(`No tab with id ${tabId}`);
        }
        return tab;
      }),
      group: vi.fn(async () => 1),
      onActivated: tabsOnActivated,
      onCreated: tabsOnCreated,
      onRemoved: tabsOnRemoved,
      onUpdated: tabsOnUpdated,
      query: vi.fn(async (query: { active?: boolean; currentWindow?: boolean } = {}) => {
        if (query.active === true) {
          return tabs.filter((tab) => tab.active === true).slice(0, 1);
        }
        return [...tabs];
      }),
      remove: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => ({ ok: true })),
      update: vi.fn(async (tabId: number, properties: Partial<ChromeTab>) => {
        const tab = tabs.find((entry) => entry.id === tabId);
        if (!tab) {
          throw new Error(`No tab with id ${tabId}`);
        }
        Object.assign(tab, properties);
        return tab;
      }),
    },
    windows: {
      getAll: vi.fn(async () =>
        Array.from(new Set(tabs.map((tab) => tab.windowId))).map((id) => ({ id })),
      ),
      onFocusChanged: makeEvent<() => void>(),
      update: vi.fn(async () => undefined),
    },
  };

  return { chrome, localStorage, sessionStorage, tabs };
}

function makeFetch() {
  return vi.fn(async () => ({
    json: async () => ({}),
    ok: false,
    status: 404,
    text: async () => "",
  }));
}

function loadServiceWorker(input: {
  chrome: unknown;
  fetch?: ReturnType<typeof vi.fn>;
  openLocalControl?: boolean;
}) {
  const source = readFileSync(serviceWorkerPath, "utf8");
  const { MockWebSocket, sentMessages } = makeWebSocketClass({
    openLocalControl: input.openLocalControl,
  });
  const context = {
    AbortController,
    URL,
    URLSearchParams,
    chrome: input.chrome,
    clearInterval: vi.fn(),
    clearTimeout: vi.fn(),
    console: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    fetch: input.fetch ?? makeFetch(),
    globalThis: {} as Record<string, unknown>,
    navigator: {
      platform: "macOS",
      userAgent: "Chrome",
    },
    queueMicrotask,
    setInterval: vi.fn(() => 1),
    setTimeout: vi.fn(() => 1),
    WebSocket: MockWebSocket,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return { context, sentMessages };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

it("opens the linked workspace side panel from the toolbar icon", async () => {
  const tab: ChromeTab = {
    active: true,
    id: 7,
    title: "Preview",
    url: "http://localhost:5173/dashboard",
    windowId: 2,
  };
  const link = {
    createdAt: "2026-06-07T10:00:00.000Z",
    devServerUrl: "http://localhost:5173/",
    environmentId: "env-local",
    id: "workspace-link-1",
    repoName: "t3code",
    threadId: "thread-1",
    updatedAt: "2026-06-07T10:00:00.000Z",
    workspaceId: "workspace-1",
  };
  const { chrome, localStorage } = makeChromeMock({
    localStorage: {
      [BACKEND_KEY]: {
        baseUrl: "http://127.0.0.1:3773",
        pairedAt: "2026-06-07T10:00:00.000Z",
        sessionToken: "browser-token",
      },
      [LINKS_KEY]: [link],
    },
    tabs: [tab],
  });
  loadServiceWorker({ chrome });
  await flushMicrotasks();

  await vi.waitFor(() => {
    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: false,
    });
  });
  chrome.action.onClicked.listeners[0]?.(tab);

  await vi.waitFor(() => {
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });
  });
  expect(chrome.sidePanel.setOptions).toHaveBeenCalledWith({
    enabled: true,
    path: SIDE_PANEL_PATH,
    tabId: 7,
  });
  expect(chrome.tabs.create).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(localStorage[ACTIVE_LINK_KEY]).toMatchObject({
      linkId: "workspace-link-1",
      tabId: 7,
      windowId: 2,
    });
  });
  expect(localStorage[LINKS_KEY]).toEqual([
    expect.objectContaining({
      id: "workspace-link-1",
      t3Url:
        "http://127.0.0.1:3773/env-local/thread-1?browserAgentSidebar=1&browserWorkspaceLinkId=workspace-link-1",
      url: "http://localhost:5173/dashboard",
    }),
  ]);
});

it("preserves default side-panel links when provider contexts claim the same tab", async () => {
  const primaryLink = {
    agentId: "browser-agent:session-host",
    browserContextId: "default",
    createdAt: "2026-06-07T10:00:00.000Z",
    devServerUrl: "http://localhost:5173/",
    environmentId: "env-local",
    id: "workspace-link-1",
    lifecycle: "persistent",
    owner: { kind: "user" },
    repoName: "t3code",
    role: "primary",
    tabId: 7,
    threadId: "thread-1",
    updatedAt: "2026-06-07T10:00:00.000Z",
    url: "http://localhost:5173/dashboard",
    windowId: 2,
    workspaceId: "workspace-1",
  };
  const providerLink = {
    ...primaryLink,
    browserContextId: "codex:provider-thread-1",
    id: "workspace-link-agent",
    lifecycle: "ephemeral",
    owner: { kind: "agent", label: "Agent" },
    role: "agent",
    updatedAt: "2026-06-07T10:01:00.000Z",
  };
  const { chrome, localStorage } = makeChromeMock({
    localStorage: {
      [LINKS_KEY]: [primaryLink],
    },
    tabs: [
      {
        active: true,
        id: 7,
        title: "Preview",
        url: "http://localhost:5173/dashboard",
        windowId: 2,
      },
    ],
  });
  const { context } = loadServiceWorker({ chrome });
  await flushMicrotasks();

  await (context as { upsertLink: (link: unknown) => Promise<void> }).upsertLink(providerLink);

  expect(localStorage[LINKS_KEY]).toEqual([
    expect.objectContaining({
      browserContextId: "default",
      id: "workspace-link-1",
      role: "primary",
      tabId: 7,
      windowId: 2,
    }),
    expect.objectContaining({
      browserContextId: "codex:provider-thread-1",
      id: "workspace-link-agent",
      role: "agent",
      tabId: 7,
      windowId: 2,
    }),
  ]);
});

it("opens the normal T3 app tab from the toolbar icon when the current page is unlinked", async () => {
  const tab: ChromeTab = {
    active: true,
    id: 8,
    title: "Docs",
    url: "https://example.com/",
    windowId: 3,
  };
  const { chrome } = makeChromeMock({
    localStorage: {
      [BACKEND_KEY]: {
        baseUrl: "http://127.0.0.1:3773",
        pairedAt: "2026-06-07T10:00:00.000Z",
        sessionToken: "browser-token",
      },
      [LINKS_KEY]: [],
    },
    tabs: [tab],
  });
  loadServiceWorker({ chrome });
  await flushMicrotasks();

  chrome.action.onClicked.listeners[0]?.(tab);

  await vi.waitFor(() => {
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      active: true,
      url: "http://127.0.0.1:3773/",
      windowId: 3,
    });
  });
  expect(chrome.sidePanel.open).not.toHaveBeenCalled();
});

it("opens the app tab from a local-control connection without a saved backend", async () => {
  const tab: ChromeTab = {
    active: true,
    id: 9,
    title: "Unlinked",
    url: "https://example.com/",
    windowId: 4,
  };
  const { chrome } = makeChromeMock({
    localStorage: {
      [LINKS_KEY]: [],
    },
    tabs: [tab],
  });
  loadServiceWorker({ chrome, openLocalControl: true });
  await flushMicrotasks();

  chrome.action.onClicked.listeners[0]?.(tab);

  await vi.waitFor(() => {
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      active: true,
      url: "http://127.0.0.1:3773/",
      windowId: 4,
    });
  });
  expect(chrome.sidePanel.open).not.toHaveBeenCalled();
});
