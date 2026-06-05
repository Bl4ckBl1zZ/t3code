import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const BrowserAgentId = TrimmedNonEmptyString.pipe(Schema.brand("BrowserAgentId"));
export type BrowserAgentId = typeof BrowserAgentId.Type;

export const BrowserAgentConnectionId = TrimmedNonEmptyString.pipe(
  Schema.brand("BrowserAgentConnectionId"),
);
export type BrowserAgentConnectionId = typeof BrowserAgentConnectionId.Type;

export const BrowserWorkspaceLinkId = TrimmedNonEmptyString.pipe(
  Schema.brand("BrowserWorkspaceLinkId"),
);
export type BrowserWorkspaceLinkId = typeof BrowserWorkspaceLinkId.Type;

export const BrowserAgentCommandId = TrimmedNonEmptyString.pipe(
  Schema.brand("BrowserAgentCommandId"),
);
export type BrowserAgentCommandId = typeof BrowserAgentCommandId.Type;

export const BrowserAgentContextId = TrimmedNonEmptyString.pipe(
  Schema.brand("BrowserAgentContextId"),
);
export type BrowserAgentContextId = typeof BrowserAgentContextId.Type;

export const BrowserWorkspaceTabId = TrimmedNonEmptyString.pipe(
  Schema.brand("BrowserWorkspaceTabId"),
);
export type BrowserWorkspaceTabId = typeof BrowserWorkspaceTabId.Type;

const BrowserTabId = Schema.Union([Schema.Number, Schema.String]);
const BrowserWindowId = Schema.Union([Schema.Number, Schema.String]);

export const ThreadBrowserLinkState = Schema.Literals([
  "unlinked",
  "opening",
  "linked",
  "needs-tab",
  "agent-disconnected",
  "capture-permission-needed",
  "capture-active",
  "capture-paused",
  "error",
]);
export type ThreadBrowserLinkState = typeof ThreadBrowserLinkState.Type;

export const BrowserCaptureState = Schema.Literals([
  "off",
  "requesting-permission",
  "live",
  "screenshot-fallback",
  "blocked",
  "error",
]);
export type BrowserCaptureState = typeof BrowserCaptureState.Type;

export const BrowserAgentControlState = Schema.Literals([
  "enabled",
  "paused-by-user",
  "paused-by-policy",
  "unavailable",
]);
export type BrowserAgentControlState = typeof BrowserAgentControlState.Type;

export const BrowserControlState = Schema.Literals(["off", "deep", "paused"]);
export type BrowserControlState = typeof BrowserControlState.Type;

export const BrowserWorkspaceTabRole = Schema.Literals(["primary", "agent", "scratch", "handoff"]);
export type BrowserWorkspaceTabRole = typeof BrowserWorkspaceTabRole.Type;

export const BrowserWorkspaceTabLifecycle = Schema.Literals(["persistent", "ephemeral", "handoff"]);
export type BrowserWorkspaceTabLifecycle = typeof BrowserWorkspaceTabLifecycle.Type;

export const BrowserWorkspaceTabOwner = Schema.Struct({
  kind: Schema.Literals(["user", "agent", "system"]),
  providerSessionId: Schema.optional(TrimmedNonEmptyString),
  runId: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
});
export type BrowserWorkspaceTabOwner = typeof BrowserWorkspaceTabOwner.Type;

export const BrowserThreadTabStatus = Schema.Literals(["loading", "complete", "closed", "unknown"]);
export type BrowserThreadTabStatus = typeof BrowserThreadTabStatus.Type;

export const BrowserWorkspaceTabStatus = Schema.Literals([
  "opening",
  "loading",
  "complete",
  "closed",
  "error",
]);
export type BrowserWorkspaceTabStatus = typeof BrowserWorkspaceTabStatus.Type;

export const BrowserTabStreamState = Schema.Literals([
  "off",
  "starting",
  "live",
  "screenshot-fallback",
  "error",
]);
export type BrowserTabStreamState = typeof BrowserTabStreamState.Type;

const NullableStringWithDefault = Schema.NullOr(Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);

