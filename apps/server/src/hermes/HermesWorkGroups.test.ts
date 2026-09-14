import { describe, expect, it, vi } from "@effect/vitest";
import { mutateHermesWorkGroups, queryHermesWorkGroups } from "./HermesWorkGroups.js";

const input = { providerInstanceId: "hermes", profile: "default" };
const group = {
  room_id: "room",
  name: "Team",
  members: [{ member_id: "a", profile: "research", handle: "research" }],
  updated_at: 123,
  latest_seq: 9,
};
describe("Hermes Work groups", () => {
  it("keeps replay cursors and maps native room identity", async () => {
    const transport = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ room: group })
        .mockResolvedValueOnce({
          events: [
            {
              event_id: "e",
              seq: 9,
              kind: "message.user",
              actor: { id: "desktop" },
              payload: { text: "Hello" },
              created_at: 123,
            },
          ],
          cursor: 9,
          has_more: true,
        }),
      mutate: vi.fn(),
    };
    const result = await queryHermesWorkGroups(transport, { ...input, roomId: "room", cursor: 8 });
    expect(transport.read).toHaveBeenLastCalledWith("groups.log", {
      profile: "default",
      room_id: "room",
      since_seq: 8,
      limit: 100,
    });
    expect(result).toMatchObject({
      cursor: 9,
      hasMore: true,
      groups: [{ id: "room", latestSequence: 9 }],
      events: [{ text: "Hello", sequence: 9 }],
    });
  });
  it("sends only native inert user payload and keeps caller retry identity", async () => {
    const transport = { read: vi.fn(), mutate: vi.fn().mockResolvedValue({ accepted: true }) };
    await mutateHermesWorkGroups(transport, {
      ...input,
      operationId: "op",
      command: {
        type: "send",
        roomId: "room",
        eventId: "event",
        threadId: "thread",
        text: "@research investigate",
      },
    });
    expect(transport.mutate).toHaveBeenCalledExactlyOnceWith(
      "groups.send",
      {
        profile: "default",
        room_id: "room",
        event_id: "event",
        payload: { thread_id: "thread", text: "@research investigate" },
      },
      { operationId: "op" },
    );
  });
  it("rejects malformed native responses instead of claiming success", async () => {
    const transport = { read: vi.fn().mockResolvedValue({ rooms: "invalid" }), mutate: vi.fn() };
    await expect(queryHermesWorkGroups(transport, input)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
  it("rejects an invalid roster before creating work", async () => {
    const transport = { read: vi.fn(), mutate: vi.fn() };
    await expect(
      mutateHermesWorkGroups(transport, {
        ...input,
        operationId: "op",
        command: { type: "create", roomId: "room", name: "Team", members: [] },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(transport.mutate).not.toHaveBeenCalled();
  });
});
