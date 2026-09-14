import * as Schema from "effect/Schema";
import {
  HermesWorkError,
  type HermesWorkGroupsQueryInput,
  type HermesWorkGroupsQueryResult,
  type HermesWorkGroupsMutateInput,
  type HermesWorkGroupsMutateResult,
} from "@t3tools/contracts";

export interface HermesWorkGroupsTransport {
  read(method: string, params: Record<string, unknown>): Promise<unknown>;
  mutate(
    method: string,
    params: Record<string, unknown>,
    options: { operationId: string },
  ): Promise<unknown>;
}
const NativeMember = Schema.Struct({
  member_id: Schema.String,
  profile: Schema.String,
  handle: Schema.String,
  display_name: Schema.optional(Schema.String),
});
const NativeRoom = Schema.Struct({
  room_id: Schema.String,
  name: Schema.String,
  members: Schema.Array(NativeMember),
  updated_at: Schema.Number,
  disbanded_at: Schema.optional(Schema.Number),
  latest_seq: Schema.optional(Schema.Number),
});
const NativeEvent = Schema.Struct({
  event_id: Schema.String,
  seq: Schema.Number,
  kind: Schema.String,
  created_at: Schema.Number,
  actor: Schema.Struct({
    id: Schema.optional(Schema.String),
    display_name: Schema.optional(Schema.String),
  }),
  payload: Schema.Struct({ text: Schema.optional(Schema.String) }),
});
const NativeList = Schema.Struct({
  rooms: Schema.Array(NativeRoom),
  next_offset: Schema.NullOr(Schema.Number),
});
const NativeState = Schema.Struct({ room: NativeRoom });
const NativeLog = Schema.Struct({
  events: Schema.Array(NativeEvent),
  cursor: Schema.Number,
  has_more: Schema.Boolean,
});
function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(input);
  } catch {
    throw new HermesWorkError({
      code: "invalid_response",
      message: "Hermes returned an invalid group response.",
    });
  }
}
function room(value: typeof NativeRoom.Type) {
  return {
    id: value.room_id,
    name: value.name,
    members: value.members.map((member) => ({
      id: member.member_id,
      profile: member.profile,
      handle: member.handle,
      name: member.display_name ?? member.handle,
    })),
    updatedAt: value.updated_at,
    disbandedAt: value.disbanded_at ?? null,
    latestSequence: value.latest_seq ?? 0,
  };
}
export async function queryHermesWorkGroups(
  transport: HermesWorkGroupsTransport,
  input: HermesWorkGroupsQueryInput,
): Promise<HermesWorkGroupsQueryResult> {
  if (!input.roomId) {
    const result = decode(
      NativeList,
      await transport.read("groups.list", {
        profile: input.profile,
        limit: 100,
        offset: input.offset ?? 0,
      }),
    );
    return {
      groups: result.rooms.map(room),
      events: [],
      cursor: 0,
      hasMore: result.next_offset !== null,
      nextOffset: result.next_offset,
    };
  }
  const params = { profile: input.profile, room_id: input.roomId };
  const state = decode(NativeState, await transport.read("groups.state", params));
  const log = decode(
    NativeLog,
    await transport.read("groups.log", { ...params, since_seq: input.cursor ?? 0, limit: 100 }),
  );
  return {
    groups: [room(state.room)],
    events: log.events.map((event) => ({
      id: event.event_id,
      sequence: event.seq,
      kind: event.kind,
      actor: event.actor.display_name ?? event.actor.id ?? "",
      text: event.payload.text ?? "",
      createdAt: event.created_at,
    })),
    cursor: log.cursor,
    hasMore: log.has_more,
    nextOffset: null,
  };
}
export async function mutateHermesWorkGroups(
  transport: HermesWorkGroupsTransport,
  input: HermesWorkGroupsMutateInput,
): Promise<HermesWorkGroupsMutateResult> {
  const command = input.command;
  const params = { profile: input.profile, room_id: command.roomId };
  const options = { operationId: input.operationId };
  switch (command.type) {
    case "create": {
      if (command.members.length < 2 || command.members.length > 6)
        throw new HermesWorkError({
          code: "invalid_input",
          message: "Choose between two and six assistants for a group.",
        });
      decode(
        NativeState,
        await transport.mutate(
          "groups.create",
          {
            ...params,
            name: command.name,
            members: command.members.map((member) => ({
              member_id: member.id,
              profile: member.profile,
              handle: member.handle,
              display_name: member.name,
            })),
          },
          options,
        ),
      );
      return { message: "Group created." };
    }
    case "send":
      decode(
        Schema.Struct({ accepted: Schema.Literal(true) }),
        await transport.mutate(
          "groups.send",
          {
            ...params,
            event_id: command.eventId,
            payload: { thread_id: command.threadId, text: command.text },
          },
          options,
        ),
      );
      return { message: "Message accepted." };
    case "rename":
      decode(
        NativeState,
        await transport.mutate(
          "groups.rename",
          { ...params, event_id: command.eventId, name: command.name },
          options,
        ),
      );
      return { message: "Group renamed." };
    case "stop":
      decode(
        Schema.Struct({ cancelled: Schema.Number }),
        await transport.mutate("groups.stop", { ...params, cancel_id: input.operationId }, options),
      );
      return { message: "Group stop requested." };
    case "remove":
      decode(
        Schema.Struct({ tombstone: Schema.Struct({ room_id: Schema.String }) }),
        await transport.mutate(
          "groups.disband",
          { ...params, cancel_id: input.operationId },
          options,
        ),
      );
      return { message: "Group removed." };
  }
}