export const BROWSER_AGENT_RUNTIME_PROTOCOL_VERSION = 2 as const;
export const BROWSER_AGENT_RUNTIME_PRIMITIVES = [
  "preview.openOrFocus",
  "annotation.activate",
  "annotation.cancel",
  "annotation.captureElement",
  "workspace.create",
  "workspace.restore",
  "workspace.detach",
  "workspace.pauseControl",
  "workspace.resumeControl",
  "workspace.snapshot",
  "tab.create",
  "tab.attachActive",
  "tab.openOrFocusPrimary",
  "tab.focus",
  "tab.close",
  "tab.promoteToPrimary",
  "tab.rename",
  "tab.setPurpose",
  "tab.navigate",
  "tab.back",
  "tab.forward",
  "tab.reload",
  "tab.input",
  "tab.snapshot",
  "tab.screenshot",
  "tab.stream.start",
  "tab.stream.stop",
  "tab.capture.start",
  "tab.capture.stop",
  "sidePanel.open",
  "sidePanel.setThread",
  "sidePanel.clearThread",
  "sidePanel.syncActiveTab",
  "sidePanel.showOpenPrompt",
  "sidePanel.hideOpenPrompt",
  "cdp.send",
  "cdp.runtime.evaluate",
  "cdp.input.dispatch",
  "cdp.network.enable",
  "cdp.network.disable",
  "cdp.accessibility.snapshot",
  "cdp.console.read",
  "diagnostics.snapshot",
  "diagnostics.logs",
  "diagnostics.pingBackend",
  "diagnostics.forceReconnect",
  "diagnostics.clear",
  "threadTab.openOrFocus",
  "threadTab.attachActive",
  "threadTab.detach",
  "threadTab.capture.start",
  "threadTab.capture.stop",
  "threadTab.history",
  "threadTab.navigate",
  "threadTab.input",
  "threadTab.snapshot",
  "threadTab.screenshot",
  "tabs.snapshot",
] as const;

export const BrowserAgentRuntimePrimitive = Schema.Literals(BROWSER_AGENT_RUNTIME_PRIMITIVES);
export type BrowserAgentRuntimePrimitive = typeof BrowserAgentRuntimePrimitive.Type;

export const BrowserAgentRuntimeProtocol = Schema.Struct({
  version: Schema.Literal(BROWSER_AGENT_RUNTIME_PROTOCOL_VERSION),
  primitives: Schema.Array(BrowserAgentRuntimePrimitive),
});
export type BrowserAgentRuntimeProtocol = typeof BrowserAgentRuntimeProtocol.Type;

export const BrowserAgentCapabilities = Schema.Struct({
  version: Schema.Literal(1),
  runtime: BrowserAgentRuntimeProtocol.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        version: BROWSER_AGENT_RUNTIME_PROTOCOL_VERSION,
        primitives: [...BROWSER_AGENT_RUNTIME_PRIMITIVES],
      }),
    ),
  ),
  canCaptureVisibleTab: Schema.Boolean,
  canInjectScripts: Schema.Boolean,
  canFocusTabs: Schema.Boolean,
  canGroupTabs: Schema.Boolean,
  canAnnotate: Schema.Boolean,
  canRenderInlineSidebar: Schema.Boolean,
  canAttachActiveTab: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  canThreadTabCommands: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  canCaptureThreadTab: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  workspace: Schema.optional(Schema.Array(Schema.String)),
  sidePanel: Schema.optional(Schema.Array(Schema.String)),
  annotation: Schema.optional(Schema.Array(Schema.String)),
  cdp: Schema.optional(Schema.Array(Schema.String)),
  diagnostics: Schema.optional(Schema.Array(Schema.String)),
});
export type BrowserAgentCapabilities = typeof BrowserAgentCapabilities.Type;

export const BrowserRuntimeHello = Schema.Struct({
  protocolVersion: NonNegativeInt,
  extensionVersion: TrimmedNonEmptyString,
  buildId: Schema.optional(TrimmedNonEmptyString),
  browser: Schema.Literals(["chrome", "brave", "edge", "chromium", "unknown"]),
  platform: Schema.String,
});
export type BrowserRuntimeHello = typeof BrowserRuntimeHello.Type;

