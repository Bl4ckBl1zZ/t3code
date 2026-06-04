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
  let connectionId: ReturnType<BrowserAgentRegistry["connect"]>;
  connectionId = registry.connect({
    sessionId: AuthSessionId.make("session-host"),
    send: (message) =>
      Effect.sync(() => {
        sentMessages.push(message);
        if (message.type === "browserAgent.command.input") {
          queueMicrotask(() => {
            registry.handleMessage(connectionId, {
              type: "browserAgent.command.result",
              commandId: message.commandId,
              ok: true,
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
});
