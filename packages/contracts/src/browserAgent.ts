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

export const BrowserThreadTabStatus = Schema.Literals(["loading", "complete", "closed", "unknown"]);
export type BrowserThreadTabStatus = typeof BrowserThreadTabStatus.Type;

const NullableStringWithDefault = Schema.NullOr(Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);

export const BROWSER_AGENT_RUNTIME_PROTOCOL_VERSION = 1 as const;
export const BROWSER_AGENT_RUNTIME_PRIMITIVES = [
  "preview.openOrFocus",
  "annotation.activate",
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
});
export type BrowserAgentCapabilities = typeof BrowserAgentCapabilities.Type;

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
  liveViewSessionId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastSeenAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  sidebarWidthPx: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BrowserWorkspaceLink = typeof BrowserWorkspaceLink.Type;

export const BrowserAgentSnapshot = Schema.Struct({
  agents: Schema.Array(BrowserAgent),
  currentSessionId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  tabs: Schema.Array(BrowserTabSnapshot),
  workspaceLinks: Schema.Array(BrowserWorkspaceLink),
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
  url: TrimmedNonEmptyString,
  repoName: Schema.optional(TrimmedNonEmptyString),
  preferredAgentId: Schema.optional(BrowserAgentId),
  focus: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type BrowserAgentOpenOrFocusThreadTabInput =
  typeof BrowserAgentOpenOrFocusThreadTabInput.Type;

export const BrowserAgentAttachActiveTabInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  repoName: Schema.optional(TrimmedNonEmptyString),
  preferredAgentId: Schema.optional(BrowserAgentId),
});
export type BrowserAgentAttachActiveTabInput = typeof BrowserAgentAttachActiveTabInput.Type;

export const BrowserAgentThreadLinkInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type BrowserAgentThreadLinkInput = typeof BrowserAgentThreadLinkInput.Type;

export const BrowserAgentSetThreadTabControlInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  controlState: BrowserAgentControlState,
});
export type BrowserAgentSetThreadTabControlInput = typeof BrowserAgentSetThreadTabControlInput.Type;

export const BrowserAgentThreadTabCaptureQuality = Schema.Struct({
  maxWidth: NonNegativeInt,
  maxHeight: NonNegativeInt,
  fps: NonNegativeInt,
});
export type BrowserAgentThreadTabCaptureQuality = typeof BrowserAgentThreadTabCaptureQuality.Type;

export const BrowserAgentStartThreadTabCaptureInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
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
  transport: Schema.Literals(["webrtc", "websocket", "screenshot-fallback"]),
});
export type BrowserAgentCaptureStartedMessage = typeof BrowserAgentCaptureStartedMessage.Type;

export const BrowserAgentCaptureStoppedMessage = Schema.Struct({
  type: Schema.Literal("browserAgent.capture.stopped"),
  workspaceLinkId: BrowserWorkspaceLinkId,
  reason: Schema.Literals(["user", "tab-closed", "permission-revoked", "error"]),
  message: Schema.optional(Schema.String),
});
export type BrowserAgentCaptureStoppedMessage = typeof BrowserAgentCaptureStoppedMessage.Type;

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
  }),
  Schema.Struct({
    type: Schema.Literal("browserAgent.command.requestTabsSnapshot"),
    commandId: BrowserAgentCommandId,
  }),
]);
export type BrowserAgentOutboundMessage = typeof BrowserAgentOutboundMessage.Type;
