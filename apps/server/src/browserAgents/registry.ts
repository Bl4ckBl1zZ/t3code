import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";

import {
  type BrowserAgentAttachActiveTabInput,
  BrowserAgentCommandError,
  BrowserAgentCommandId,
  type BrowserAgent,
  BrowserAgentConnectionId,
  BrowserAgentId,
  type BrowserAgentInboundMessage,
  type BrowserAgentOpenOrFocusPreviewInput,
  type BrowserAgentOpenOrFocusThreadTabInput,
  type BrowserAgentOutboundMessage,
  type BrowserAgentRuntimePrimitive,
  type BrowserAgentSnapshot,
  type BrowserAgentStreamEvent,
  type BrowserAgentStartThreadTabCaptureInput,
  type BrowserTabSnapshot,
  BrowserWorkspaceLinkId,
  type BrowserWorkspaceLink,
  type AuthSessionId,
  type BrowserAgentActivateAnnotationInput,
  type BrowserAgentCommandResult,
  type BrowserAgentIncomingCommandResultMessage,
  type BrowserAgentSetThreadTabControlInput,
  type BrowserAgentThreadLinkInput,
  type BrowserAgentThreadTabInputCommandInput,
  type BrowserAgentThreadTabNavigateInput,
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
  readonly deferred?: Deferred.Deferred<BrowserAgentIncomingCommandResultMessage>;
}

const DEFAULT_SIDEBAR_WIDTH_PX = 420;
const DEFAULT_BROWSER_CAPTURE_QUALITY = {
  maxWidth: 1920,
  maxHeight: 1080,
  fps: 2,
} as const;
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

function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

function linksPointToSameTab(left: BrowserWorkspaceLink, right: BrowserWorkspaceLink): boolean {
  return (
    left.tabId !== undefined &&
    left.windowId !== undefined &&
    right.tabId !== undefined &&
    right.windowId !== undefined &&
    String(left.tabId) === String(right.tabId) &&
    String(left.windowId) === String(right.windowId)
  );
}

