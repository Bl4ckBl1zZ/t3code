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

export const BrowserAgentCapabilities = Schema.Struct({
  version: Schema.Literal(1),
  canCaptureVisibleTab: Schema.Boolean,
  canInjectScripts: Schema.Boolean,
  canFocusTabs: Schema.Boolean,
  canGroupTabs: Schema.Boolean,
  canAnnotate: Schema.Boolean,
  canRenderInlineSidebar: Schema.Boolean,
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
  sidebarWidthPx: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BrowserWorkspaceLink = typeof BrowserWorkspaceLink.Type;

export const BrowserAgentSnapshot = Schema.Struct({
  agents: Schema.Array(BrowserAgent),
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
  error: Schema.optional(Schema.String),
  tabId: Schema.optional(BrowserTabId),
  windowId: Schema.optional(BrowserWindowId),
});
export type BrowserAgentIncomingCommandResultMessage =
  typeof BrowserAgentIncomingCommandResultMessage.Type;

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
    type: Schema.Literal("browserAgent.command.requestTabsSnapshot"),
    commandId: BrowserAgentCommandId,
  }),
]);
export type BrowserAgentOutboundMessage = typeof BrowserAgentOutboundMessage.Type;
