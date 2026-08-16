/**
 * Legacy (V1) orchestration contracts.
 *
 * Threads moved to the orchestration V2 aggregate (`orchestrationV2.ts`); what
 * remains here is the project aggregate's event-sourced command/event surface,
 * which the server still dispatches through the V1 orchestration engine.
 *
 * @module orchestration
 */
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ThreadEnvMode } from "./environment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { Project, ProjectScript } from "./project.ts";
import {
  ApplicationEventMetadata,
  ApplicationProjectCreatedEvent,
  ApplicationProjectDeletedEvent,
  ApplicationProjectMetaUpdatedEvent,
} from "./applicationEvent.ts";

export {
  ApplicationProjectCreatedPayload as ProjectCreatedPayload,
  ApplicationProjectDeletedPayload as ProjectDeletedPayload,
  ApplicationProjectMetaUpdatedPayload as ProjectMetaUpdatedPayload,
} from "./applicationEvent.ts";

export const ProjectFaviconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i),
);
export type ProjectFaviconPath = typeof ProjectFaviconPath.Type;

export const OrchestrationProject = Project.mapFields(
  Struct.assign({
    faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  }),
);
export type OrchestrationProject = typeof OrchestrationProject.Type;

/**
 * The decider's in-memory state. Command invariants are evaluated against it,
 * so it carries soft-deleted projects too.
 */
export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  createdAt: IsoDateTime,
});

export const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  // Absent = leave unchanged; null = clear the override.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

export const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optional(Schema.Boolean),
});

export const ProjectOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
]);
export type ProjectOrchestrationCommand = typeof ProjectOrchestrationCommand.Type;

export const OrchestrationCommand = ProjectOrchestrationCommand;
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

// Threads still occupy the 'thread' aggregate in `orchestration_events` and
// `orchestration_command_receipts` under the V2 event version, so both kinds
// remain valid column values even though V1 only ever writes projects.
export const OrchestrationAggregateKind = Schema.Literals(["project", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const OrchestrationEventMetadata = ApplicationEventMetadata;
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

export const OrchestrationEvent = Schema.Union([
  ApplicationProjectCreatedEvent,
  ApplicationProjectMetaUpdatedEvent,
  ApplicationProjectDeletedEvent,
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;
