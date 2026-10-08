import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  EventId,
  MessageId,
  NodeId,
  RunId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  OrchestrationV2EventSupersession,
  coalesceOrchestrationV2Events,
  orchestrationV2EventSupersessionKey,
} from "@t3tools/shared/orchestrationV2EventSupersession";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { v2Projection, v2ProviderInstanceId, v2ThreadId } from "./orchestrationV2TestFixtures.ts";

// The server drops undelivered thread events that a later one supersedes
// before sending a frame. These tests pin the property that makes that safe:
// the client reducer ends in exactly the same projection either way.

interface Item {
  readonly sequence: number;
  readonly event: OrchestrationV2DomainEvent;
}

const threadId = v2ThreadId;
const runIds = [RunId.make("run-a"), RunId.make("run-b")];
const runStatuses = ["running", "completed", "cancelled", "rolled_back", "waiting"] as const;

/** Deterministic PRNG so a failure reproduces. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function at(step: number) {
  return DateTime.makeUnsafe(Date.UTC(2026, 5, 20, 0, 0, step));
}

function run(id: RunId, status: (typeof runStatuses)[number], step: number): OrchestrationV2Run {
  return {
    id,
    threadId,
    ordinal: id === runIds[0] ? 1 : 2,
    providerInstanceId: v2ProviderInstanceId,
    modelSelection: { instanceId: v2ProviderInstanceId, model: "gpt-5.4" },
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: NodeId.make(`node-${id}`),
    activeAttemptId: null,
    status,
    requestedAt: at(step),
    startedAt: at(step),
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function turnItem(index: number, step: number): OrchestrationV2TurnItem {
  const runId = runIds[index % runIds.length]!;
  const base = {
    id: TurnItemId.make(`item-${index}`),
    threadId,
    runId,
    nodeId: NodeId.make(`node-${runId}`),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: index + 1,
    status: "running",
    title: null,
    startedAt: at(step),
    completedAt: null,
    updatedAt: at(step),
  } as const;
  switch (index % 4) {
    case 0:
      return { ...base, type: "run_interrupt_request", message: `stop ${step}` };
    case 1:
      return { ...base, type: "run_interrupt_result", message: `stopped ${step}` };
    case 2:
      return {
        ...base,
        type: "user_message",
        messageId: MessageId.make(`message-item-${index}`),
        inputIntent: "queued_turn",
        text: `queued ${step}`,
        attachments: [],
      } as unknown as OrchestrationV2TurnItem;
    default:
      return {
        ...base,
        type: "command_execution",
        input: "ls",
        output: "x".repeat(step),
        exitCode: null,
      } as unknown as OrchestrationV2TurnItem;
  }
}

/** A mix of supersedable streaming updates and the structural events between them. */
function generateEvents(seed: number, count: number): Array<Item> {
  const next = random(seed);
  const pick = <A>(values: ReadonlyArray<A>) => values[Math.floor(next() * values.length)]!;
  const events: Array<Item> = [];
  for (let step = 1; step <= count; step += 1) {
    const occurredAt = at(step);
    const common = { id: EventId.make(`event-${step}`), threadId, occurredAt };
    const roll = next();
    let event: OrchestrationV2DomainEvent;
    if (roll < 0.35) {
      event = {
        ...common,
        type: "turn-item.updated",
        payload: turnItem(pick([0, 1, 2, 3, 4, 5, 6, 7]), step),
      };
    } else if (roll < 0.55) {
      const id = MessageId.make(pick(["message-1", "message-2", "message-3"]));
      event = {
        ...common,
        type: "message.updated",
        payload: {
          id,
          threadId,
          runId: null,
          nodeId: null,
          role: "assistant",
          text: `${id} at ${step}`,
          attachments: [],
          streaming: true,
          createdAt: occurredAt,
          updatedAt: occurredAt,
          createdBy: "provider",
          creationSource: "provider",
        },
      } as unknown as OrchestrationV2DomainEvent;
    } else if (roll < 0.65) {
      const id = NodeId.make(pick(["node-1", "node-2"]));
      event = {
        ...common,
        type: "node.updated",
        payload: {
          id,
          threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: id,
          kind: "tool_call",
          status: pick(["running", "completed"]),
        },
      } as unknown as OrchestrationV2DomainEvent;
    } else if (roll < 0.8) {
      const runId = pick(runIds);
      event = {
        ...common,
        runId,
        type: pick(["run.created", "run.updated"] as const),
        payload: run(runId, pick(runStatuses), step),
      };
    } else if (roll < 0.87) {
      const runId = pick(runIds);
      event = {
        ...common,
        type: "run-attempt.updated",
        payload: {
          id: `attempt-${runId}`,
          runId,
          threadId,
          rootNodeId: NodeId.make(`node-${runId}`),
          status: pick(["running", "superseded", "completed"]),
        },
      } as unknown as OrchestrationV2DomainEvent;
    } else if (roll < 0.95) {
      event = {
        ...common,
        type: pick(["thread.metadata-updated", "thread.visited", "thread.archived"] as const),
        payload: { ...v2Projection.thread, title: `title ${step}`, updatedAt: occurredAt },
      };
    } else {
      event = {
        ...common,
        type: "thread.title-reconciled",
        payload: { title: `reconciled ${step}`, revision: step % 7, origin: "hermes" },
      };
    }
    events.push({ sequence: step * 3, event });
  }
  return events;
}

