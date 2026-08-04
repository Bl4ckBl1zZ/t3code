import {
  ProjectCreatedPayload as ContractsProjectCreatedPayloadSchema,
  ProjectMetaUpdatedPayload as ContractsProjectMetaUpdatedPayloadSchema,
  ProjectDeletedPayload as ContractsProjectDeletedPayloadSchema,
} from "@t3tools/contracts/legacy-orchestration";

// Server-internal alias surface, backed by contract schemas as the source of truth.
export const ProjectCreatedPayload = ContractsProjectCreatedPayloadSchema;
export const ProjectMetaUpdatedPayload = ContractsProjectMetaUpdatedPayloadSchema;
export const ProjectDeletedPayload = ContractsProjectDeletedPayloadSchema;
