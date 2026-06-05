import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ChatAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  UploadChatAttachment,
} from "./orchestration.ts";

export const OrganizationId = TrimmedNonEmptyString.pipe(Schema.brand("OrganizationId"));
export type OrganizationId = typeof OrganizationId.Type;

export const OrganizationPanelSlug = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("OrganizationPanelSlug"));
export type OrganizationPanelSlug = typeof OrganizationPanelSlug.Type;

export const OrganizationPanelTurnId = TrimmedNonEmptyString.pipe(
  Schema.brand("OrganizationPanelTurnId"),
);
export type OrganizationPanelTurnId = typeof OrganizationPanelTurnId.Type;

export const OrganizationPanelVersionId = TrimmedNonEmptyString.pipe(
  Schema.brand("OrganizationPanelVersionId"),
);
export type OrganizationPanelVersionId = typeof OrganizationPanelVersionId.Type;

export const OrganizationPanelViewerRole = Schema.Literals(["owner", "admin", "member"]);
export type OrganizationPanelViewerRole = typeof OrganizationPanelViewerRole.Type;

export const OrganizationPanelRuntimeEnvironment = Schema.Literals([
  "local",
  "staging",
  "production",
]);
export type OrganizationPanelRuntimeEnvironment = typeof OrganizationPanelRuntimeEnvironment.Type;

export const OrganizationPanelOrganization = Schema.Struct({
  id: OrganizationId,
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  panelSlug: OrganizationPanelSlug,
});
export type OrganizationPanelOrganization = typeof OrganizationPanelOrganization.Type;

export const OrganizationPanelViewer = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  role: OrganizationPanelViewerRole,
});
export type OrganizationPanelViewer = typeof OrganizationPanelViewer.Type;

export const OrganizationPanelRuntime = Schema.Struct({
  now: IsoDateTime,
  environment: OrganizationPanelRuntimeEnvironment,
});
export type OrganizationPanelRuntime = typeof OrganizationPanelRuntime.Type;

export const OrganizationPanelDocument = Schema.Struct({
  title: TrimmedNonEmptyString,
  html: TrimmedNonEmptyString.check(Schema.isMaxLength(200_000)),
});
export type OrganizationPanelDocument = typeof OrganizationPanelDocument.Type;