export const BrowserAgentDevice = Schema.Struct({
  extensionVersion: TrimmedNonEmptyString,
  userAgent: Schema.String,
  browser: Schema.optional(TrimmedNonEmptyString),
  platform: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
});
export type BrowserAgentDevice = typeof BrowserAgentDevice.Type;

export const BrowserAgent = Schema.Struct({
  id: BrowserAgentId,
  connectionId: BrowserAgentConnectionId,
  sessionId: TrimmedNonEmptyString,
  connected: Schema.Boolean,
  runtime: Schema.optional(BrowserRuntimeHello),
  device: BrowserAgentDevice,
  capabilities: BrowserAgentCapabilities,
  connectedAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
});
export type BrowserAgent = typeof BrowserAgent.Type;

export const BrowserTabSnapshot = Schema.Struct({
  agentId: BrowserAgentId,
  tabId: BrowserTabId,
  windowId: BrowserWindowId,
  url: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  active: Schema.Boolean,
  groupId: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  groupTitle: Schema.optional(Schema.String),
  updatedAt: IsoDateTime,
});
export type BrowserTabSnapshot = typeof BrowserTabSnapshot.Type;

export const BrowserWorkspaceLink = Schema.Struct({
  id: BrowserWorkspaceLinkId,
  workspaceId: BrowserWorkspaceLinkId.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(BrowserWorkspaceLinkId.make("browser-workspace:unknown")),
    ),
  ),
  browserContextId: BrowserAgentContextId.pipe(
    Schema.withDecodingDefault(Effect.succeed(BrowserAgentContextId.make("default"))),
  ),
  agentId: BrowserAgentId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  devServerUrl: TrimmedNonEmptyString,
  repoName: TrimmedNonEmptyString,
  tabId: Schema.optional(BrowserTabId),
  windowId: Schema.optional(BrowserWindowId),
  url: NullableStringWithDefault,
  expectedOrigin: NullableStringWithDefault,
  title: NullableStringWithDefault,
  browserLabel: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(Effect.succeed("Browser"))),
  tabStatus: BrowserThreadTabStatus.pipe(
    Schema.withDecodingDefault(Effect.succeed("unknown" as const)),
  ),
  captureState: BrowserCaptureState.pipe(
    Schema.withDecodingDefault(Effect.succeed("off" as const)),
  ),
  controlState: BrowserAgentControlState.pipe(
    Schema.withDecodingDefault(Effect.succeed("enabled" as const)),
  ),
  browserControlState: BrowserControlState.pipe(
    Schema.withDecodingDefault(Effect.succeed("deep" as const)),
  ),
  deepControlEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  cdpAttached: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  role: BrowserWorkspaceTabRole.pipe(
    Schema.withDecodingDefault(Effect.succeed("primary" as const)),
  ),
  purpose: NullableStringWithDefault,
  owner: BrowserWorkspaceTabOwner.pipe(
    Schema.withDecodingDefault(Effect.succeed({ kind: "user" as const })),
  ),
  lifecycle: BrowserWorkspaceTabLifecycle.pipe(
    Schema.withDecodingDefault(Effect.succeed("persistent" as const)),
  ),
  streamState: BrowserTabStreamState.pipe(
    Schema.withDecodingDefault(Effect.succeed("off" as const)),
  ),
  liveViewSessionId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastSeenAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  sidebarWidthPx: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BrowserWorkspaceLink = typeof BrowserWorkspaceLink.Type;

