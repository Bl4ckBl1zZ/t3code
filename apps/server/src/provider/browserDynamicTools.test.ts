import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  AuthSessionId,
  BROWSER_AGENT_RUNTIME_PRIMITIVES,
  BROWSER_AGENT_RUNTIME_PROTOCOL_VERSION,
  EnvironmentId,
  ThreadId,
  type BrowserAgentOutboundMessage,
} from "@t3tools/contracts";

import { BrowserAgentRegistry } from "../browserAgents/registry.ts";
import { handleCodexBrowserDynamicToolCall } from "./browserDynamicTools.ts";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");

const capabilities = {
  version: 1 as const,
  runtime: {
    version: BROWSER_AGENT_RUNTIME_PROTOCOL_VERSION,
    primitives: [...BROWSER_AGENT_RUNTIME_PRIMITIVES],
  },
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
  userAgent: "test-browser-agent",
};

function connectAgent(registry: BrowserAgentRegistry) {
  const sentMessages: BrowserAgentOutboundMessage[] = [];
  const tabIdByUrl = new Map<string, number>();
  let nextTabId = 42;
  let connectionId: ReturnType<BrowserAgentRegistry["connect"]>;
  connectionId = registry.connect({
    sessionId: AuthSessionId.make("session-host"),
    send: (message) =>
      Effect.sync(() => {
        sentMessages.push(message);
        if (message.type === "browserAgent.command.openOrFocusThreadTab") {
          let tabId = tabIdByUrl.get(message.url);
          if (tabId === undefined) {
            tabId = nextTabId;
            nextTabId += 1;
            tabIdByUrl.set(message.url, tabId);
          }
          queueMicrotask(() => {
            registry.handleMessage(connectionId, {
              type: "browserAgent.command.result",
              commandId: message.commandId,
              ok: true,
              tabId,
              windowId: 7,
              payload: {
                url: message.url,
                title: "Preview",
              },
            });
          });
        }
        if (message.type === "browserAgent.command.input") {
          queueMicrotask(() => {
            registry.handleMessage(connectionId, {
              type: "browserAgent.command.result",
              commandId: message.commandId,
              ok: true,
            });
          });
        }
        if (message.type === "browserAgent.command.closeThreadTab") {
          queueMicrotask(() => {
            registry.handleMessage(connectionId, {
              type: "browserAgent.command.result",
              commandId: message.commandId,
              ok: true,
              payload: {
                ok: true,
                closed: true,
              },
            });
          });
        }
        if (message.type === "browserAgent.command.runtime") {
          queueMicrotask(() => {
            registry.handleMessage(connectionId, {
              type: "browserAgent.command.result",
              commandId: message.commandId,
              ok: true,
              payload: {
                ok: true,
                runtimeCommand: message.runtimeCommand,
              },
            });
          });
        }
      }),
  });
  registry.handleMessage(connectionId, {
    type: "browserAgent.hello",
    device,
    capabilities,
  });
  return { connectionId, sentMessages };
}

async function openLinkedTab(
  registry: BrowserAgentRegistry,
  connectionId: ReturnType<BrowserAgentRegistry["connect"]>,
) {
  const opened = await Effect.runPromise(
    registry.openOrFocusThreadTab({
      environmentId,
      threadId,
      url: "http://localhost:5173/",
      repoName: "repo",
      focus: true,
    }),
  );
  registry.handleMessage(connectionId, {
    type: "browserAgent.command.result",
    commandId: opened.commandId,
    ok: true,
    tabId: 42,
    windowId: 7,
    payload: {
      url: "http://localhost:5173/",
      title: "Preview",
    },
  });
}