export const OrganizationPanelDynamicRpcMethod = TrimmedNonEmptyString.check(
  Schema.isPattern(/^organizationPanel\.dynamic\.[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/),
).pipe(Schema.brand("OrganizationPanelDynamicRpcMethod"));
export type OrganizationPanelDynamicRpcMethod = typeof OrganizationPanelDynamicRpcMethod.Type;

const OrganizationPanelDynamicRpcPayload = Schema.Unknown;

export const OrganizationPanelDynamicRpcMethodSummary = Schema.Struct({
  method: OrganizationPanelDynamicRpcMethod,
  label: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  inputSchema: Schema.optional(OrganizationPanelDynamicRpcPayload),
});
export type OrganizationPanelDynamicRpcMethodSummary =
  typeof OrganizationPanelDynamicRpcMethodSummary.Type;

export const OrganizationPanelDynamicRpcListInput = Schema.Struct({
  organizationId: OrganizationId,
});
export type OrganizationPanelDynamicRpcListInput = typeof OrganizationPanelDynamicRpcListInput.Type;

export const OrganizationPanelDynamicRpcListResult = Schema.Struct({
  methods: Schema.Array(OrganizationPanelDynamicRpcMethodSummary),
});
export type OrganizationPanelDynamicRpcListResult =
  typeof OrganizationPanelDynamicRpcListResult.Type;

export const OrganizationPanelDynamicRpcInvokeInput = Schema.Struct({
  organizationId: OrganizationId,
  method: OrganizationPanelDynamicRpcMethod,
  payload: OrganizationPanelDynamicRpcPayload,
});
export type OrganizationPanelDynamicRpcInvokeInput =
  typeof OrganizationPanelDynamicRpcInvokeInput.Type;

export const OrganizationPanelDynamicRpcInvokeResult = Schema.Struct({
  method: OrganizationPanelDynamicRpcMethod,
  result: OrganizationPanelDynamicRpcPayload,
});
export type OrganizationPanelDynamicRpcInvokeResult =
  typeof OrganizationPanelDynamicRpcInvokeResult.Type;

export const OrganizationPanelMetadata = Schema.Struct({
  organizationId: OrganizationId,
  panelSlug: OrganizationPanelSlug,
  panelFilePath: TrimmedNonEmptyString,
  panelImportPath: TrimmedNonEmptyString,
  versionId: OrganizationPanelVersionId,
  contentsHash: TrimmedNonEmptyString,
  document: OrganizationPanelDocument,
  editable: Schema.Boolean,
});
export type OrganizationPanelMetadata = typeof OrganizationPanelMetadata.Type;

export const OrganizationPanelVersionStatus = Schema.Literals(["applied", "rolled-back"]);
export type OrganizationPanelVersionStatus = typeof OrganizationPanelVersionStatus.Type;

export const OrganizationPanelVersion = Schema.Struct({
  id: OrganizationPanelVersionId,
  organizationId: OrganizationId,
  panelSlug: OrganizationPanelSlug,
  turnId: OrganizationPanelTurnId,
  prompt: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  beforeHash: TrimmedNonEmptyString,
  afterHash: TrimmedNonEmptyString,
  diff: Schema.String,
  status: OrganizationPanelVersionStatus,
  createdAt: IsoDateTime,
});
export type OrganizationPanelVersion = typeof OrganizationPanelVersion.Type;

export const OrganizationPanelTurnActivity = Schema.Struct({
  id: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  tone: Schema.Literals(["default", "success", "warning", "error"]),
});
export type OrganizationPanelTurnActivity = typeof OrganizationPanelTurnActivity.Type;

export const OrganizationPanelActiveTurn = Schema.Struct({
  turnId: OrganizationPanelTurnId,
  prompt: TrimmedNonEmptyString,
  status: Schema.Literals(["running", "completed", "failed"]),
  createdAt: IsoDateTime,
  filePath: Schema.NullOr(TrimmedNonEmptyString),
  attachments: Schema.Array(ChatAttachment).check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  ),
  activities: Schema.Array(OrganizationPanelTurnActivity),
});
export type OrganizationPanelActiveTurn = typeof OrganizationPanelActiveTurn.Type;

export const OrganizationPanelSnapshot = Schema.Struct({
  organization: OrganizationPanelOrganization,
  viewer: OrganizationPanelViewer,
  runtime: OrganizationPanelRuntime,
  panel: OrganizationPanelMetadata,
  latestVersion: Schema.NullOr(OrganizationPanelVersion),
  activeTurn: Schema.NullOr(OrganizationPanelActiveTurn),
});
export type OrganizationPanelSnapshot = typeof OrganizationPanelSnapshot.Type;

export const OrganizationPanelGetInput = Schema.Struct({
  organizationId: OrganizationId,
});
export type OrganizationPanelGetInput = typeof OrganizationPanelGetInput.Type;

export const OrganizationPanelGetResult = OrganizationPanelSnapshot;
export type OrganizationPanelGetResult = typeof OrganizationPanelGetResult.Type;

export const OrganizationPanelTurnStartInput = Schema.Struct({
  organizationId: OrganizationId,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  attachments: Schema.optional(
    Schema.Array(UploadChatAttachment).check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
    ),
  ),
});
export type OrganizationPanelTurnStartInput = typeof OrganizationPanelTurnStartInput.Type;

export const OrganizationPanelTurnStartResult = Schema.Struct({
  turnId: OrganizationPanelTurnId,
  version: OrganizationPanelVersion,
  snapshot: OrganizationPanelSnapshot,
});
export type OrganizationPanelTurnStartResult = typeof OrganizationPanelTurnStartResult.Type;

