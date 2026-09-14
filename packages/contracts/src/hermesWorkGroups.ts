import * as Schema from "effect/Schema";

export const HermesWorkGroupMember = Schema.Struct({
  id: Schema.String,
  profile: Schema.String,
  handle: Schema.String,
  name: Schema.String,
});
export const HermesWorkGroup = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  members: Schema.Array(HermesWorkGroupMember),
  updatedAt: Schema.Number,
  disbandedAt: Schema.NullOr(Schema.Number),
  latestSequence: Schema.Number,
});
export const HermesWorkGroupEvent = Schema.Struct({
  id: Schema.String,
  sequence: Schema.Number,
  kind: Schema.String,
  actor: Schema.String,
  text: Schema.String,
  createdAt: Schema.Number,
});
export const HermesWorkGroupsQueryInput = Schema.Struct({
  providerInstanceId: Schema.String,
  profile: Schema.String,
  roomId: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.Number),
  offset: Schema.optional(Schema.Number),
});
export type HermesWorkGroupsQueryInput = typeof HermesWorkGroupsQueryInput.Type;
export const HermesWorkGroupsQueryResult = Schema.Struct({
  groups: Schema.Array(HermesWorkGroup),
  events: Schema.Array(HermesWorkGroupEvent),
  cursor: Schema.Number,
  hasMore: Schema.Boolean,
  nextOffset: Schema.NullOr(Schema.Number),
});
export type HermesWorkGroupsQueryResult = typeof HermesWorkGroupsQueryResult.Type;
export const HermesWorkGroupCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    roomId: Schema.String,
    name: Schema.String,
    members: Schema.Array(HermesWorkGroupMember),
  }),
  Schema.Struct({
    type: Schema.Literal("send"),
    roomId: Schema.String,
    eventId: Schema.String,
    threadId: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("rename"),
    roomId: Schema.String,
    eventId: Schema.String,
    name: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literals(["stop", "remove"]), roomId: Schema.String }),
]);
export const HermesWorkGroupsMutateInput = Schema.Struct({
  providerInstanceId: Schema.String,
  profile: Schema.String,
  operationId: Schema.String,
  command: HermesWorkGroupCommand,
});
export type HermesWorkGroupsMutateInput = typeof HermesWorkGroupsMutateInput.Type;
export const HermesWorkGroupsMutateResult = Schema.Struct({ message: Schema.String });
export type HermesWorkGroupsMutateResult = typeof HermesWorkGroupsMutateResult.Type;