export const BrowserWorkspace = Schema.Struct({
  id: BrowserWorkspaceLinkId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  agentId: BrowserAgentId,
  primaryTabId: Schema.NullOr(BrowserWorkspaceTabId),
  controlState: BrowserControlState,
  deepControlEnabled: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BrowserWorkspace = typeof BrowserWorkspace.Type;

export const BrowserWorkspaceTab = Schema.Struct({
  id: BrowserWorkspaceTabId,
  workspaceId: BrowserWorkspaceLinkId,
  browserContextId: BrowserAgentContextId,
  agentId: BrowserAgentId,
  projectedThreadTabId: Schema.NullOr(TrimmedNonEmptyString),
  browserTabId: Schema.NullOr(BrowserTabId),
  windowId: Schema.NullOr(BrowserWindowId),
  role: BrowserWorkspaceTabRole,
  title: NullableStringWithDefault,
  url: NullableStringWithDefault,
  purpose: NullableStringWithDefault,
  owner: BrowserWorkspaceTabOwner,
  lifecycle: BrowserWorkspaceTabLifecycle,
  status: BrowserWorkspaceTabStatus,
  streamState: BrowserTabStreamState,
  controlState: BrowserControlState,
  cdpAttached: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastSeenAt: Schema.NullOr(IsoDateTime),
});
export type BrowserWorkspaceTab = typeof BrowserWorkspaceTab.Type;

export const BrowserAgentSnapshot = Schema.Struct({
  agents: Schema.Array(BrowserAgent),
  currentSessionId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  tabs: Schema.Array(BrowserTabSnapshot),
  workspaceLinks: Schema.Array(BrowserWorkspaceLink),
  workspaces: Schema.Array(BrowserWorkspace).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  workspaceTabs: Schema.Array(BrowserWorkspaceTab).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type BrowserAgentSnapshot = typeof BrowserAgentSnapshot.Type;

export const BrowserAgentStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    snapshot: BrowserAgentSnapshot,
  }),
  Schema.Struct({
    type: Schema.Literal("agent-upserted"),
    agent: BrowserAgent,
  }),
  Schema.Struct({
    type: Schema.Literal("agent-removed"),
    agentId: BrowserAgentId,
    connectionId: BrowserAgentConnectionId,
  }),
  Schema.Struct({
    type: Schema.Literal("tabs-updated"),
    agentId: BrowserAgentId,
    tabs: Schema.Array(BrowserTabSnapshot),
  }),
  Schema.Struct({
    type: Schema.Literal("workspace-link-upserted"),
    link: BrowserWorkspaceLink,
  }),
  Schema.Struct({
    type: Schema.Literal("workspace-link-removed"),
    linkId: BrowserWorkspaceLinkId,
  }),
  Schema.Struct({
    type: Schema.Literal("workspace-tabs-updated"),
    workspaceId: BrowserWorkspaceLinkId,
    tabs: Schema.Array(BrowserWorkspaceTab),
  }),
  Schema.Struct({
    type: Schema.Literal("capture-frame"),
    workspaceLinkId: BrowserWorkspaceLinkId,
    liveViewSessionId: TrimmedNonEmptyString,
    dataUrl: TrimmedNonEmptyString,
    width: Schema.optional(NonNegativeInt),
    height: Schema.optional(NonNegativeInt),
    sequence: NonNegativeInt,
    timestamp: IsoDateTime,
  }),
]);
export type BrowserAgentStreamEvent = typeof BrowserAgentStreamEvent.Type;

export const BrowserAgentListResult = BrowserAgentSnapshot;
export type BrowserAgentListResult = typeof BrowserAgentListResult.Type;

export const BrowserAgentOpenOrFocusPreviewInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  devServerUrl: TrimmedNonEmptyString,
  repoName: TrimmedNonEmptyString,
  preferredAgentId: Schema.optional(BrowserAgentId),
});
export type BrowserAgentOpenOrFocusPreviewInput = typeof BrowserAgentOpenOrFocusPreviewInput.Type;

export const BrowserAgentOpenOrFocusThreadTabInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  browserContextId: Schema.optional(BrowserAgentContextId),
  url: TrimmedNonEmptyString,
  repoName: Schema.optional(TrimmedNonEmptyString),
  preferredAgentId: Schema.optional(BrowserAgentId),
  focus: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  role: Schema.optional(BrowserWorkspaceTabRole),
  purpose: Schema.optional(TrimmedNonEmptyString),
  owner: Schema.optional(BrowserWorkspaceTabOwner),
  lifecycle: Schema.optional(BrowserWorkspaceTabLifecycle),
});
export type BrowserAgentOpenOrFocusThreadTabInput =
  typeof BrowserAgentOpenOrFocusThreadTabInput.Type;

export const BrowserAgentAttachActiveTabInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  browserContextId: Schema.optional(BrowserAgentContextId),
  repoName: Schema.optional(TrimmedNonEmptyString),
  preferredAgentId: Schema.optional(BrowserAgentId),
});
export type BrowserAgentAttachActiveTabInput = typeof BrowserAgentAttachActiveTabInput.Type;

export const BrowserAgentThreadLinkInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  browserContextId: Schema.optional(BrowserAgentContextId),
});
export type BrowserAgentThreadLinkInput = typeof BrowserAgentThreadLinkInput.Type;

export const BrowserAgentSetThreadTabControlInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  browserContextId: Schema.optional(BrowserAgentContextId),
  controlState: BrowserAgentControlState,
  browserControlState: Schema.optional(BrowserControlState),
});
export type BrowserAgentSetThreadTabControlInput = typeof BrowserAgentSetThreadTabControlInput.Type;

export const BrowserAgentRuntimeCommandInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  browserContextId: Schema.optional(BrowserAgentContextId),
  type: BrowserAgentRuntimePrimitive,
  tabId: Schema.optional(BrowserWorkspaceTabId),
  params: Schema.optional(Schema.Unknown),
  timeoutMs: Schema.optional(NonNegativeInt),
});
export type BrowserAgentRuntimeCommandInput = typeof BrowserAgentRuntimeCommandInput.Type;

export const BrowserAgentThreadTabCaptureQuality = Schema.Struct({
  maxWidth: NonNegativeInt,
  maxHeight: NonNegativeInt,
  fps: NonNegativeInt,
});
export type BrowserAgentThreadTabCaptureQuality = typeof BrowserAgentThreadTabCaptureQuality.Type;

export const BrowserAgentStartThreadTabCaptureInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  browserContextId: Schema.optional(BrowserAgentContextId),
  quality: BrowserAgentThreadTabCaptureQuality.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        maxWidth: 1920,
        maxHeight: 1080,
        fps: 2,
      }),
    ),
  ),
});
export type BrowserAgentStartThreadTabCaptureInput =
  typeof BrowserAgentStartThreadTabCaptureInput.Type;

export const BrowserAgentThreadTabInputEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("click"),
    x: Schema.optional(Schema.Number),
    y: Schema.optional(Schema.Number),
    button: Schema.Literals(["left", "middle", "right"]),
    ref: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("double-click"),
    x: Schema.optional(Schema.Number),
    y: Schema.optional(Schema.Number),
    button: Schema.Literals(["left", "middle", "right"]),
    ref: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("type"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("fill"),
    text: Schema.String,
    ref: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    key: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("scroll"),
    deltaX: Schema.Number,
    deltaY: Schema.Number,
    x: Schema.optional(Schema.Number),
    y: Schema.optional(Schema.Number),
  }),
]);
export type BrowserAgentThreadTabInputEvent = typeof BrowserAgentThreadTabInputEvent.Type;

export const BrowserAgentThreadTabInputCommandInput = BrowserAgentThreadLinkInput.pipe(
  Schema.fieldsAssign({
    input: BrowserAgentThreadTabInputEvent,
  }),
);
export type BrowserAgentThreadTabInputCommandInput =
  typeof BrowserAgentThreadTabInputCommandInput.Type;

export const BrowserAgentThreadTabNavigateInput = BrowserAgentThreadLinkInput.pipe(
  Schema.fieldsAssign({
    url: TrimmedNonEmptyString,
  }),
);
export type BrowserAgentThreadTabNavigateInput = typeof BrowserAgentThreadTabNavigateInput.Type;

export const BrowserAgentActivateAnnotationInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  preferredAgentId: Schema.optional(BrowserAgentId),
});
export type BrowserAgentActivateAnnotationInput = typeof BrowserAgentActivateAnnotationInput.Type;

export const BrowserAgentCommandResult = Schema.Struct({
  commandId: BrowserAgentCommandId,
  agentId: BrowserAgentId,
  workspaceLink: Schema.optional(BrowserWorkspaceLink),
  payload: Schema.optional(Schema.Unknown),
});
export type BrowserAgentCommandResult = typeof BrowserAgentCommandResult.Type;