function expectedOrigin(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

function browserLabel(agent: BrowserAgent): string {
  const browser = agent.device.browser?.trim();
  const label = agent.device.label?.trim();
  if (browser && label) {
    return `${browser} on ${label}`;
  }
  return label || browser || "Browser";
}

function commandResultErrorMessage(error: BrowserAgentIncomingCommandResultMessage["error"]) {
  if (!error) {
    return "Browser command failed.";
  }
  return typeof error === "string" ? error : error.message;
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
        this.reconcileWorkspaceLinksForTabs(connection.agentId, tabs);
        return connection.agentId;
      }
      case "browserAgent.command.result": {
        const pending = this.pendingCommands.get(message.commandId);
        this.pendingCommands.delete(message.commandId);
        if (pending?.deferred) {
          Effect.runFork(Deferred.succeed(pending.deferred, message));
        }
        if (!pending?.workspaceLinkId || message.ok === false) {
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
          ...(typeof (message.payload as { url?: unknown } | undefined)?.url === "string"
            ? { url: (message.payload as { url: string }).url }
            : {}),
          ...(typeof (message.payload as { title?: unknown } | undefined)?.title === "string"
            ? { title: (message.payload as { title: string }).title }
            : {}),
          tabStatus: "complete",
          lastSeenAt: nowIso(),
          updatedAt: nowIso(),
        };
        this.setWorkspaceLink(updated);
        return connection.agentId;
      }
      case "browserAgent.threadTab.updated": {
        const link = this.workspaceLinksById.get(message.workspaceLinkId);
        if (!link) {
          return connection.agentId;
        }
        const updated: BrowserWorkspaceLink = {
          ...link,
          ...(message.tabId === null ? {} : { tabId: message.tabId }),
          ...(message.windowId === null ? {} : { windowId: message.windowId }),
          url: message.url,
          title: message.title,
          tabStatus: message.status,
          captureState:
            message.status === "closed" && link.captureState !== "off"
              ? "error"
              : link.captureState,
          lastSeenAt: message.status === "closed" ? link.lastSeenAt : nowIso(),
          updatedAt: nowIso(),
        };
        this.setWorkspaceLink(updated);
        return connection.agentId;
      }
      case "browserAgent.capture.started": {
        const link = this.workspaceLinksById.get(message.workspaceLinkId);
        if (!link) {
          return connection.agentId;
        }
        this.setWorkspaceLink({
          ...link,
          captureState:
            message.transport === "screenshot-fallback" ? "screenshot-fallback" : "live",
          liveViewSessionId: message.liveViewSessionId,
          updatedAt: nowIso(),
        });
        return connection.agentId;
      }
      case "browserAgent.capture.stopped": {
        const link = this.workspaceLinksById.get(message.workspaceLinkId);
        if (!link) {
          return connection.agentId;
        }
        this.setWorkspaceLink({
          ...link,
          captureState: message.reason === "tab-closed" ? "error" : "off",
          liveViewSessionId: null,
          updatedAt: nowIso(),
        });
        return connection.agentId;
      }
      case "browserAgent.annotation.submitted":
        return connection.agentId;
    }
  }

  snapshot(input?: { readonly currentSessionId?: AuthSessionId }): BrowserAgentSnapshot {
    return {
      agents: Array.from(this.agents.values()),
      currentSessionId: input?.currentSessionId ?? null,
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

  resolveThreadWorkspaceLink(input: {
    readonly environmentId: string;
    readonly threadId: string;
  }): BrowserWorkspaceLink | null {
    return this.workspaceLinks.get(workspaceLinkKey(input)) ?? null;
  }

  openOrFocusThreadTab(
    input: BrowserAgentOpenOrFocusThreadTabInput,
    options?: {
      readonly preferredSessionId?: AuthSessionId;
    },
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    const registry = this;
    return Effect.gen(function* () {
      const agent = yield* registry.selectAgent({
        environmentId: input.environmentId,
        threadId: input.threadId,
        ...(input.preferredAgentId ? { preferredAgentId: input.preferredAgentId } : {}),
        ...(options?.preferredSessionId ? { preferredSessionId: options.preferredSessionId } : {}),
      });
      yield* registry.requireAgentPrimitive(agent, "threadTab.openOrFocus");
      const link = registry.upsertThreadWorkspaceLink({
        agent,
        environmentId: input.environmentId,
        threadId: input.threadId,
        url: input.url,
        repoName: input.repoName ?? TrimmedNonEmptyString.make("Browser"),
        tabStatus: "loading",
      });
      const commandId = makeCommandId("open-thread-tab");
      registry.pendingCommands.set(commandId, {
        commandId,
        agentId: agent.id,
        workspaceLinkId: link.id,
      });
      yield* registry.sendToAgent(agent.id, {
        type: "browserAgent.command.openOrFocusThreadTab",
        commandId,
        workspaceLink: link,
        url: input.url,
        focus: input.focus,
      });
      return { commandId, agentId: agent.id, workspaceLink: link };
    });
  }

  attachActiveTab(
    input: BrowserAgentAttachActiveTabInput,
    options?: {
      readonly preferredSessionId?: AuthSessionId;
    },
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    const registry = this;
    return Effect.gen(function* () {
      const agent = yield* registry.selectAgent({
        environmentId: input.environmentId,
        threadId: input.threadId,
        ...(input.preferredAgentId ? { preferredAgentId: input.preferredAgentId } : {}),
        ...(options?.preferredSessionId ? { preferredSessionId: options.preferredSessionId } : {}),
      });
      yield* registry.requireAgentPrimitive(agent, "threadTab.attachActive");
      const link = registry.upsertThreadWorkspaceLink({
        agent,
        environmentId: input.environmentId,
        threadId: input.threadId,
        url: "about:blank",
        repoName: input.repoName ?? TrimmedNonEmptyString.make("Browser"),
        tabStatus: "loading",
      });
      const commandId = makeCommandId("attach-active-tab");
      registry.pendingCommands.set(commandId, {
        commandId,
        agentId: agent.id,
        workspaceLinkId: link.id,
      });
      yield* registry.sendToAgent(agent.id, {
        type: "browserAgent.command.attachActiveTab",
        commandId,
        workspaceLink: link,
      });
      return { commandId, agentId: agent.id, workspaceLink: link };
    });
  }

  detachThreadTab(
    input: BrowserAgentThreadLinkInput,
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    const registry = this;
    return Effect.gen(function* () {
      const link = registry.workspaceLinks.get(workspaceLinkKey(input));
      if (!link) {
        return yield* toCommandError({
          code: "workspace-link-not-found",
          message: "This thread does not have a linked browser tab.",
        });
      }
      const commandId = makeCommandId("detach-thread-tab");
      const agentId = link.agentId;
      registry.workspaceLinks.delete(workspaceLinkKey(link));
      registry.workspaceLinksById.delete(link.id);
      registry.emit({ type: "workspace-link-removed", linkId: link.id });
      const agent = registry.agents.get(agentId);
      if (agent?.connected) {
        yield* registry.requireAgentPrimitive(agent, "threadTab.detach");
        registry.pendingCommands.set(commandId, { commandId, agentId, workspaceLinkId: link.id });
        yield* registry.sendToAgent(agentId, {
          type: "browserAgent.command.detachThreadTab",
          commandId,
          workspaceLinkId: link.id,
        });
      }
      return { commandId, agentId, workspaceLink: link };
    });
  }

  setThreadTabControl(
    input: BrowserAgentSetThreadTabControlInput,
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    const link = this.workspaceLinks.get(workspaceLinkKey(input));
    if (!link) {
      return Effect.fail(
        toCommandError({
          code: "workspace-link-not-found",
          message: "This thread does not have a linked browser tab.",
        }),
      );
    }
    const updated: BrowserWorkspaceLink = {
      ...link,
      controlState: input.controlState,
      updatedAt: nowIso(),
    };
    this.setWorkspaceLink(updated);
    return Effect.succeed({
      commandId: makeCommandId("set-control"),
      agentId: updated.agentId,
      workspaceLink: updated,
    });
  }

  startThreadTabCapture(
    input: BrowserAgentStartThreadTabCaptureInput,
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    const registry = this;
    return Effect.gen(function* () {
      const link = yield* registry.requireThreadLink(input);
      const agent = yield* registry.requireLinkedAgent(link);
      yield* registry.requireAgentPrimitive(agent, "threadTab.capture.start");
      const updated: BrowserWorkspaceLink = {
        ...link,
        captureState: "requesting-permission",
        updatedAt: nowIso(),
      };
      registry.setWorkspaceLink(updated);
      const commandId = makeCommandId("start-capture");
      const deferred = yield* Deferred.make<BrowserAgentIncomingCommandResultMessage>();
      registry.pendingCommands.set(commandId, {
        commandId,
        agentId: agent.id,
        workspaceLinkId: link.id,
        deferred,
      });
      yield* registry.sendToAgent(agent.id, {
        type: "browserAgent.command.startTabCapture",
        commandId,
        workspaceLinkId: link.id,
        quality: input.quality ?? DEFAULT_BROWSER_CAPTURE_QUALITY,
      });
      const message = yield* registry.awaitCommandResult(commandId, deferred).pipe(
        Effect.catch((error) => {
          const current = registry.workspaceLinksById.get(link.id) ?? updated;
          registry.setWorkspaceLink({
            ...current,
            captureState: "off",
            liveViewSessionId: null,
            updatedAt: nowIso(),
          });
          return Effect.fail(error);
        }),
      );
      return {
        commandId,
        agentId: agent.id,
        workspaceLink: registry.workspaceLinksById.get(link.id) ?? updated,
        ...(message.payload !== undefined ? { payload: message.payload } : {}),
      };
    });
  }

  stopThreadTabCapture(
    input: BrowserAgentThreadLinkInput,
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    const registry = this;
    return Effect.gen(function* () {
      const link = yield* registry.requireThreadLink(input);
      const agent = yield* registry.requireLinkedAgent(link);
      yield* registry.requireAgentPrimitive(agent, "threadTab.capture.stop");
      const updated: BrowserWorkspaceLink = {
        ...link,
        captureState: "off",
        liveViewSessionId: null,
        updatedAt: nowIso(),
      };
      registry.setWorkspaceLink(updated);
      const commandId = makeCommandId("stop-capture");
      const deferred = yield* Deferred.make<BrowserAgentIncomingCommandResultMessage>();
      registry.pendingCommands.set(commandId, {
        commandId,
        agentId: agent.id,
        workspaceLinkId: link.id,
        deferred,
      });
      yield* registry.sendToAgent(agent.id, {
        type: "browserAgent.command.stopTabCapture",
        commandId,
        workspaceLinkId: link.id,
      });
      const message = yield* registry.awaitCommandResult(commandId, deferred);
      return {
        commandId,
        agentId: agent.id,
        workspaceLink: registry.workspaceLinksById.get(link.id) ?? updated,
        ...(message.payload !== undefined ? { payload: message.payload } : {}),
      };
    });
  }

  backThreadTab(
    input: BrowserAgentThreadLinkInput,
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    return this.sendThreadTabCommandAndAwait(input, "threadTab.history", (commandId, link) => ({
      type: "browserAgent.command.history" as const,
      commandId,
      workspaceLinkId: link.id,
      action: "back" as const,
    }));
  }

  forwardThreadTab(
    input: BrowserAgentThreadLinkInput,
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    return this.sendThreadTabCommandAndAwait(input, "threadTab.history", (commandId, link) => ({
      type: "browserAgent.command.history" as const,
      commandId,
      workspaceLinkId: link.id,
      action: "forward" as const,
    }));
  }

  reloadThreadTab(
    input: BrowserAgentThreadLinkInput,
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    return this.sendThreadTabCommandAndAwait(input, "threadTab.history", (commandId, link) => ({
      type: "browserAgent.command.history" as const,
      commandId,
      workspaceLinkId: link.id,
      action: "reload" as const,
    }));
  }

  navigateThreadTab(
    input: BrowserAgentThreadTabNavigateInput,
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    return this.sendThreadTabCommandAndAwait(input, "threadTab.navigate", (commandId, link) => ({
      type: "browserAgent.command.navigate" as const,
      commandId,
      workspaceLinkId: link.id,
      url: input.url,
    }));
  }

  inputThreadTab(
    input: BrowserAgentThreadTabInputCommandInput,
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    return this.sendThreadTabCommandAndAwait(input, "threadTab.input", (commandId, link) => ({
      type: "browserAgent.command.input" as const,
      commandId,
      workspaceLinkId: link.id,
      input: input.input,
    }));
  }

  snapshotThreadTab(
    input: BrowserAgentThreadLinkInput,
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    return this.sendThreadTabCommandAndAwait(input, "threadTab.snapshot", (commandId, link) => ({
      type: "browserAgent.command.snapshot" as const,
      commandId,
      workspaceLinkId: link.id,
    }));
  }

  screenshotThreadTab(
    input: BrowserAgentThreadLinkInput,
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    return this.sendThreadTabCommandAndAwait(input, "threadTab.screenshot", (commandId, link) => ({
      type: "browserAgent.command.screenshot" as const,
      commandId,
      workspaceLinkId: link.id,
    }));
  }

  validateAgentBrowserAccess(
    input: BrowserAgentThreadLinkInput,
  ): Effect.Effect<BrowserWorkspaceLink, BrowserAgentCommandError, never> {
    const registry = this;
    return Effect.gen(function* () {
      const link = yield* registry.requireThreadLink(input);
      if (link.controlState !== "enabled") {
        return yield* toCommandError({
          code: "agent-access-paused",
          message: "Browser access is paused for this thread.",
        });
      }
      if (link.tabStatus === "closed") {
        return yield* toCommandError({
          code: "tab-closed",
          message: "The linked browser tab is closed.",
        });
      }
      yield* registry.requireLinkedAgent(link);
      if (link.tabId === undefined || link.windowId === undefined) {
        return yield* toCommandError({
          code: "tab-not-linked",
          message: "This thread does not have an active browser tab yet.",
        });
      }
      return link;
    });
  }

  openOrFocusPreview(
    input: BrowserAgentOpenOrFocusPreviewInput,
    options?: {
      readonly sidebarSessionToken?: string;
      readonly preferredSessionId?: AuthSessionId;
    },
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    const registry = this;
    return Effect.gen(function* () {
      const agent = yield* registry.selectAgent({
        environmentId: input.environmentId,
        threadId: input.threadId,
        ...(input.preferredAgentId ? { preferredAgentId: input.preferredAgentId } : {}),
        ...(options?.preferredSessionId ? { preferredSessionId: options.preferredSessionId } : {}),
      });
      yield* registry.requireAgentPrimitive(agent, "preview.openOrFocus");
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
        url: existing?.url ?? input.devServerUrl,
        expectedOrigin: expectedOrigin(input.devServerUrl),
        title: existing?.title ?? null,
        browserLabel: browserLabel(agent),
        tabStatus: existing?.tabStatus ?? "loading",
        captureState: existing?.captureState ?? "off",
        controlState: existing?.controlState ?? "enabled",
        liveViewSessionId: existing?.liveViewSessionId ?? null,
        lastSeenAt: existing?.lastSeenAt ?? null,
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
    options?: {
      readonly preferredSessionId?: AuthSessionId;
    },
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
        ...(input.preferredAgentId ? { preferredAgentId: input.preferredAgentId } : {}),
        ...(options?.preferredSessionId
          ? { preferredSessionId: options.preferredSessionId }
          : input.preferredAgentId
            ? {}
            : { preferredAgentId: link.agentId }),
      });
      yield* registry.requireAgentPrimitive(agent, "annotation.activate");
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

  private upsertThreadWorkspaceLink(input: {
    readonly agent: BrowserAgent;
    readonly environmentId: BrowserWorkspaceLink["environmentId"];
    readonly threadId: BrowserWorkspaceLink["threadId"];
    readonly url: string;
    readonly repoName: BrowserWorkspaceLink["repoName"];
    readonly tabStatus: BrowserWorkspaceLink["tabStatus"];
  }): BrowserWorkspaceLink {
    const timestamp = nowIso();
    const key = workspaceLinkKey(input);
    const existing = this.workspaceLinks.get(key);
    const link: BrowserWorkspaceLink = {
      id: existing?.id ?? makeWorkspaceLinkId(input),
      agentId: input.agent.id,
      environmentId: input.environmentId,
      threadId: input.threadId,
      devServerUrl: TrimmedNonEmptyString.make(input.url),
      repoName: input.repoName,
      ...(existing?.tabId !== undefined ? { tabId: existing.tabId } : {}),
      ...(existing?.windowId !== undefined ? { windowId: existing.windowId } : {}),
      url: input.url,
      expectedOrigin: expectedOrigin(input.url),
      title: existing?.title ?? null,
      browserLabel: browserLabel(input.agent),
      tabStatus: input.tabStatus,
      captureState: existing?.captureState ?? "off",
      controlState: existing?.controlState ?? "enabled",
      liveViewSessionId: existing?.liveViewSessionId ?? null,
      lastSeenAt: existing?.lastSeenAt ?? null,
      sidebarWidthPx: existing?.sidebarWidthPx ?? DEFAULT_SIDEBAR_WIDTH_PX,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.setWorkspaceLink(link);
    return link;
  }

  private requireThreadLink(input: {
    readonly environmentId: string;
    readonly threadId: string;
  }): Effect.Effect<BrowserWorkspaceLink, BrowserAgentCommandError, never> {
    const link = this.workspaceLinks.get(workspaceLinkKey(input));
    if (!link) {
      return Effect.fail(
        toCommandError({
          code: "workspace-link-not-found",
          message: "This thread does not have a linked browser tab.",
        }),
      );
    }
    if (link.tabStatus === "closed") {
      return Effect.fail(
        toCommandError({
          code: "tab-closed",
          message: "The linked browser tab is closed.",
        }),
      );
    }
    return Effect.succeed(link);
  }

  private requireLinkedAgent(
    link: BrowserWorkspaceLink,
  ): Effect.Effect<BrowserAgent, BrowserAgentCommandError, never> {
    const agent = this.agents.get(link.agentId);
    if (!agent?.connected) {
      return Effect.fail(
        toCommandError({
          code: "agent-disconnected",
          message: "The browser extension is disconnected.",
        }),
      );
    }
    return Effect.succeed(agent);
  }

  private requireAgentPrimitive(
    agent: BrowserAgent,
    primitive: BrowserAgentRuntimePrimitive,
  ): Effect.Effect<void, BrowserAgentCommandError, never> {
    if (agent.capabilities.runtime.primitives.includes(primitive)) {
      return Effect.void;
    }
    return Effect.fail(
      toCommandError({
        code: "command-failed",
        message: `The paired browser extension does not support '${primitive}'. Reload or update the T3 Code Browser Agent extension.`,
      }),
    );
  }

  private awaitCommandResult(
    commandId: BrowserAgentCommandId,
    deferred: Deferred.Deferred<BrowserAgentIncomingCommandResultMessage>,
  ): Effect.Effect<BrowserAgentIncomingCommandResultMessage, BrowserAgentCommandError, never> {
    const registry = this;
    return Effect.gen(function* () {
      const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption("10 seconds"));
      registry.pendingCommands.delete(commandId);
      if (Option.isNone(result)) {
        return yield* toCommandError({
          code: "command-timeout",
          message: "Timed out waiting for the browser extension.",
        });
      }

      const message = result.value;
      if (!message.ok) {
        return yield* toCommandError({
          code: "command-failed",
          message: commandResultErrorMessage(message.error),
        });
      }
      return message;
    });
  }

  private sendThreadTabCommandAndAwait(
    input: BrowserAgentThreadLinkInput,
    primitive: BrowserAgentRuntimePrimitive,
    buildMessage: (
      commandId: BrowserAgentCommandId,
      link: BrowserWorkspaceLink,
    ) => BrowserAgentOutboundMessage,
  ): Effect.Effect<BrowserAgentCommandResult, BrowserAgentCommandError, never> {
    const registry = this;
    return Effect.gen(function* () {
      const link = yield* registry.requireThreadLink(input);
      const agent = yield* registry.requireLinkedAgent(link);
      yield* registry.requireAgentPrimitive(agent, primitive);
      if (link.tabId === undefined || link.windowId === undefined) {
        return yield* toCommandError({
          code: "tab-not-linked",
          message: "This thread does not have an active browser tab yet.",
        });
      }
      const commandId = makeCommandId("thread-tab-command");
      const deferred = yield* Deferred.make<BrowserAgentIncomingCommandResultMessage>();
      registry.pendingCommands.set(commandId, {
        commandId,
        agentId: agent.id,
        workspaceLinkId: link.id,
        deferred,
      });
      yield* registry.sendToAgent(agent.id, buildMessage(commandId, link));
      const message = yield* registry.awaitCommandResult(commandId, deferred);
      return {
        commandId,
        agentId: agent.id,
        workspaceLink: registry.workspaceLinksById.get(link.id) ?? link,
        ...(message.payload !== undefined ? { payload: message.payload } : {}),
      };
    });
  }

  private reconcileWorkspaceLinksForTabs(
    agentId: BrowserAgentId,
    tabs: ReadonlyArray<BrowserTabSnapshot>,
  ): void {
    const tabByIdentity = new Map<string, BrowserTabSnapshot>();
    for (const tab of tabs) {
      tabByIdentity.set(`${tab.windowId}:${tab.tabId}`, tab);
    }

    for (const link of Array.from(this.workspaceLinksById.values())) {
      if (link.agentId !== agentId || link.tabId === undefined || link.windowId === undefined) {
        continue;
      }
      const tab = tabByIdentity.get(`${link.windowId}:${link.tabId}`);
      if (!tab) {
        this.setWorkspaceLink({
          ...link,
          tabStatus: "closed",
          captureState: link.captureState === "off" ? "off" : "error",
          liveViewSessionId: null,
          updatedAt: nowIso(),
        });
        continue;
      }
      if (
        tab.url === link.url &&
        tab.title === nullable(link.title) &&
        link.tabStatus !== "closed"
      ) {
        continue;
      }
      this.setWorkspaceLink({
        ...link,
        url: tab.url ?? null,
        title: tab.title ?? null,
        tabStatus: "complete",
        lastSeenAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
  }

  private selectAgent(input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly preferredAgentId?: BrowserAgentId;
    readonly preferredSessionId?: AuthSessionId;
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
    if (input.preferredSessionId) {
      if (existing) {
        const linkedAgent = this.agents.get(existing.agentId);
        if (linkedAgent?.connected && linkedAgent.sessionId === input.preferredSessionId) {
          return Effect.succeed(linkedAgent);
        }
      }

      const sameSessionMostRecent = connectedAgents
        .filter((agent) => agent.sessionId === input.preferredSessionId)
        .toSorted((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
      if (sameSessionMostRecent) {
        return Effect.succeed(sameSessionMostRecent);
      }
    }

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
    this.closeConflictingWorkspaceLinks(link);
  }

  private closeConflictingWorkspaceLinks(activeLink: BrowserWorkspaceLink): void {
    if (activeLink.tabStatus === "closed") {
      return;
    }
    if (activeLink.tabId === undefined || activeLink.windowId === undefined) {
      return;
    }

    for (const link of Array.from(this.workspaceLinksById.values())) {
      if (
        link.id === activeLink.id ||
        link.agentId !== activeLink.agentId ||
        link.tabStatus === "closed" ||
        !linksPointToSameTab(link, activeLink)
      ) {
        continue;
      }

      this.setWorkspaceLink({
        ...link,
        tabStatus: "closed",
        captureState: link.captureState === "off" ? "off" : "error",
        liveViewSessionId: null,
        updatedAt: nowIso(),
      });
    }
  }

  private emit(event: BrowserAgentStreamEvent): void {
    for (const listener of this.subscribers) {
      listener(event);
    }
  }
}

export const browserAgentRegistry = new BrowserAgentRegistry();
