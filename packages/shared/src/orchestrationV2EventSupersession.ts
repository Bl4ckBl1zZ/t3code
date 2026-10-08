import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";

/**
 * Event types whose payload is the complete current state of one entity, and
 * which every client applies as a plain upsert keyed by `payload.id`. A later
 * event of the same type for the same entity overwrites everything an earlier
 * one wrote, so an undelivered earlier one can be dropped.
 *
 * Deliberately absent, because applying them reads or removes other state:
 * creation and deletion, `thread.provider-switched` and
 * `thread.title-reconciled`, runs and run attempts (transcript visibility is
 * computed from them, and clients find the latest run by array position),
 * provider sessions (detach removes them), provider turns (a later one may omit
 * token usage the client keeps from the earlier one), and checkpoints.
 */
const SUPERSEDABLE_EVENT_TYPES: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "thread.archived",
  "thread.unarchived",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.visited",
  "thread.marked-unread",
  "thread.metadata-updated",
  "thread.runtime-mode-updated",
  "thread.interaction-mode-updated",
  "thread.model-selection-updated",
  "node.updated",
  "subagent.updated",
  "provider-thread.updated",
  "runtime-request.updated",
  "message.updated",
  "turn-item.updated",
  "plan.updated",
  "context-handoff.updated",
  "context-transfer.updated",
]);

/** The entity an event overwrites in full, or null when it must always be delivered. */
export function orchestrationV2EventSupersessionKey(
  event: OrchestrationV2DomainEvent,
): string | null {
  if (!SUPERSEDABLE_EVENT_TYPES.has(event.type)) return null;
  const id = (event.payload as { readonly id?: unknown }).id;
  return typeof id === "string" ? `${event.type}\u0000${id}` : null;
}

interface KeySlots {
  first: number;
  last: number;
}

/**
 * Collects thread events that have not been sent yet and drops the ones a
 * later event makes redundant.
 *
 * For each entity it keeps the latest event and, until the entity has been
 * delivered once, also the first one in the batch: clients append an entity
 * they have not seen to the end of its array, so the first event fixes the
 * entity's position relative to its neighbours. Everything between the two is
 * dropped. Survivors keep their own sequence and relative order, so a batch
 * still ends with its highest sequence and clients that skip anything at or
 * below their cursor see a plain sequence gap.
 *
 * Applying the coalesced batch yields the same projection as applying every
 * event; `orchestrationV2Projection.test.ts` in client-runtime pins that.
 */
export class OrchestrationV2EventSupersession<T> {
  private pending: Array<T | undefined> = [];
  private live = 0;
  private readonly slots = new Map<string, KeySlots>();
  private readonly delivered = new Set<string>();
  private readonly keyOf: (item: T) => string | null;

  constructor(keyOf: (item: T) => string | null) {
    this.keyOf = keyOf;
  }

  /** Number of pending items that will be sent. */
  get size(): number {
    return this.live;
  }

  /**
   * Queue an item. Returns the pending item it made redundant, if any, so a
   * caller that accounts for pending cost can release it.
   */
  push(item: T): T | undefined {
    const key = this.keyOf(item);
    const index = this.pending.length;
    this.pending.push(item);
    this.live += 1;
    if (key === null) return undefined;

    const slots = this.slots.get(key);
    if (slots === undefined) {
      this.slots.set(key, { first: index, last: index });
      return undefined;
    }
    let dropped: T | undefined;
    // The first slot fixes array position for an entity the client may not
    // have yet; any other previous latest is now a middle event.
    if (slots.last !== slots.first || this.delivered.has(key)) {
      dropped = this.pending[slots.last];
      this.pending[slots.last] = undefined;
      this.live -= 1;
      if (slots.last === slots.first) slots.first = index;
    }
    slots.last = index;
    // A client that stops reading for a long turn would otherwise keep one
    // hole per superseded event.
    if (this.pending.length > 2 * this.live + 64) this.compact();
    return dropped;
  }

  /** Remove and return every pending item, marking their entities delivered. */
  take(): Array<T> {
    const items: Array<T> = [];
    for (const item of this.pending) {
      if (item !== undefined) items.push(item);
    }
    for (const key of this.slots.keys()) this.delivered.add(key);
    this.reset();
    return items;
  }

  /** Drop every pending item without delivering it. */
  clear(): void {
    this.reset();
  }

  private compact(): void {
    const moved = new Map<number, number>();
    const compacted: Array<T> = [];
    this.pending.forEach((item, index) => {
      if (item === undefined) return;
      moved.set(index, compacted.length);
      compacted.push(item);
    });
    for (const slots of this.slots.values()) {
      slots.first = moved.get(slots.first)!;
      slots.last = moved.get(slots.last)!;
    }
    this.pending = compacted;
  }

  private reset(): void {
    this.pending = [];
    this.live = 0;
    this.slots.clear();
  }
}

/** Coalesce one batch of thread events. */
export function coalesceOrchestrationV2Events<T>(
  items: Iterable<T>,
  eventOf: (item: T) => OrchestrationV2DomainEvent | null,
): Array<T> {
  const supersession = new OrchestrationV2EventSupersession<T>((item) => {
    const event = eventOf(item);
    return event === null ? null : orchestrationV2EventSupersessionKey(event);
  });
  for (const item of items) supersession.push(item);
  return supersession.take();
}