export class BrowserAgentCommandError extends Schema.TaggedErrorClass<BrowserAgentCommandError>()(
  "BrowserAgentCommandError",
  {
    message: TrimmedNonEmptyString,
    code: Schema.Literals([
      "no-agent-connected",
      "ambiguous-agent",
      "workspace-link-not-found",
      "agent-disconnected",
      "agent-access-paused",
      "tab-not-linked",
      "tab-not-found",
      "tab-closed",
      "unauthorized",
      "capture-unavailable",
      "command-timeout",
      "command-failed",
    ]),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const BrowserAgentHelloMessage = Schema.Struct({
  type: Schema.Literal("browserAgent.hello"),
  agentId: Schema.optional(BrowserAgentId),
  runtime: Schema.optional(BrowserRuntimeHello),
  device: BrowserAgentDevice,
  capabilities: BrowserAgentCapabilities,
});
export type BrowserAgentHelloMessage = typeof BrowserAgentHelloMessage.Type;

export const BrowserAgentTabsSnapshotMessage = Schema.Struct({
  type: Schema.Literal("browserAgent.tabs.snapshot"),
  tabs: Schema.Array(
    Schema.Struct({
      tabId: BrowserTabId,
      windowId: BrowserWindowId,
      url: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
      active: Schema.Boolean,
      groupId: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
      groupTitle: Schema.optional(Schema.String),
    }),
  ),
});
export type BrowserAgentTabsSnapshotMessage = typeof BrowserAgentTabsSnapshotMessage.Type;

export const BrowserAgentIncomingCommandResultMessage = Schema.Struct({
  type: Schema.Literal("browserAgent.command.result"),
  commandId: BrowserAgentCommandId,
  ok: Schema.Boolean,
  payload: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Struct({
        code: TrimmedNonEmptyString,
        message: TrimmedNonEmptyString,
      }),
    ]),
  ),
  tabId: Schema.optional(BrowserTabId),
  windowId: Schema.optional(BrowserWindowId),
});
export type BrowserAgentIncomingCommandResultMessage =
  typeof BrowserAgentIncomingCommandResultMessage.Type;

export const BrowserAgentThreadTabUpdatedMessage = Schema.Struct({
  type: Schema.Literal("browserAgent.threadTab.updated"),
  workspaceLinkId: BrowserWorkspaceLinkId,
  tabId: Schema.NullOr(BrowserTabId),
  windowId: Schema.NullOr(BrowserWindowId),
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  status: BrowserThreadTabStatus,
});
export type BrowserAgentThreadTabUpdatedMessage = typeof BrowserAgentThreadTabUpdatedMessage.Type;

export const BrowserAgentCaptureStartedMessage = Schema.Struct({
  type: Schema.Literal("browserAgent.capture.started"),
  workspaceLinkId: BrowserWorkspaceLinkId,
  liveViewSessionId: TrimmedNonEmptyString,
  transport: Schema.Literals(["websocket", "screenshot-fallback"]),
});
export type BrowserAgentCaptureStartedMessage = typeof BrowserAgentCaptureStartedMessage.Type;

export const BrowserAgentCaptureStoppedMessage = Schema.Struct({
  type: Schema.Literal("browserAgent.capture.stopped"),
  workspaceLinkId: BrowserWorkspaceLinkId,
  reason: Schema.Literals(["user", "tab-closed", "permission-revoked", "error"]),
  message: Schema.optional(Schema.String),
});
export type BrowserAgentCaptureStoppedMessage = typeof BrowserAgentCaptureStoppedMessage.Type;

export const BrowserAgentCaptureFrameMessage = Schema.Struct({
  type: Schema.Literal("browserAgent.capture.frame"),
  workspaceLinkId: BrowserWorkspaceLinkId,
  liveViewSessionId: TrimmedNonEmptyString,
  dataUrl: TrimmedNonEmptyString,
  width: Schema.optional(NonNegativeInt),
  height: Schema.optional(NonNegativeInt),
  sequence: NonNegativeInt,
  timestamp: IsoDateTime,
});
export type BrowserAgentCaptureFrameMessage = typeof BrowserAgentCaptureFrameMessage.Type;

