import * as Schema from "effect/Schema";
import { HermesWorkArtifact } from "./hermesWorkArtifacts.ts";

export const HermesWorkConnection = Schema.Struct({
  providerInstanceId: Schema.String,
  displayName: Schema.String,
  configured: Schema.Boolean,
});
export const HermesWorkProfile = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  model: Schema.String,
  isDefault: Schema.Boolean,
});
export const HermesWorkSchedule = Schema.Struct({
  continuity: Schema.optional(Schema.Boolean),
  lastDeliveryError: Schema.optional(Schema.NullOr(Schema.String)),
  id: Schema.String,
  profile: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  schedule: Schema.String,
  paused: Schema.Boolean,
  deliver: Schema.String,
  model: Schema.NullOr(Schema.String),
  nextRunAt: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  lastStatus: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});
export const HermesWorkRun = Schema.Struct({
  id: Schema.String,
  profile: Schema.String,
  title: Schema.String,
  startedAt: Schema.NullOr(Schema.Number),
  endedAt: Schema.NullOr(Schema.Number),
  active: Schema.Boolean,
  jobId: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  deliveryStatus: Schema.NullOr(Schema.String),
  content: Schema.NullOr(Schema.String),
  readAt: Schema.NullOr(Schema.String),
});
export const HermesWorkSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
});
export const HermesWorkChannel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  configured: Schema.Boolean,
  fields: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      label: Schema.String,
      secret: Schema.Boolean,
      configured: Schema.Boolean,
    }),
  ),
});
export const HermesWorkFile = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  directory: Schema.Boolean,
  size: Schema.NullOr(Schema.Number),
});
export const HermesWorkSection = Schema.Literals([
  "thread",
  "status",
  "automation",
  "sessions",
  "profiles",
  "schedules",
  "runs",
  "run",
  "skills",
  "skill",
  "instructions",
  "memory",
  "channels",
  "files",
  "file",
  "artifacts",
  "artifact",
]);
export const HermesWorkQueryInput = Schema.Struct({
  providerInstanceId: Schema.String,
  profile: Schema.String,
  section: HermesWorkSection,
  offset: Schema.optional(Schema.Number),
  id: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
});
export type HermesWorkQueryInput = typeof HermesWorkQueryInput.Type;
export const HermesWorkSession = Schema.Struct({
  id: Schema.String,
  profile: Schema.String,
  title: Schema.String,
  preview: Schema.String,
  active: Schema.Boolean,
  updatedAt: Schema.NullOr(Schema.Number),
});
export const HermesWorkThreadDetails = Schema.Struct({
  schedulesAvailable: Schema.optional(Schema.Boolean),
  threadId: Schema.String,
  status: Schema.Literals(["bound", "unbound", "unavailable"]),
  providerInstanceId: Schema.NullOr(Schema.String),
  profile: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  workspacePath: Schema.NullOr(Schema.String),
  schedules: Schema.Array(
    Schema.Struct({
      ...HermesWorkSchedule.fields,
      relationship: Schema.Literals(["run_of", "created_here"]),
    }),
  ),
  gatewayRunning: Schema.NullOr(Schema.Boolean),
  gatewayState: Schema.NullOr(Schema.String),
});
export type HermesWorkThreadDetails = typeof HermesWorkThreadDetails.Type;
export const HermesWorkQueryResult = Schema.Struct({
  threadDetails: Schema.optional(HermesWorkThreadDetails),
  artifacts: Schema.optional(Schema.Array(HermesWorkArtifact)),
  artifactsNextOffset: Schema.optional(Schema.NullOr(Schema.Number)),
  automation: Schema.optional(
    Schema.Struct({ timezone: Schema.String, allowAgentScheduling: Schema.Boolean }),
  ),
  sessions: Schema.optional(Schema.Array(HermesWorkSession)),
  gatewayRunning: Schema.NullOr(Schema.Boolean),
  gatewayState: Schema.NullOr(Schema.String),
  profiles: Schema.Array(HermesWorkProfile),
  schedules: Schema.Array(HermesWorkSchedule),
  runs: Schema.Array(HermesWorkRun),
  skills: Schema.Array(HermesWorkSkill),
  channels: Schema.Array(HermesWorkChannel),
  files: Schema.Array(HermesWorkFile),
  content: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  diagnostics: Schema.Array(Schema.String),
});
export type HermesWorkQueryResult = typeof HermesWorkQueryResult.Type;
const ScheduleFields = {
  continuity: Schema.optional(Schema.Boolean),
  name: Schema.String,
  prompt: Schema.String,
  schedule: Schema.String,
  deliver: Schema.String,
  model: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  paused: Schema.optional(Schema.Boolean),
  skills: Schema.optional(Schema.Array(Schema.String)),
  contextFrom: Schema.optional(Schema.Array(Schema.String)),
  enabledToolsets: Schema.optional(Schema.Array(Schema.String)),
};
export const HermesWorkCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("automation.save"),
    timezone: Schema.String,
    allowAgentScheduling: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("conversation.open"),
    sourceThreadId: Schema.optional(Schema.String),
    sessionId: Schema.optional(Schema.String),
    surface: Schema.optional(Schema.Literals(["work", "chat"])),
  }),
  Schema.Struct({ type: Schema.Literals(["gateway.start", "gateway.stop"]) }),
  Schema.Struct({ type: Schema.Literal("schedule.create"), ...ScheduleFields }),
  Schema.Struct({ type: Schema.Literal("schedule.update"), id: Schema.String, ...ScheduleFields }),
  Schema.Struct({
    type: Schema.Literals(["schedule.pause", "schedule.resume", "schedule.run", "schedule.remove"]),
    id: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("profile.create"),
    name: Schema.String,
    description: Schema.String,
    model: Schema.optional(Schema.String),
    provider: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("profile.rename"),
    name: Schema.String,
    newName: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("profile.remove"), name: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("profile.describe"),
    name: Schema.String,
    description: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("profile.model"),
    name: Schema.String,
    model: Schema.String,
    provider: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("instructions.save"), content: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("skill.toggle"),
    name: Schema.String,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literals(["skill.create", "skill.save"]),
    name: Schema.String,
    content: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("memory.save"),
    file: Schema.Literals(["MEMORY.md", "USER.md"]),
    content: Schema.String,
    expectedContent: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("channel.save"),
    id: Schema.String,
    enabled: Schema.Boolean,
    values: Schema.Record(Schema.String, Schema.String),
  }),
]);
export type HermesWorkCommand = typeof HermesWorkCommand.Type;
export const HermesWorkMutateInput = Schema.Struct({
  providerInstanceId: Schema.String,
  profile: Schema.String,
  command: HermesWorkCommand,
});
export type HermesWorkMutateInput = typeof HermesWorkMutateInput.Type;
export const HermesWorkMutateResult = Schema.Struct({
  message: Schema.String,
  threadId: Schema.optional(Schema.String),
});
export type HermesWorkMutateResult = typeof HermesWorkMutateResult.Type;
export const HermesWorkConnectionsInput = Schema.Struct({});
export const HermesWorkConnectionsResult = Schema.Struct({
  connections: Schema.Array(HermesWorkConnection),
});
export type HermesWorkConnectionsResult = typeof HermesWorkConnectionsResult.Type;
export class HermesWorkError extends Schema.TaggedErrorClass<HermesWorkError>()("HermesWorkError", {
  code: Schema.Literals([
    "not_configured",
    "unavailable",
    "unsupported",
    "invalid_input",
    "not_found",
    "conflict",
    "unauthorized",
    "indeterminate",
    "invalid_response",
  ]),
  message: Schema.String,
}) {}

export const HermesWorkSubscribeChangesInput = Schema.Struct({ providerInstanceId: Schema.String });
export type HermesWorkSubscribeChangesInput = typeof HermesWorkSubscribeChangesInput.Type;
export const HermesWorkChangeEvent = Schema.Struct({
  providerInstanceId: Schema.String,
  kind: Schema.Literals(["cron.changed", "sessions.changed", "reconnected"]),
});
export type HermesWorkChangeEvent = typeof HermesWorkChangeEvent.Type;
