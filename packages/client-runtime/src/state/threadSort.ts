import type { ProjectId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export interface ThreadSortInput {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestUserMessageAt?: string | null;
  readonly messages?: ReadonlyArray<{
    readonly createdAt: string;
    readonly role: string;
  }>;
}

export function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getFirstSortableTimestamp(...values: Array<string | null | undefined>): number | null {
  for (const value of values) {
    const timestamp = toSortableTimestamp(value ?? undefined);
    if (timestamp !== null) {
      return timestamp;
    }
  }

  return null;
}

function getLatestUserMessageTimestamp(thread: ThreadSortInput): number {
  if (thread.latestUserMessageAt) {
    const latestUserMessageTimestamp = toSortableTimestamp(thread.latestUserMessageAt);
    if (latestUserMessageTimestamp !== null) {
      return latestUserMessageTimestamp;
    }
  }

  let latestUserMessageTimestamp: number | null = null;

  for (const message of thread.messages ?? []) {
    if (message.role !== "user") continue;
    const messageTimestamp = toSortableTimestamp(message.createdAt);
    if (messageTimestamp === null) continue;
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp);
  }

  if (latestUserMessageTimestamp !== null) {
    return latestUserMessageTimestamp;
  }

  return getFirstSortableTimestamp(thread.updatedAt, thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function getThreadSortTimestamp(
  thread: ThreadSortInput,
  sortOrder: SidebarThreadSortOrder | Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return (
      getFirstSortableTimestamp(thread.createdAt, thread.updatedAt) ?? Number.NEGATIVE_INFINITY
    );
  }
  return getLatestUserMessageTimestamp(thread);
}

/**
 * Sort anchor for the active thread list: creation time, re-anchored to
 * unsettledAt when the thread last re-entered the active list (an explicit
 * un-settle, or a settled thread waking on activity). The list stays static
 * between lifecycle transitions, but an un-settled thread surfaces at the
 * top instead of sinking back to its creation-order slot. Shared by web and
 * mobile so both render the same order. Malformed timestamps sink to 0.
 */
export function activeThreadAnchorTimestampMs(thread: {
  readonly createdAt: string;
  readonly unsettledAt?: string | null | undefined;
}): number {
  return Math.max(
    toSortableTimestamp(thread.createdAt) ?? 0,
    toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
  );
}

export function sortThreads<T extends { readonly id: string } & ThreadSortInput>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
): T[] {
  return Arr.sort(
    threads,
    Order.mapInput(
      Order.Struct({
        timestamp: Order.flip(Order.Number),
        id: Order.flip(Order.String),
      }),
      (thread: T) => ({
        timestamp: getThreadSortTimestamp(thread, sortOrder),
        id: thread.id,
      }),
    ),
  );
}

export function getLatestThreadForProject<
  T extends {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly archivedAt: string | null;
  } & ThreadSortInput,
>(threads: readonly T[], projectId: ProjectId, sortOrder: SidebarThreadSortOrder): T | null {
  return (
    sortThreads(
      threads.filter((thread) => thread.projectId === projectId && thread.archivedAt === null),
      sortOrder,
    )[0] ?? null
  );
}

// ── Pinned reorder: fractional index keys ──────────────────────────────
// Pinned threads carry an optional pinOrderKey (a base-26 string). The
// pinned block sorts keyed threads by plain string comparison, so a drag
// (web) or Move up/down (mobile) writes ONE key to ONE thread on that
// thread's own server — neighbors, possibly living on other servers, are
// never touched, and every client connected to the same servers converges
// on the same order.
const PIN_ORDER_DIGITS = "abcdefghijklmnopqrstuvwxyz";

function isValidPinOrderKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) {
    if (!PIN_ORDER_DIGITS.includes(char)) return false;
  }
  // A trailing minimum digit would leave no room to sort a key immediately
  // before this one; generators never produce it, so treat it as corrupt.
  return key.at(-1) !== PIN_ORDER_DIGITS[0];
}

/** Midpoint of two digit strings interpreted as fractions in (0, 1).
    "" stands for the open bound on either side. Requires a < b. */