export const BrowserAgentAnnotationSubmittedMessage = Schema.Struct({
  type: Schema.Literal("browserAgent.annotation.submitted"),
  workspaceLinkId: BrowserWorkspaceLinkId,
  annotation: Schema.Struct({
    text: TrimmedNonEmptyString,
    screenshotDataUrl: TrimmedNonEmptyString,
    pageUrl: Schema.String,
    pageTitle: Schema.optional(Schema.String),
    selectorLabel: Schema.optional(Schema.String),
    rect: Schema.optional(
      Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
        width: NonNegativeInt,
        height: NonNegativeInt,
      }),
    ),
  }),
});
export type BrowserAgentAnnotationSubmittedMessage =
  typeof BrowserAgentAnnotationSubmittedMessage.Type;

export const BrowserAgentInboundMessage = Schema.Union([
  BrowserAgentHelloMessage,
  BrowserAgentTabsSnapshotMessage,
  BrowserAgentIncomingCommandResultMessage,
  BrowserAgentThreadTabUpdatedMessage,
  BrowserAgentCaptureStartedMessage,
  BrowserAgentCaptureStoppedMessage,
  BrowserAgentCaptureFrameMessage,
  BrowserAgentAnnotationSubmittedMessage,
]);
export type BrowserAgentInboundMessage = typeof BrowserAgentInboundMessage.Type;

export const BrowserAgentOutboundMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.openOrFocusPreview"),
    commandId: BrowserAgentCommandId,
    workspaceLink: BrowserWorkspaceLink,
    sidebarSessionToken: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.activateAnnotation"),
    commandId: BrowserAgentCommandId,
    workspaceLink: BrowserWorkspaceLink,
  }),
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.openOrFocusThreadTab"),
    commandId: BrowserAgentCommandId,
    workspaceLink: BrowserWorkspaceLink,
    url: TrimmedNonEmptyString,
    focus: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.attachActiveTab"),
    commandId: BrowserAgentCommandId,
    workspaceLink: BrowserWorkspaceLink,
  }),
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.detachThreadTab"),
    commandId: BrowserAgentCommandId,
    workspaceLinkId: BrowserWorkspaceLinkId,
  }),
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.startTabCapture"),
    commandId: BrowserAgentCommandId,
    workspaceLinkId: BrowserWorkspaceLinkId,
    quality: BrowserAgentThreadTabCaptureQuality,
  }),
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.stopTabCapture"),
    commandId: BrowserAgentCommandId,
    workspaceLinkId: BrowserWorkspaceLinkId,
  }),
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.input"),
    commandId: BrowserAgentCommandId,
    workspaceLinkId: BrowserWorkspaceLinkId,
    input: BrowserAgentThreadTabInputEvent,
  }),
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.history"),
    commandId: BrowserAgentCommandId,
    workspaceLinkId: BrowserWorkspaceLinkId,
    action: Schema.Literals(["back", "forward", "reload"]),
  }),
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.navigate"),
    commandId: BrowserAgentCommandId,
    workspaceLinkId: BrowserWorkspaceLinkId,
    url: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.snapshot"),
    commandId: BrowserAgentCommandId,
    workspaceLinkId: BrowserWorkspaceLinkId,
  }),
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.screenshot"),
    commandId: BrowserAgentCommandId,
    workspaceLinkId: BrowserWorkspaceLinkId,
    quality: Schema.optional(BrowserAgentThreadTabCaptureQuality),
  }),
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.requestTabsSnapshot"),
    commandId: BrowserAgentCommandId,
  }),
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.runtime"),
    commandId: BrowserAgentCommandId,
    workspaceLinkId: BrowserWorkspaceLinkId,
    runtimeCommand: BrowserAgentRuntimePrimitive,
    tabId: Schema.optional(BrowserWorkspaceTabId),
    params: Schema.optional(Schema.Unknown),
    timeoutMs: Schema.optional(NonNegativeInt),
  }),
]);
export type BrowserAgentOutboundMessage = typeof BrowserAgentOutboundMessage.Type;
