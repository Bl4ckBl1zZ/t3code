import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ThreadId,
  TrimmedNonEmptyString,
  type BrowserAgentOutboundMessage,
  type BrowserWorkspaceLinkId,
} from "@t3tools/contracts";

import { BrowserAgentRegistry } from "../browserAgents/registry.ts";
import { handleCodexBrowserDynamicToolCall } from "./browserDynamicTools.ts";

const environmentId = EnvironmentId.make("environment-flow");
const threadId = ThreadId.make("thread-flow");
const otherThreadId = ThreadId.make("thread-other");
const fixtureUrl = TrimmedNonEmptyString.make("http://localhost:4173/browser-agent-fixture");

const capabilities = {
  version: 1 as const,
  canCaptureVisibleTab: true,
  canInjectScripts: true,
  canFocusTabs: true,
  canGroupTabs: true,
  canAnnotate: true,
  canRenderInlineSidebar: true,
  canAttachActiveTab: true,
  canThreadTabCommands: true,
  canCaptureThreadTab: true,
};

const device = {
  extensionVersion: "0.0.1",
  userAgent: "fake-browser-agent-flow",
  browser: TrimmedNonEmptyString.make("Brave"),
  label: TrimmedNonEmptyString.make("Flow Test"),
};

type ToolResponse = Awaited<ReturnType<typeof callBrowserTool>>;

function firstJsonPayload(response: ToolResponse): Record<string, unknown> {
  const textItem = response.contentItems.find((item) => item.type === "inputText");
  if (!textItem || typeof textItem.text !== "string") {
    throw new Error("Expected a text content item with JSON payload.");
  }
  return JSON.parse(textItem.text) as Record<string, unknown>;
}

function expectSuccessful(response: ToolResponse): Record<string, unknown> {
  expect(response.success).toBe(true);
  return firstJsonPayload(response);
}

function callBrowserTool(input: {
  readonly registry: BrowserAgentRegistry;
  readonly tool: string;
  readonly arguments?: unknown;
  readonly targetThreadId?: ThreadId;
}) {
  return Effect.runPromise(
    handleCodexBrowserDynamicToolCall({
      environmentId,
      threadId: input.targetThreadId ?? threadId,
      registry: input.registry,
      payload: {
        tool: input.tool,
        arguments: input.arguments ?? {},
        callId: `call-${input.tool}`,
        threadId: "provider-thread-flow",
        turnId: "turn-flow",
      },
    }),
  );
}

