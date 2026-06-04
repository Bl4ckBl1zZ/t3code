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

import { BrowserAgentRegistry } from "./registry.ts";

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

const workspaceInput = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  devServerUrl: "http://100.105.249.96:3000/",
  repoName: "repo",
};

function connectAgent(
  registry: BrowserAgentRegistry,
  sessionId: AuthSessionId,
  nextCapabilities = capabilities,
): BrowserAgentOutboundMessage[] {
  const sentMessages: BrowserAgentOutboundMessage[] = [];
  const connectionId = registry.connect({
    sessionId,
    send: (message) =>
      Effect.sync(() => {
        sentMessages.push(message);
      }),
  });
  registry.handleMessage(connectionId, {
    type: "browserAgent.hello",
    device,
    capabilities: nextCapabilities,
  });
  return sentMessages;
}

async function openLinkedThreadTab(registry: BrowserAgentRegistry, sessionId: AuthSessionId) {
  const connectionId = registry.snapshot().agents[0]?.connectionId;
  if (!connectionId) {
    throw new Error("Expected connected browser agent.");
  }

  const opened = await Effect.runPromise(
    registry.openOrFocusThreadTab(
      {
        environmentId: workspaceInput.environmentId,
        threadId: workspaceInput.threadId,
        url: "http://localhost:5173/",
        repoName: "repo",
        focus: true,
      },
      { preferredSessionId: sessionId },
    ),
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
  const workspaceLink = opened.workspaceLink;
  if (!workspaceLink) {
    throw new Error("Expected browser workspace link.");
  }

  return { connectionId, workspaceLink };
}

describe("BrowserAgentRegistry", () => {
  it("includes the requesting session id in browser agent snapshots", () => {
    const registry = new BrowserAgentRegistry();
    const sessionId = AuthSessionId.make("session-host");
    connectAgent(registry, sessionId);

    const snapshot = registry.snapshot({ currentSessionId: sessionId });

    expect(snapshot.currentSessionId).toBe(sessionId);
    expect(snapshot.agents[0]?.sessionId).toBe(sessionId);
  });

  it("rejects commands unsupported by the extension runtime primitives", async () => {
    const registry = new BrowserAgentRegistry();
    const sessionId = AuthSessionId.make("session-host");
    connectAgent(registry, sessionId, {
      ...capabilities,
      runtime: {
        ...capabilities.runtime,
        primitives: capabilities.runtime.primitives.filter(
          (primitive) => primitive !== "threadTab.openOrFocus",
        ),
      },
    });

    await expect(
      Effect.runPromise(
        registry.openOrFocusThreadTab(
          {
            environmentId: workspaceInput.environmentId,
            threadId: workspaceInput.threadId,
            url: "http://localhost:5173/",
            repoName: "repo",
            focus: true,
          },
          { preferredSessionId: sessionId },
        ),
      ),
    ).rejects.toMatchObject({
      code: "command-failed",
      message: expect.stringContaining("threadTab.openOrFocus"),
    });
  });

  it("sends preview commands to the browser agent for the requesting session", async () => {
    const registry = new BrowserAgentRegistry();
    const hostSessionId = AuthSessionId.make("session-host");
    const remoteSessionId = AuthSessionId.make("session-remote");
    const hostMessages = connectAgent(registry, hostSessionId);

    await Effect.runPromise(
      registry.openOrFocusPreview(workspaceInput, {
        preferredSessionId: hostSessionId,
      }),
    );
    expect(hostMessages).toHaveLength(1);

    const remoteMessages = connectAgent(registry, remoteSessionId);
    const result = await Effect.runPromise(
      registry.openOrFocusPreview(workspaceInput, {
        preferredSessionId: remoteSessionId,
      }),
    );

    expect(result.agentId).toBe("browser-agent:session-remote");
    expect(remoteMessages).toHaveLength(1);
    expect(remoteMessages[0]?.type).toBe("browserAgent.command.openOrFocusPreview");
    expect(hostMessages).toHaveLength(1);
  });

  it("falls back to a connected browser agent from another session", async () => {
    const registry = new BrowserAgentRegistry();
    const hostSessionId = AuthSessionId.make("session-host");
    const remoteSessionId = AuthSessionId.make("session-remote");
    const hostMessages = connectAgent(registry, hostSessionId);

    const hostResult = await Effect.runPromise(
      registry.openOrFocusPreview(workspaceInput, {
        preferredSessionId: hostSessionId,
      }),
    );

    const remoteResult = await Effect.runPromise(
      registry.openOrFocusPreview(workspaceInput, {
        preferredSessionId: remoteSessionId,
      }),
    );

    expect(hostResult.agentId).toBe("browser-agent:session-host");
    expect(remoteResult.agentId).toBe("browser-agent:session-host");
    expect(hostMessages).toHaveLength(2);
  });

  it("creates a thread-scoped browser link and sends the open command", async () => {
    const registry = new BrowserAgentRegistry();
    const sessionId = AuthSessionId.make("session-host");
    const messages = connectAgent(registry, sessionId);

    const result = await Effect.runPromise(
      registry.openOrFocusThreadTab(
        {
          environmentId: workspaceInput.environmentId,
          threadId: workspaceInput.threadId,
          url: "http://localhost:5173/",
          repoName: "repo",
          focus: true,
        },
        { preferredSessionId: sessionId },
      ),
    );

    expect(result.workspaceLink?.threadId).toBe(workspaceInput.threadId);
    expect(result.workspaceLink?.url).toBe("http://localhost:5173/");
    expect(messages.at(-1)?.type).toBe("browserAgent.command.openOrFocusThreadTab");
  });

  it("rejects agent browser access when the thread link is paused", async () => {
    const registry = new BrowserAgentRegistry();
    const sessionId = AuthSessionId.make("session-host");
    connectAgent(registry, sessionId);

    await Effect.runPromise(
      registry.openOrFocusThreadTab(
        {
          environmentId: workspaceInput.environmentId,
          threadId: workspaceInput.threadId,
          url: "http://localhost:5173/",
          repoName: "repo",
          focus: true,
        },
        { preferredSessionId: sessionId },
      ),
    );
    await Effect.runPromise(
      registry.setThreadTabControl({
        environmentId: workspaceInput.environmentId,
        threadId: workspaceInput.threadId,
        controlState: "paused-by-user",
      }),
    );

    await expect(
      Effect.runPromise(
        registry.validateAgentBrowserAccess({
          environmentId: workspaceInput.environmentId,
          threadId: workspaceInput.threadId,
        }),
      ),
    ).rejects.toMatchObject({
      code: "agent-access-paused",
    });
  });

  it("marks a linked tab closed when the extension snapshot no longer includes it", async () => {
    const registry = new BrowserAgentRegistry();
    const sessionId = AuthSessionId.make("session-host");
    connectAgent(registry, sessionId);
    const { connectionId } = await openLinkedThreadTab(registry, sessionId);

    registry.handleMessage(connectionId, {
      type: "browserAgent.tabs.snapshot",
      tabs: [],
    });

    const link = registry.resolveThreadWorkspaceLink({
      environmentId: workspaceInput.environmentId,
      threadId: workspaceInput.threadId,
    });
    expect(link?.tabStatus).toBe("closed");
  });

  it("keeps browser tab authority exclusive to the newest thread link", async () => {
    const registry = new BrowserAgentRegistry();
    const sessionId = AuthSessionId.make("session-host");
    connectAgent(registry, sessionId);
    const connectionId = registry.snapshot().agents[0]?.connectionId;
    if (!connectionId) {
      throw new Error("Expected connected browser agent.");
    }

    const first = await Effect.runPromise(
      registry.openOrFocusThreadTab(
        {
          environmentId: workspaceInput.environmentId,
          threadId: workspaceInput.threadId,
          url: "http://localhost:5173/",
          repoName: "repo",
          focus: true,
        },
        { preferredSessionId: sessionId },
      ),
    );
    registry.handleMessage(connectionId, {
      type: "browserAgent.command.result",
      commandId: first.commandId,
      ok: true,
      tabId: 42,
      windowId: 7,
      payload: {
        url: "http://localhost:5173/",
        title: "Preview",
      },
    });

    const secondThreadId = ThreadId.make("thread-2");
    const second = await Effect.runPromise(
      registry.openOrFocusThreadTab(
        {
          environmentId: workspaceInput.environmentId,
          threadId: secondThreadId,
          url: "http://localhost:5173/",
          repoName: "repo",
          focus: true,
        },
        { preferredSessionId: sessionId },
      ),
    );
    registry.handleMessage(connectionId, {
      type: "browserAgent.command.result",
      commandId: second.commandId,
      ok: true,
      tabId: 42,
      windowId: 7,
      payload: {
        url: "http://localhost:5173/",
        title: "Preview",
      },
    });

    const firstLink = registry.resolveThreadWorkspaceLink({
      environmentId: workspaceInput.environmentId,
      threadId: workspaceInput.threadId,
    });
    const secondLink = registry.resolveThreadWorkspaceLink({
      environmentId: workspaceInput.environmentId,
      threadId: secondThreadId,
    });

    expect(firstLink?.tabStatus).toBe("closed");
    expect(secondLink?.tabStatus).toBe("complete");
  });

  it("awaits capture start results and returns the first screenshot payload", async () => {
    const registry = new BrowserAgentRegistry();
    const sessionId = AuthSessionId.make("session-host");
    const messages = connectAgent(registry, sessionId);
    const { connectionId, workspaceLink } = await openLinkedThreadTab(registry, sessionId);

    const startPromise = Effect.runPromise(
      registry.startThreadTabCapture({
        environmentId: workspaceInput.environmentId,
        threadId: workspaceInput.threadId,
        quality: {
          maxWidth: 800,
          maxHeight: 600,
          fps: 1,
        },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    const command = messages.at(-1);
    if (command?.type !== "browserAgent.command.startTabCapture") {
      throw new Error("Expected start capture command.");
    }
    registry.handleMessage(connectionId, {
      type: "browserAgent.capture.started",
      workspaceLinkId: workspaceLink.id,
      liveViewSessionId: "screenshot-fallback:test",
      transport: "screenshot-fallback",
    });
    registry.handleMessage(connectionId, {
      type: "browserAgent.command.result",
      commandId: command.commandId,
      ok: true,
      payload: {
        dataUrl: "data:image/png;base64,abc",
        liveViewSessionId: "screenshot-fallback:test",
        transport: "screenshot-fallback",
      },
    });

    const result = await startPromise;
    expect(result.workspaceLink?.captureState).toBe("screenshot-fallback");
    expect(result.payload).toMatchObject({
      dataUrl: "data:image/png;base64,abc",
      transport: "screenshot-fallback",
    });
  });

  it("resets capture state when start capture fails", async () => {
    const registry = new BrowserAgentRegistry();
    const sessionId = AuthSessionId.make("session-host");
    const messages = connectAgent(registry, sessionId);
    const { connectionId } = await openLinkedThreadTab(registry, sessionId);

    const startPromise = Effect.runPromise(
      registry.startThreadTabCapture({
        environmentId: workspaceInput.environmentId,
        threadId: workspaceInput.threadId,
        quality: {
          maxWidth: 800,
          maxHeight: 600,
          fps: 1,
        },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    const command = messages.at(-1);
    if (command?.type !== "browserAgent.command.startTabCapture") {
      throw new Error("Expected start capture command.");
    }
    registry.handleMessage(connectionId, {
      type: "browserAgent.command.result",
      commandId: command.commandId,
      ok: false,
      error: "Permission denied.",
    });

    await expect(startPromise).rejects.toMatchObject({
      code: "command-failed",
    });
    const link = registry.resolveThreadWorkspaceLink({
      environmentId: workspaceInput.environmentId,
      threadId: workspaceInput.threadId,
    });
    expect(link?.captureState).toBe("off");
    expect(link?.liveViewSessionId).toBeNull();
  });
});