function fold(
  projection: OrchestrationV2ThreadProjection,
  items: ReadonlyArray<Item>,
): OrchestrationV2ThreadProjection {
  let current = projection;
  for (const item of items) {
    current = applyOrchestrationV2ProjectionEvent(current, item.event) ?? current;
  }
  return current;
}

/** Deliver `items` in frames of random size, as a slow client would receive them. */
function deliverCoalesced(seed: number, items: ReadonlyArray<Item>) {
  const next = random(seed);
  const supersession = new OrchestrationV2EventSupersession<Item>((item) =>
    orchestrationV2EventSupersessionKey(item.event),
  );
  const frames: Array<Array<Item>> = [];
  let index = 0;
  while (index < items.length) {
    const frameSize = 1 + Math.floor(next() * 40);
    for (const item of items.slice(index, index + frameSize)) supersession.push(item);
    index += frameSize;
    frames.push(supersession.take());
  }
  return frames;
}

describe("thread event supersession", () => {
  it("converges to the same projection as applying every event", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const events = generateEvents(seed, 400);
      const frames = deliverCoalesced(seed * 31, events);
      const sent = frames.flat();

      expect(fold(v2Projection, sent), `seed ${seed}`).toEqual(fold(v2Projection, events));
      // Survivors keep their order, so clients that skip anything at or below
      // their cursor never discard one, and the last frame ends at the head.
      const sequences = sent.map((item) => item.sequence);
      expect(sequences).toEqual(sequences.toSorted((left, right) => left - right));
      expect(sent.at(-1)?.sequence).toBe(events.at(-1)?.sequence);
      expect(sent.length).toBeLessThan(events.length);
    }
  });

  it("keeps an entity's first appearance so array order matches the full stream", () => {
    const message = (id: string, step: number) =>
      ({
        id: `event-${step}`,
        threadId,
        occurredAt: at(step),
        type: "message.updated",
        payload: {
          id: MessageId.make(id),
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: `${id} ${step}`,
          attachments: [],
          streaming: false,
          createdAt: at(step),
          updatedAt: at(step),
          createdBy: "user",
          creationSource: "web",
        },
      }) as unknown as OrchestrationV2DomainEvent;
    const events = [
      message("first", 1),
      message("second", 2),
      message("first", 3),
      message("first", 4),
    ].map((event, index) => ({ sequence: index + 1, event }));

    const sent = coalesceOrchestrationV2Events(events, (item) => item.event);

    expect(sent.map((item) => item.sequence)).toEqual([1, 2, 4]);
    expect(fold(v2Projection, sent).messages.map((entry) => entry.id)).toEqual(["first", "second"]);
  });
});