export const OrganizationPanelTurnStopInput = Schema.Struct({
  organizationId: OrganizationId,
  turnId: OrganizationPanelTurnId,
});
export type OrganizationPanelTurnStopInput = typeof OrganizationPanelTurnStopInput.Type;

export const OrganizationPanelTurnStopResult = Schema.Struct({
  stopped: Schema.Boolean,
});
export type OrganizationPanelTurnStopResult = typeof OrganizationPanelTurnStopResult.Type;

export const OrganizationPanelHistoryListInput = Schema.Struct({
  organizationId: OrganizationId,
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type OrganizationPanelHistoryListInput = typeof OrganizationPanelHistoryListInput.Type;

export const OrganizationPanelHistoryListResult = Schema.Struct({
  versions: Schema.Array(OrganizationPanelVersion),
});
export type OrganizationPanelHistoryListResult = typeof OrganizationPanelHistoryListResult.Type;

export const OrganizationPanelRollbackInput = Schema.Struct({
  organizationId: OrganizationId,
  versionId: OrganizationPanelVersionId,
});
export type OrganizationPanelRollbackInput = typeof OrganizationPanelRollbackInput.Type;

export const OrganizationPanelRollbackResult = Schema.Struct({
  version: OrganizationPanelVersion,
  snapshot: OrganizationPanelSnapshot,
});
export type OrganizationPanelRollbackResult = typeof OrganizationPanelRollbackResult.Type;

export const OrganizationPanelEventsSubscribeInput = Schema.Struct({
  organizationId: Schema.optional(OrganizationId),
});
export type OrganizationPanelEventsSubscribeInput =
  typeof OrganizationPanelEventsSubscribeInput.Type;

export const OrganizationPanelEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("panel.snapshot"),
    organizationId: OrganizationId,
    panelSlug: OrganizationPanelSlug,
    panelFilePath: TrimmedNonEmptyString,
    versionId: OrganizationPanelVersionId,
  }),
  Schema.Struct({
    type: Schema.Literal("turn.started"),
    organizationId: OrganizationId,
    turnId: OrganizationPanelTurnId,
    prompt: TrimmedNonEmptyString,
    attachments: Schema.optional(
      Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.delta"),
    organizationId: OrganizationId,
    turnId: OrganizationPanelTurnId,
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("file.patch"),
    organizationId: OrganizationId,
    turnId: OrganizationPanelTurnId,
    filePath: TrimmedNonEmptyString,
    diff: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("validation.result"),
    organizationId: OrganizationId,
    turnId: OrganizationPanelTurnId,
    status: Schema.Literals(["passed", "failed"]),
    errors: Schema.Array(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("compile.result"),
    organizationId: OrganizationId,
    turnId: OrganizationPanelTurnId,
    status: Schema.Literals(["passed", "failed"]),
    errors: Schema.Array(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.completed"),
    organizationId: OrganizationId,
    turnId: OrganizationPanelTurnId,
    versionId: OrganizationPanelVersionId,
  }),
  Schema.Struct({
    type: Schema.Literal("turn.failed"),
    organizationId: OrganizationId,
    turnId: OrganizationPanelTurnId,
    reason: TrimmedNonEmptyString,
  }),
]);
export type OrganizationPanelEvent = typeof OrganizationPanelEvent.Type;

export class OrganizationPanelError extends Schema.TaggedErrorClass<OrganizationPanelError>()(
  "OrganizationPanelError",
  {
    message: TrimmedNonEmptyString,
    code: Schema.Literals([
      "organization-not-found",
      "invalid-panel-slug",
      "path-outside-boundary",
      "panel-file-create-failed",
      "history-read-failed",
      "history-write-failed",
      "active-turn-running",
      "turn-not-found",
      "validation-failed",
      "write-failed",
      "rollback-unavailable",
      "rollback-failed",
      "dynamic-rpc-invalid",
      "dynamic-rpc-not-found",
      "dynamic-rpc-failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