function pinOrderMidpoint(a: string, b: string): string {
  if (b !== "" && a >= b) throw new Error("pinOrderMidpoint: bounds out of order");
  if (b !== "") {
    // Recurse past the longest common prefix ("a" pads the shorter side).
    let n = 0;
    while ((a.charAt(n) || PIN_ORDER_DIGITS[0]) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + pinOrderMidpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : PIN_ORDER_DIGITS.indexOf(a.charAt(0));
  const digitB = b === "" ? PIN_ORDER_DIGITS.length : PIN_ORDER_DIGITS.indexOf(b.charAt(0));
  if (digitB - digitA > 1) {
    return PIN_ORDER_DIGITS.charAt(Math.round((digitA + digitB) / 2));
  }
  // Consecutive leading digits: either b has spare digits to shorten into,
  // or we extend a (never producing a trailing minimum digit — the base
  // case midpoint("", "") is the middle of the alphabet).
  if (b.length > 1) return b.charAt(0);
  return PIN_ORDER_DIGITS.charAt(digitA) + pinOrderMidpoint(a.slice(1), "");
}

/** Key that sorts strictly between two neighbors; null bounds mean "top of
    the pinned block" / "bottom of the keyed run". Returns null instead of
    throwing when existing keys are corrupt or out of order — callers fall
    back to rewriting the section. */
export function pinOrderKeyBetween(before: string | null, after: string | null): string | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== "" && !isValidPinOrderKey(a)) return null;
  if (b !== "" && !isValidPinOrderKey(b)) return null;
  if (b !== "" && a >= b) return null;
  return pinOrderMidpoint(a, b);
}

/** Evenly spaced keys for rewriting a whole pinned section (used when a
    drop lands next to keyless threads, so single-key insertion has nothing
    to anchor on). Two base-26 digits give 675 slots — far beyond any real
    pinned section — with monotonicity enforced as a belt-and-braces. */
export function generateSpreadPinOrderKeys(count: number): string[] {
  const space = PIN_ORDER_DIGITS.length * PIN_ORDER_DIGITS.length;
  const step = space / (count + 1);
  const keys: string[] = [];
  let previous = 0;
  for (let i = 0; i < count; i += 1) {
    let value = Math.max(Math.round(step * (i + 1)), previous + 1);
    // Skip values whose low digit is the minimum (a trailing "a" key).
    if (value % PIN_ORDER_DIGITS.length === 0) value += 1;
    value = Math.min(value, space - 1);
    previous = value;
    keys.push(
      PIN_ORDER_DIGITS.charAt(Math.floor(value / PIN_ORDER_DIGITS.length)) +
        PIN_ORDER_DIGITS.charAt(value % PIN_ORDER_DIGITS.length),
    );
  }
  return keys;
}

/**
 * Assignments needed to realize a new pinned order. When the moved thread
 * sits between two keyed (or absent) neighbors, this is a single write to
 * the moved thread. When a neighbor is keyless (threads pinned before
 * reordering shipped), the whole section gets fresh spread keys — a
 * one-time materialization; every move after that is single-write.
 */
export function planPinnedReorder(input: {
  /** Thread ids in the desired visual order (after the move). */
  readonly orderedIds: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  const { orderedIds, keysById, movedId } = input;
  const movedIndex = orderedIds.indexOf(movedId);
  if (movedIndex === -1) return [];
  const beforeId = movedIndex > 0 ? orderedIds[movedIndex - 1] : null;
  const afterId = movedIndex < orderedIds.length - 1 ? orderedIds[movedIndex + 1] : null;
  const beforeKey = beforeId != null ? (keysById.get(beforeId) ?? null) : null;
  const afterKey = afterId != null ? (keysById.get(afterId) ?? null) : null;
  const beforeUsable = beforeId === null || beforeKey != null;
  const afterUsable = afterId === null || afterKey != null;
  if (beforeUsable && afterUsable) {
    const key = pinOrderKeyBetween(beforeKey, afterKey);
    if (key !== null) return [{ id: movedId, orderKey: key }];
  }
  // Keyless neighbor (or corrupt keys): rewrite the section in the new order.
  const keys = generateSpreadPinOrderKeys(orderedIds.length);
  return orderedIds.flatMap((id, index) => {
    const key = keys[index]!;
    return keysById.get(id) === key ? [] : [{ id, orderKey: key }];
  });
}

/**
 * Pinned block order: user-arranged keys first (string comparison, id
 * tiebreak), then keyless threads newest-created first — so threads on
 * servers that predate reordering keep the static creation order at the
 * bottom of the block instead of breaking the section.
 */
export function sortPinnedThreadsByOrderKey<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly pinOrderKey?: string | null | undefined;
    /** Thread ids are only unique within an environment, and the pinned
        block merges environments — the tiebreak needs both parts or two
        clients could render equal-key threads in stream-arrival order. */
    readonly environmentId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  const keyed: T[] = [];
  const keyless: T[] = [];
  for (const thread of threads) {
    (thread.pinOrderKey != null ? keyed : keyless).push(thread);
  }
  const identityTiebreak = (left: T, right: T) =>
    left.id.localeCompare(right.id) ||
    (left.environmentId ?? "").localeCompare(right.environmentId ?? "");
  keyed.sort((left, right) => {
    const leftKey = left.pinOrderKey!;
    const rightKey = right.pinOrderKey!;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : identityTiebreak(left, right);
  });
  keyless.sort((left, right) => {
    const leftMs = Date.parse(left.createdAt);
    const rightMs = Date.parse(right.createdAt);
    return (
      (Number.isNaN(rightMs) ? 0 : rightMs) - (Number.isNaN(leftMs) ? 0 : leftMs) ||
      identityTiebreak(left, right)
    );
  });
  return [...keyed, ...keyless];
}