async function flushBrowserMessages() {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeThreadBrowserAgent {
  readonly messages: BrowserAgentOutboundMessage[] = [];
  readonly failures: unknown[] = [];

  private readonly registry: BrowserAgentRegistry;
  private readonly sessionId = AuthSessionId.make("session-flow");
  private connectionId: ReturnType<BrowserAgentRegistry["connect"]> | null = null;
  private workspaceLinkId: BrowserWorkspaceLinkId | null = null;
  private readonly tabId = 101;
  private readonly windowId = 5;
  private readonly history: string[] = [];
  private historyIndex = -1;
  private url = "about:blank";
  private title = "Blank";
  private counter = 0;
  private note = "";
  private focusedRef: string | null = null;
  private scrollY = 0;

  constructor(registry: BrowserAgentRegistry) {
    this.registry = registry;
  }

  connect() {
    const connectionId = this.registry.connect({
      sessionId: this.sessionId,
      send: (message) =>
        Effect.sync(() => {
          this.messages.push(message);
          queueMicrotask(() => {
            try {
              this.handleCommand(message);
            } catch (error) {
              this.failures.push(error);
            }
          });
        }),
    });
    this.connectionId = connectionId;
    this.registry.handleMessage(connectionId, {
      type: "browserAgent.hello",
      device,
      capabilities,
    });
  }

  closeLinkedTab() {
    if (!this.workspaceLinkId || !this.connectionId) {
      throw new Error("Expected a linked tab before closing it.");
    }
    this.registry.handleMessage(this.connectionId, {
      type: "browserAgent.threadTab.updated",
      workspaceLinkId: this.workspaceLinkId,
      tabId: null,
      windowId: null,
      url: this.url,
      title: this.title,
      status: "closed",
    });
  }

  private handleCommand(message: BrowserAgentOutboundMessage) {
    switch (message.type) {
      case "browserAgent.command.openOrFocusThreadTab":
        this.workspaceLinkId = message.workspaceLink.id;
        this.visit(message.url);
        this.sendResult(message, {
          tabId: this.tabId,
          windowId: this.windowId,
          payload: this.pagePayload(),
        });
        this.emitTabSnapshot();
        break;

      case "browserAgent.command.attachActiveTab":
        this.workspaceLinkId = message.workspaceLink.id;
        this.sendResult(message, {
          tabId: this.tabId,
          windowId: this.windowId,
          payload: this.pagePayload(),
        });
        this.emitTabSnapshot();
        break;

      case "browserAgent.command.startTabCapture":
        this.requireLinkedWorkspace(message.workspaceLinkId);
        this.registry.handleMessage(this.requireConnection(), {
          type: "browserAgent.capture.started",
          workspaceLinkId: message.workspaceLinkId,
          liveViewSessionId: "screenshot-fallback:flow",
          transport: "screenshot-fallback",
        });
        this.sendResult(message, {
          payload: {
            dataUrl: this.screenshotDataUrl(),
            liveViewSessionId: "screenshot-fallback:flow",
            transport: "screenshot-fallback",
          },
        });
        break;

      case "browserAgent.command.stopTabCapture":
        this.requireLinkedWorkspace(message.workspaceLinkId);
        this.registry.handleMessage(this.requireConnection(), {
          type: "browserAgent.capture.stopped",
          workspaceLinkId: message.workspaceLinkId,
          reason: "user",
        });
        this.sendResult(message, { payload: { ok: true } });
        break;

      case "browserAgent.command.navigate":
        this.requireLinkedWorkspace(message.workspaceLinkId);
        this.visit(message.url);
        this.sendResult(message, { payload: this.pagePayload() });
        this.emitTabSnapshot();
        break;

      case "browserAgent.command.history":
        this.requireLinkedWorkspace(message.workspaceLinkId);
        this.applyHistoryAction(message.action);
        this.sendResult(message, { payload: this.pagePayload() });
        this.emitTabSnapshot();
        break;

      case "browserAgent.command.snapshot":
        this.requireLinkedWorkspace(message.workspaceLinkId);
        this.sendResult(message, { payload: this.snapshotPayload() });
        break;

      case "browserAgent.command.screenshot":
        this.requireLinkedWorkspace(message.workspaceLinkId);
        this.sendResult(message, {
          payload: {
            ok: true,
            dataUrl: this.screenshotDataUrl(),
            url: this.url,
            title: this.title,
          },
        });
        break;

      case "browserAgent.command.input":
        this.requireLinkedWorkspace(message.workspaceLinkId);
        this.applyInput(message.input);
        this.sendResult(message, { payload: { ok: true } });
        break;

      case "browserAgent.command.detachThreadTab":
        this.workspaceLinkId = null;
        this.sendResult(message, { payload: { ok: true } });
        break;

      case "browserAgent.command.openOrFocusPreview":
      case "browserAgent.command.activateAnnotation":
      case "browserAgent.command.requestTabsSnapshot":
        this.sendResult(message, { payload: { ok: true } });
        break;
    }
  }

  private applyInput(
    input: Extract<BrowserAgentOutboundMessage, { type: "browserAgent.command.input" }>["input"],
  ) {
    switch (input.type) {
      case "click":
      case "double-click":
        if (input.ref === "increment") {
          this.counter += input.type === "double-click" ? 2 : 1;
          this.title = `Fixture counter ${this.counter}`;
        } else if (input.ref === "note") {
          this.focusedRef = "note";
        }
        break;
      case "type":
        if (this.focusedRef === "note") {
          this.note += input.text;
        }
        break;
      case "key":
        if (this.focusedRef === "note" && input.key === "Enter") {
          this.note += "\n";
        }
        break;
      case "scroll":
        this.scrollY += input.deltaY;
        break;
    }
    this.emitThreadTabUpdated();
  }

  private applyHistoryAction(action: "back" | "forward" | "reload") {
    if (action === "back" && this.historyIndex > 0) {
      this.historyIndex -= 1;
      this.loadFromHistory();
      return;
    }
    if (action === "forward" && this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.loadFromHistory();
      return;
    }
    this.emitThreadTabUpdated();
  }

  private visit(url: string) {
    this.history.splice(this.historyIndex + 1);
    this.history.push(url);
    this.historyIndex = this.history.length - 1;
    this.url = url;
    this.title = url.includes("second") ? "Second Fixture Page" : "Browser Agent Fixture";
    this.emitThreadTabUpdated();
  }

  private loadFromHistory() {
    this.url = this.history[this.historyIndex] ?? "about:blank";
    this.title = this.url.includes("second") ? "Second Fixture Page" : "Browser Agent Fixture";
    this.emitThreadTabUpdated();
  }

  private pagePayload() {
    return {
      ok: true,
      url: this.url,
      title: this.title,
    };
  }

  private snapshotPayload() {
    return {
      ok: true,
      url: this.url,
      title: this.title,
      snapshot: [
        '- button "Increment" [ref=increment]',
        '- textbox "Note" [ref=note]',
        '- button "Submit" [ref=submit]',
      ].join("\n"),
      state: {
        counter: this.counter,
        note: this.note,
        scrollY: this.scrollY,
      },
    };
  }

  private screenshotDataUrl() {
    return `data:image/png;base64,${Buffer.from(
      JSON.stringify({
        url: this.url,
        counter: this.counter,
        note: this.note,
      }),
    ).toString("base64")}`;
  }

  private emitTabSnapshot() {
    this.registry.handleMessage(this.requireConnection(), {
      type: "browserAgent.tabs.snapshot",
      tabs: [
        {
          tabId: this.tabId,
          windowId: this.windowId,
          url: this.url,
          title: this.title,
          active: true,
        },
      ],
    });
  }

  private emitThreadTabUpdated() {
    if (!this.workspaceLinkId) {
      return;
    }
    this.registry.handleMessage(this.requireConnection(), {
      type: "browserAgent.threadTab.updated",
      workspaceLinkId: this.workspaceLinkId,
      tabId: this.tabId,
      windowId: this.windowId,
      url: this.url,
      title: this.title,
      status: "complete",
    });
  }

  private requireLinkedWorkspace(workspaceLinkId: BrowserWorkspaceLinkId) {
    if (workspaceLinkId !== this.workspaceLinkId) {
      throw new Error(`Unexpected workspace link ${workspaceLinkId}.`);
    }
  }

  private requireConnection() {
    if (!this.connectionId) {
      throw new Error("Expected connected fake browser agent.");
    }
    return this.connectionId;
  }

  private sendResult(
    message: Extract<BrowserAgentOutboundMessage, { commandId: unknown }>,
    result: {
      readonly tabId?: number;
      readonly windowId?: number;
      readonly payload?: unknown;
    },
  ) {
    this.registry.handleMessage(this.requireConnection(), {
      type: "browserAgent.command.result",
      commandId: message.commandId,
      ok: true,
      ...(result.tabId !== undefined ? { tabId: result.tabId } : {}),
      ...(result.windowId !== undefined ? { windowId: result.windowId } : {}),
      ...(result.payload !== undefined ? { payload: result.payload } : {}),
    });
  }
}

describe("Codex browser dynamic tools full thread flow", () => {
  it("drives a linked tab through an agent-like browser workflow", async () => {
    const registry = new BrowserAgentRegistry();
    const fakeBrowser = new FakeThreadBrowserAgent(registry);
    fakeBrowser.connect();

    const opened = await Effect.runPromise(
      registry.openOrFocusThreadTab({
        environmentId,
        threadId,
        url: fixtureUrl,
        repoName: TrimmedNonEmptyString.make("repo"),
        focus: true,
      }),
    );
    await flushBrowserMessages();

    expect(fakeBrowser.failures).toEqual([]);
    expect(opened.workspaceLink?.threadId).toBe(threadId);
    expect(registry.resolveThreadWorkspaceLink({ environmentId, threadId })).toMatchObject({
      tabId: 101,
      windowId: 5,
      tabStatus: "complete",
      url: fixtureUrl,
      title: "Browser Agent Fixture",
      browserLabel: "Brave on Flow Test",
    });

    const capture = await Effect.runPromise(
      registry.startThreadTabCapture({
        environmentId,
        threadId,
        quality: {
          maxWidth: 1280,
          maxHeight: 720,
          fps: 2,
        },
      }),
    );
    expect(capture.payload).toMatchObject({
      liveViewSessionId: "screenshot-fallback:flow",
      transport: "screenshot-fallback",
    });
    expect(registry.resolveThreadWorkspaceLink({ environmentId, threadId })?.captureState).toBe(
      "screenshot-fallback",
    );

    expectSuccessful(
      await callBrowserTool({
        registry,
        tool: "browser_current_page",
      }),
    );

    const initialSnapshot = expectSuccessful(
      await callBrowserTool({
        registry,
        tool: "browser_snapshot",
      }),
    );
    expect(initialSnapshot.snapshot).toContain("[ref=increment]");

    await callBrowserTool({
      registry,
      tool: "browser_click",
      arguments: { ref: "increment" },
    });
    await callBrowserTool({
      registry,
      tool: "browser_click",
      arguments: { ref: "increment" },
    });
    await callBrowserTool({
      registry,
      tool: "browser_click",
      arguments: { ref: "note" },
    });
    await callBrowserTool({
      registry,
      tool: "browser_type",
      arguments: { text: "thread scoped browser works" },
    });
    await callBrowserTool({
      registry,
      tool: "browser_press_key",
      arguments: { key: "Enter" },
    });
    await callBrowserTool({
      registry,
      tool: "browser_type",
      arguments: { text: "done" },
    });
    await callBrowserTool({
      registry,
      tool: "browser_scroll",
      arguments: { deltaY: 640 },
    });

    const screenshot = await callBrowserTool({
      registry,
      tool: "browser_screenshot",
    });
    expect(screenshot.success).toBe(true);
    expect(screenshot.contentItems.some((item) => item.type === "inputImage")).toBe(true);

    const completedSnapshot = expectSuccessful(
      await callBrowserTool({
        registry,
        tool: "browser_snapshot",
      }),
    );
    expect(completedSnapshot.state).toMatchObject({
      counter: 2,
      note: "thread scoped browser works\ndone",
      scrollY: 640,
    });

    const navigated = expectSuccessful(
      await callBrowserTool({
        registry,
        tool: "browser_navigate",
        arguments: { url: "http://localhost:4173/browser-agent-fixture/second" },
      }),
    );
    expect(navigated).toMatchObject({
      ok: true,
      url: "http://localhost:4173/browser-agent-fixture/second",
      title: "Second Fixture Page",
    });

    await Effect.runPromise(registry.backThreadTab({ environmentId, threadId }));
    expect(registry.resolveThreadWorkspaceLink({ environmentId, threadId })?.url).toBe(fixtureUrl);
    await Effect.runPromise(registry.forwardThreadTab({ environmentId, threadId }));
    expect(registry.resolveThreadWorkspaceLink({ environmentId, threadId })?.url).toBe(
      "http://localhost:4173/browser-agent-fixture/second",
    );
    await Effect.runPromise(registry.reloadThreadTab({ environmentId, threadId }));
    expect(registry.resolveThreadWorkspaceLink({ environmentId, threadId })?.tabStatus).toBe(
      "complete",
    );

    await Effect.runPromise(
      registry.setThreadTabControl({
        environmentId,
        threadId,
        controlState: "paused-by-user",
      }),
    );
    const pausedResult = await callBrowserTool({
      registry,
      tool: "browser_click",
      arguments: { ref: "increment" },
    });
    expect(pausedResult.success).toBe(false);
    expect(firstJsonPayload(pausedResult)).toMatchObject({
      ok: false,
      error: "Browser access is paused for this thread.",
    });

    await Effect.runPromise(
      registry.setThreadTabControl({
        environmentId,
        threadId,
        controlState: "enabled",
      }),
    );
    const crossThreadResult = await callBrowserTool({
      registry,
      tool: "browser_current_page",
      targetThreadId: otherThreadId,
    });
    expect(crossThreadResult.success).toBe(false);
    expect(firstJsonPayload(crossThreadResult)).toMatchObject({
      ok: false,
      error: "This thread does not have a linked browser tab.",
    });

    fakeBrowser.closeLinkedTab();
    const closedTabResult = await callBrowserTool({
      registry,
      tool: "browser_current_page",
    });
    expect(closedTabResult.success).toBe(false);
    expect(firstJsonPayload(closedTabResult)).toMatchObject({
      ok: false,
      error: "The linked browser tab is closed.",
    });

    expect(fakeBrowser.failures).toEqual([]);
    expect(fakeBrowser.messages.map((message) => message.type)).toEqual(
      expect.arrayContaining([
        "browserAgent.command.openOrFocusThreadTab",
        "browserAgent.command.startTabCapture",
        "browserAgent.command.snapshot",
        "browserAgent.command.input",
        "browserAgent.command.screenshot",
        "browserAgent.command.navigate",
        "browserAgent.command.history",
      ]),
    );
  });
});