describe("Codex browser dynamic tools", () => {
  it("lets agents open a thread-scoped browser tab through the extension bridge", async () => {
    const registry = new BrowserAgentRegistry();
    const { sentMessages } = connectAgent(registry);

    const response = await Effect.runPromise(
      handleCodexBrowserDynamicToolCall({
        environmentId,
        threadId,
        registry,
        payload: {
          tool: "browser_open_tab",
          arguments: { url: "http://localhost:5173/", purpose: "Frontend QA" },
          callId: "call-1",
          threadId: "provider-thread-1",
          turnId: "turn-1",
        },
      }),
    );

    expect(response.success).toBe(true);
    expect(sentMessages.at(-1)).toMatchObject({
      type: "browserAgent.command.openOrFocusThreadTab",
      url: "http://localhost:5173/",
      focus: false,
      workspaceLink: {
        role: "agent",
        purpose: "Frontend QA",
        owner: {
          kind: "agent",
          label: "Agent",
        },
        lifecycle: "ephemeral",
      },
    });
  });

  it("routes sub-agent browser tools to a separate tab context", async () => {
    const registry = new BrowserAgentRegistry();
    const { sentMessages } = connectAgent(registry);

    const mainResponse = await Effect.runPromise(
      handleCodexBrowserDynamicToolCall({
        environmentId,
        threadId,
        registry,
        rootProviderThreadId: "provider-thread-main",
        payload: {
          tool: "browser_open_tab",
          arguments: { url: "http://localhost:5173/main" },
          callId: "call-main",
          threadId: "provider-thread-main",
          turnId: "turn-1",
        },
      }),
    );
    const subagentResponse = await Effect.runPromise(
      handleCodexBrowserDynamicToolCall({
        environmentId,
        threadId,
        registry,
        rootProviderThreadId: "provider-thread-main",
        payload: {
          tool: "browser_open_tab",
          arguments: { url: "http://localhost:5173/subagent" },
          callId: "call-subagent",
          threadId: "provider-thread-subagent",
          turnId: "turn-1",
        },
      }),
    );

    expect(mainResponse.success).toBe(true);
    expect(subagentResponse.success).toBe(true);
    const openMessages = sentMessages.filter(
      (message) => message.type === "browserAgent.command.openOrFocusThreadTab",
    );
    expect(openMessages).toHaveLength(2);
    expect(openMessages[0]).toMatchObject({
      workspaceLink: {
        browserContextId: "default",
        owner: { kind: "agent", label: "Agent" },
      },
    });
    expect(openMessages[1]).toMatchObject({
      workspaceLink: {
        browserContextId: "codex:provider-thread-subagent",
        owner: { kind: "agent", label: "Sub-agent", runId: "provider-thread-subagent" },
      },
    });

    const snapshot = registry.snapshot();
    expect(snapshot.workspaceLinks.map((link) => link.browserContextId).toSorted()).toEqual([
      "codex:provider-thread-subagent",
      "default",
    ]);
  });

  it("lets agents close the linked browser tab when finished", async () => {
    const registry = new BrowserAgentRegistry();
    const { connectionId, sentMessages } = connectAgent(registry);
    await openLinkedTab(registry, connectionId);

    const response = await Effect.runPromise(
      handleCodexBrowserDynamicToolCall({
        environmentId,
        threadId,
        registry,
        payload: {
          tool: "browser_close_tab",
          arguments: {},
          callId: "call-close",
          threadId: "provider-thread-1",
          turnId: "turn-1",
        },
      }),
    );

    expect(response.success).toBe(true);
    expect(sentMessages.at(-1)).toMatchObject({
      type: "browserAgent.command.closeThreadTab",
    });
    expect(registry.resolveThreadWorkspaceLink({ environmentId, threadId })).toBeNull();
  });

  it("returns a failed tool result when browser access is paused", async () => {
    const registry = new BrowserAgentRegistry();
    const { connectionId } = connectAgent(registry);
    await openLinkedTab(registry, connectionId);
    await Effect.runPromise(
      registry.setThreadTabControl({
        environmentId,
        threadId,
        controlState: "paused-by-user",
      }),
    );

    const response = await Effect.runPromise(
      handleCodexBrowserDynamicToolCall({
        environmentId,
        threadId,
        registry,
        payload: {
          tool: "browser_current_page",
          arguments: {},
          callId: "call-1",
          threadId: "provider-thread-1",
          turnId: "turn-1",
        },
      }),
    );

    expect(response.success).toBe(false);
    expect(response.contentItems[0]).toMatchObject({
      type: "inputText",
      text: expect.stringContaining("Browser access is paused for this thread."),
    });
  });

  it("routes ref-based clicks to the linked browser tab", async () => {
    const registry = new BrowserAgentRegistry();
    const { connectionId, sentMessages } = connectAgent(registry);
    await openLinkedTab(registry, connectionId);

    const response = await Effect.runPromise(
      handleCodexBrowserDynamicToolCall({
        environmentId,
        threadId,
        registry,
        payload: {
          tool: "browser_click",
          arguments: { ref: "e1" },
          callId: "call-1",
          threadId: "provider-thread-1",
          turnId: "turn-1",
        },
      }),
    );

    const inputCommand = sentMessages.find(
      (message) => message.type === "browserAgent.command.input",
    );
    expect(response.success).toBe(true);
    expect(inputCommand).toMatchObject({
      type: "browserAgent.command.input",
      input: {
        type: "click",
        ref: "e1",
        button: "left",
      },
    });
  });

  it("routes ref-based fills to the linked browser tab", async () => {
    const registry = new BrowserAgentRegistry();
    const { connectionId, sentMessages } = connectAgent(registry);
    await openLinkedTab(registry, connectionId);

    const response = await Effect.runPromise(
      handleCodexBrowserDynamicToolCall({
        environmentId,
        threadId,
        registry,
        payload: {
          tool: "browser_fill",
          arguments: { ref: "e2", text: "replacement value" },
          callId: "call-1",
          threadId: "provider-thread-1",
          turnId: "turn-1",
        },
      }),
    );

    const inputCommand = sentMessages.find(
      (message) => message.type === "browserAgent.command.input",
    );
    expect(response.success).toBe(true);
    expect(inputCommand).toMatchObject({
      type: "browserAgent.command.input",
      input: {
        type: "fill",
        ref: "e2",
        text: "replacement value",
      },
    });
  });

  it("routes CDP evaluation through the runtime command bridge", async () => {
    const registry = new BrowserAgentRegistry();
    const { connectionId, sentMessages } = connectAgent(registry);
    await openLinkedTab(registry, connectionId);

    const evaluated = await Effect.runPromise(
      handleCodexBrowserDynamicToolCall({
        environmentId,
        threadId,
        registry,
        payload: {
          tool: "browser_cdp_evaluate",
          arguments: { expression: "document.title" },
          callId: "call-1",
          threadId: "provider-thread-1",
          turnId: "turn-1",
        },
      }),
    );

    expect(evaluated.success).toBe(true);
    expect(
      sentMessages.some(
        (message) =>
          message.type === "browserAgent.command.runtime" &&
          message.runtimeCommand === "cdp.runtime.evaluate",
      ),
    ).toBe(true);
  });
});
