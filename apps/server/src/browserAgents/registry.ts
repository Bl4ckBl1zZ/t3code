import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";

import {
  BrowserAgentCommandError,
  BrowserAgentCommandId,
  type BrowserAgent,
  BrowserAgentConnectionId,
  BrowserAgentId,
  type BrowserAgentInboundMessage,
  type BrowserAgentOpenOrFocusPreviewInput,
  type BrowserAgentOutboundMessage,
  type BrowserAgentSnapshot,
  type BrowserAgentStreamEvent,
  type BrowserTabSnapshot,
  BrowserWorkspaceLinkId,
  type BrowserWorkspaceLink,
  type AuthSessionId,
  type BrowserAgentActivateAnnotationInput,
  type BrowserAgentCommandResult,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

type BrowserAgentSender = (
  message: BrowserAgentOutboundMessage,
) => Effect.Effect<void, BrowserAgentCommandError, never>;

interface BrowserAgentConnection {
  readonly connectionId: BrowserAgentConnectionId;
  readonly sessionId: AuthSessionId;
  readonly send: BrowserAgentSender;
  agentId: BrowserAgentId | null;
}

interface PendingCommand {
  readonly commandId: BrowserAgentCommandId;
  readonly agentId: BrowserAgentId;
  readonly workspaceLinkId?: BrowserWorkspaceLinkId;
}

const DEFAULT_SIDEBAR_WIDTH_PX = 420;
let nextEphemeralId = 0;

function nowIso(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}

function randomSuffix(): string {
  nextEphemeralId += 1;
  return `${nextEphemeralId}`;
}

function workspaceLinkKey(input: {
  readonly environmentId: string;
  readonly threadId: string;
}): string {
  return `${input.environmentId}::${input.threadId}`;
}

function makeCommandId(kind: string): BrowserAgentCommandId {
  return BrowserAgentCommandId.make(`browser-agent:${kind}:${randomSuffix()}`);
}

function makeConnectionId(sessionId: AuthSessionId): BrowserAgentConnectionId {
  return BrowserAgentConnectionId.make(`browser-agent:${sessionId}:${randomSuffix()}`);
}

function makeAgentId(sessionId: AuthSessionId): BrowserAgentId {
  return BrowserAgentId.make(`browser-agent:${sessionId}`);
}

function makeWorkspaceLinkId(input: {
  readonly environmentId: string;
  readonly threadId: string;
}): BrowserWorkspaceLinkId {
  return BrowserWorkspaceLinkId.make(`browser-workspace:${input.environmentId}:${input.threadId}`);
}

function toCommandError(input: {
  readonly message: string;
  readonly code: ConstructorParameters<typeof BrowserAgentCommandError>[0]["code"];
  readonly cause?: unknown;
}) {
  return new BrowserAgentCommandError(input);
}

export class BrowserAgentRegistry {
  private readonly connections = new Map<BrowserAgentConnectionId, BrowserAgentConnection>();
  private readonly agents = new Map<BrowserAgentId, BrowserAgent>();
  private readonly tabs = new Map<BrowserAgentId, ReadonlyArray<BrowserTabSnapshot>>();
  private readonly workspaceLinks = new Map<string, BrowserWorkspaceLink>();
  private readonly workspaceLinksById = new Map<BrowserWorkspaceLinkId, BrowserWorkspaceLink>();
  private readonly pendingCommands = new Map<BrowserAgentCommandId, PendingCommand>();
  private readonly subscribers = new Set<(event: BrowserAgentStreamEvent) => void>();

  connect(input: {
    readonly sessionId: AuthSessionId;
    readonly send: BrowserAgentSender;
  }): BrowserAgentConnectionId {
    const connectionId = makeConnectionId(input.sessionId);
    this.connections.set(connectionId, {
      connectionId,
      sessionId: input.sessionId,
      send: input.send,
      agentId: null,
    });
    return connectionId;
  }

  disconnect(connectionId: BrowserAgentConnectionId): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }
    this.connections.delete(connectionId);

    if (!connection.agentId) {
      return;
    }

    const current = this.agents.get(connection.agentId);
    if (current?.connectionId !== connectionId) {
      return;
    }

    this.agents.set(connection.agentId, {
      ...current,
      connected: false,
      lastSeenAt: nowIso(),
    });
    this.emit({
      type: "agent-removed",
      agentId: connection.agentId,
      connectionId,
    });
  }

  handleMessage(
    connectionId: BrowserAgentConnectionId,
    message: BrowserAgentInboundMessage,
  ): BrowserAgentId | null {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return null;
    }

    switch (message.type) {
      case "browserAgent.hello": {
        const timestamp = nowIso();
        const agentId = message.agentId ?? makeAgentId(connection.sessionId);
        connection.agentId = agentId;
        const agent: BrowserAgent = {
          id: agentId,
          connectionId,
          sessionId: connection.sessionId,
          connected: true,
          device: message.device,
          capabilities: message.capabilities,
          connectedAt: this.agents.get(agentId)?.connectedAt ?? timestamp,
          lastSeenAt: timestamp,
        };
        this.agents.set(agentId, agent);
        this.emit({ type: "agent-upserted", agent });
        return agentId;
      }
      case "browserAgent.tabs.snapshot": {
        if (!connection.agentId) {
          return null;
        }
        const timestamp = nowIso();
        const agent = this.agents.get(connection.agentId);
        if (agent) {
          const updatedAgent = { ...agent, lastSeenAt: timestamp };
          this.agents.set(connection.agentId, updatedAgent);
          this.emit({ type: "agent-upserted", agent: updatedAgent });
        }
        const tabs = message.tabs.map(
          (tab): BrowserTabSnapshot => ({
            ...tab,
            agentId: connection.agentId as BrowserAgentId,
            updatedAt: timestamp,
          }),
        );
        this.tabs.set(connection.agentId, tabs);
        this.emit({ type: "tabs-updated", agentId: connection.agentId, tabs });
        return connection.agentId;
      }
      case "browserAgent.command.result": {
        const pending = this.pendingCommands.get(message.commandId);
        this.pendingCommands.delete(message.commandId);
        if (!pending?.workspaceLinkId) {
          return connection.agentId;
        }
        const link = this.workspaceLinksById.get(pending.workspaceLinkId);
        if (!link) {
          return connection.agentId;
        }
        const updated: BrowserWorkspaceLink = {
          ...link,
          ...(message.tabId !== undefined ? { tabId: message.tabId } : {}),
          ...(message.windowId !== undefined ? { windowId: message.windowId } : {}),
          updatedAt: nowIso(),
        };
        this.setWorkspaceLink(updated);
        return connection.agentId;
      }
      case "browserAgent.annotation.submitted":
        return connection.agentId;
    }
  }

  snapshot(): BrowserAgentSnapshot {
    return {
      agents: Array.from(this.agents.values()),
      tabs: Array.from(this.tabs.values()).flat(),
      workspaceLinks: Array.from(this.workspaceLinks.values()),
    };
  }

  subscribe(listener: (event: BrowserAgentStreamEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  resolveWorkspaceLink(id: BrowserWorkspaceLinkId): BrowserWorkspaceLink | null {
    return this.workspaceLinksById.get(id) ?? null;
  }

  openOrFocusPreview(
    input: BrowserAgentOpenOrFocusPreviewInput,
    options?: {
      readonly sidebarSessionToken?: string;
    },
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    const registry = this;
    return Effect.gen(function* () {
      const agent = yield* registry.selectAgent({
        environmentId: input.environmentId,
        threadId: input.threadId,
        ...(input.preferredAgentId ? { preferredAgentId: input.preferredAgentId } : {}),
      });
      const timestamp = nowIso();
      const key = workspaceLinkKey(input);
      const existing = registry.workspaceLinks.get(key);
      const link: BrowserWorkspaceLink = {
        id: existing?.id ?? makeWorkspaceLinkId(input),
        agentId: agent.id,
        environmentId: input.environmentId,
        threadId: input.threadId,
        devServerUrl: input.devServerUrl,
        repoName: input.repoName,
        ...(existing?.tabId !== undefined ? { tabId: existing.tabId } : {}),
        ...(existing?.windowId !== undefined ? { windowId: existing.windowId } : {}),
        sidebarWidthPx: existing?.sidebarWidthPx ?? DEFAULT_SIDEBAR_WIDTH_PX,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      registry.setWorkspaceLink(link);

      const commandId = makeCommandId("open-preview");
      registry.pendingCommands.set(commandId, {
        commandId,
        agentId: agent.id,
        workspaceLinkId: link.id,
      });
      yield* registry.sendToAgent(agent.id, {
        type: "browserAgent.command.openOrFocusPreview",
        commandId,
        workspaceLink: link,
        ...(options?.sidebarSessionToken
          ? { sidebarSessionToken: TrimmedNonEmptyString.make(options.sidebarSessionToken) }
          : {}),
      });
      return { commandId, agentId: agent.id, workspaceLink: link };
    });
  }

  activateAnnotation(
    input: BrowserAgentActivateAnnotationInput,
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    const registry = this;
    return Effect.gen(function* () {
      const link = registry.workspaceLinks.get(workspaceLinkKey(input));
      if (!link) {
        return yield* toCommandError({
          code: "workspace-link-not-found",
          message: "Open the preview in a browser agent before annotating.",
        });
      }
      const agent = yield* registry.selectAgent({
        environmentId: input.environmentId,
        threadId: input.threadId,
        preferredAgentId: input.preferredAgentId ?? link.agentId,
      });
      const commandId = makeCommandId("annotate");
      registry.pendingCommands.set(commandId, {
        commandId,
        agentId: agent.id,
        workspaceLinkId: link.id,
      });
      yield* registry.sendToAgent(agent.id, {
        type: "browserAgent.command.activateAnnotation",
        commandId,
        workspaceLink: { ...link, agentId: agent.id, updatedAt: nowIso() },
      });
      return { commandId, agentId: agent.id, workspaceLink: link };
    });
  }

  private selectAgent(input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly preferredAgentId?: BrowserAgentId;
  }): Effect.Effect<BrowserAgent, BrowserAgentCommandError, never> {
    const connectedAgents = Array.from(this.agents.values()).filter((agent) => agent.connected);
    if (connectedAgents.length === 0) {
      return Effect.fail(
        toCommandError({
          code: "no-agent-connected",
          message: "No paired browser extension is connected.",
        }),
      );
    }

    if (input.preferredAgentId) {
      const preferred = this.agents.get(input.preferredAgentId);
      if (preferred?.connected) {
        return Effect.succeed(preferred);
      }
      return Effect.fail(
        toCommandError({
          code: "agent-disconnected",
          message: "The selected browser extension is disconnected.",
        }),
      );
    }

    const existing = this.workspaceLinks.get(workspaceLinkKey(input));
    if (existing) {
      const linkedAgent = this.agents.get(existing.agentId);
      if (linkedAgent?.connected) {
        return Effect.succeed(linkedAgent);
      }
    }

    const mostRecent = connectedAgents.toSorted((left, right) =>
      right.lastSeenAt.localeCompare(left.lastSeenAt),
    )[0];
    if (!mostRecent) {
      return Effect.fail(
        toCommandError({
          code: "no-agent-connected",
          message: "No paired browser extension is connected.",
        }),
      );
    }
    return Effect.succeed(mostRecent);
  }

  private sendToAgent(
    agentId: BrowserAgentId,
    message: BrowserAgentOutboundMessage,
  ): Effect.Effect<void, BrowserAgentCommandError, never> {
    const agent = this.agents.get(agentId);
    if (!agent?.connected) {
      return Effect.fail(
        toCommandError({
          code: "agent-disconnected",
          message: "The browser extension is disconnected.",
        }),
      );
    }

    const connection = this.connections.get(agent.connectionId);
    if (!connection) {
      return Effect.fail(
        toCommandError({
          code: "agent-disconnected",
          message: "The browser extension connection is no longer available.",
        }),
      );
    }

    return connection.send(message).pipe(
      Effect.mapError((cause) =>
        toCommandError({
          code: "command-failed",
          message: "Failed to send command to the browser extension.",
          cause,
        }),
      ),
    );
  }

  private setWorkspaceLink(link: BrowserWorkspaceLink): void {
    this.workspaceLinks.set(workspaceLinkKey(link), link);
    this.workspaceLinksById.set(link.id, link);
    this.emit({ type: "workspace-link-upserted", link });
  }

  private emit(event: BrowserAgentStreamEvent): void {
    for (const listener of this.subscribers) {
      listener(event);
    }
  }
}

export const browserAgentRegistry = new BrowserAgentRegistry();
