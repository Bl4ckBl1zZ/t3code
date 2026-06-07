import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  PortSchema,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkspaceId,
} from "./baseSchemas.ts";

export const PreviewTargetStatus = Schema.Literals([
  "starting",
  "reachable",
  "unreachable",
  "stale",
]);
export type PreviewTargetStatus = typeof PreviewTargetStatus.Type;

export const PreviewTargetSource = Schema.Literals([
  "explicit",
  "terminal-output",
  "process-listener",
  "script-hint",
  "framework-default",
]);
export type PreviewTargetSource = typeof PreviewTargetSource.Type;

export const PreviewTarget = Schema.Struct({
  id: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  workspaceId: WorkspaceId,
  cwd: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  port: PortSchema,
  status: PreviewTargetStatus,
  source: PreviewTargetSource,
  confidence: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  terminalId: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
  scriptId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  pid: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  command: Schema.optional(Schema.String.check(Schema.isMaxLength(8_192))),
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  lastVerifiedAt: Schema.optional(IsoDateTime),
});
export type PreviewTarget = typeof PreviewTarget.Type;