/**
 * planPinnedReorder specialized for mobile's Move up / Move down menu
 * actions: swap the moved thread with its displayed neighbor. Null when the
 * move falls off either end of the list. Same single-write-per-move
 * semantics as a web drag.
 */
export function planPinnedMove(input: {
  /** Reorder-capable pinned thread ids in displayed order. */
  readonly orderedIds: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
  readonly direction: "up" | "down";
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> | null {
  const { orderedIds, keysById, movedId, direction } = input;
  const from = orderedIds.indexOf(movedId);
  if (from === -1) return null;
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= orderedIds.length) return null;
  const newOrder = [...orderedIds];
  newOrder.splice(from, 1);
  newOrder.splice(to, 0, movedId);
  return planPinnedReorder({ orderedIds: newOrder, keysById, movedId });
}

/** Preserve automatic order among keyless rows; newly active threads precede
 * arranged rows, while arranged pins precede legacy pins. */
export function applyDurableThreadOrder<T>(
  threads: readonly T[],
  getKey: (thread: T) => string | null | undefined,
  isPinned: (thread: T) => boolean,
  getId: (thread: T) => string,
): T[] {
  return threads
    .map((thread, index) => ({ thread, index }))
    .toSorted((a, b) => {
      const pinned = isPinned(a.thread);
      const pinDifference = Number(isPinned(b.thread)) - Number(pinned);
      if (pinDifference !== 0) return pinDifference;
      const left = getKey(a.thread),
        right = getKey(b.thread);
      if (left != null && right != null) {
        if (left !== right) return left < right ? -1 : 1;
        const leftId = getId(a.thread),
          rightId = getId(b.thread);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      }
      if ((left != null) !== (right != null)) return (left != null ? -1 : 1) * (pinned ? 1 : -1);
      return a.index - b.index;
    })
    .map(({ thread }) => thread);
}

/** Materialize keyless sections together and reserve keys owned by hidden
 * threads, so a filter or another device cannot introduce duplicate positions. */
export function planDurableThreadReorder(
  orderedIds: readonly string[],
  movedId: string,
  keysById: ReadonlyMap<string, string | null | undefined>,
): ReadonlyMap<string, string> {
  const index = orderedIds.indexOf(movedId);
  if (index < 0 || new Set(orderedIds).size !== orderedIds.length) return new Map();
  const visible = new Set(orderedIds);
  const reserved = new Set(
    [...keysById].flatMap(([id, key]) => (!visible.has(id) && key != null ? [key] : [])),
  );
  const unchanged = orderedIds.filter((id) => id !== movedId);
  const keysAreOrdered = unchanged.every((id, i) => {
    const key = keysById.get(id);
    const previous = i === 0 ? null : keysById.get(unchanged[i - 1]!);
    return key != null && isValidPinOrderKey(key) && (previous == null || previous < key);
  });
  if (keysAreOrdered) {
    const before = index === 0 ? null : (keysById.get(orderedIds[index - 1]!) ?? null);
    const after =
      index + 1 === orderedIds.length ? null : (keysById.get(orderedIds[index + 1]!) ?? null);
    let key = pinOrderKeyBetween(before, after);
    while (key !== null && key.length <= 256 && reserved.has(key))
      key = pinOrderKeyBetween(key, after);
    if (key !== null && key.length <= 256) return new Map([[movedId, key]]);
  }
  // Dynamic width also handles imported histories exceeding the old 675 slots.
  const slots = orderedIds.length + reserved.size + 1;
  let capacity = 26,
    width = 1;
  while (capacity < slots * 2) {
    capacity *= 26;
    width += 1;
  }
  const stride = Math.max(1, Math.floor(capacity / slots));
  const encode = (value: number) => {
    let result = "";
    for (let i = 0; i < width; i += 1) {
      result = PIN_ORDER_DIGITS[value % 26] + result;
      value = Math.floor(value / 26);
    }
    return result + "n";
  };
  const assignments = new Map<string, string>();
  let value = 0;
  for (const id of orderedIds) {
    value += stride;
    while (reserved.has(encode(value))) value += stride;
    const key = encode(value);
    if (keysById.get(id) !== key) assignments.set(id, key);
  }
  return assignments;
}
