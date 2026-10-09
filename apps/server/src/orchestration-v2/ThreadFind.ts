import {
  OrchestrationV2TurnItemJson,
  type OrchestrationV2ProjectedTurnItem,
  OrchestrationV2SearchThreadInput,
  type OrchestrationV2SearchThreadResult,
  type OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import { searchableMessageSegments, searchablePlanSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  ProjectionStoreReadError,
  ProjectionStoreThreadNotFoundError,
  type ProjectionStoreV2Error,
} from "./ProjectionStore.ts";

/**
 * Find in one thread. Counts matches of a query in the text the timeline shows
 * for user and assistant messages and proposed plans (see `threadFindText`),
 * in visible item order including inherited fork history, and selects one
 * match by ordinal or relative to an entry identity.
 */

/** A visible row before its payload is read: what the find index needs. */
export interface ThreadFindIndexRow {
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: string;
  readonly item: Pick<OrchestrationV2TurnItem, "type">;
}

interface FindRow extends Omit<ThreadFindIndexRow, "item"> {
  readonly position: number;
}
interface FindPayload extends FindRow {
  readonly payload: string;
  readonly entryId: string;
}
interface FindDocument extends FindRow {
  readonly entryId: string;
  readonly runId: OrchestrationV2TurnItem["runId"];
  readonly count: number;
}

const SEARCHABLE_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "user_message",
  "assistant_message",
  "proposed_plan",
]);

type SearchableItem = Extract<
  OrchestrationV2TurnItem,
  { type: "user_message" | "assistant_message" | "proposed_plan" }
>;

type UserMessageItem = Extract<OrchestrationV2TurnItem, { type: "user_message" }>;

class TextKey extends Data.Class<{
  text: string;
  role: "user" | "assistant" | "plan";
  streaming: boolean;
  // User prompts: legacy scheduled-task attribution depends on these.
  messageId: string | undefined;
  createdBy: UserMessageItem["createdBy"] | undefined;
  scheduledTaskId: UserMessageItem["scheduledTaskId"];
  cwd: string | undefined;
  skills: NonNullable<OrchestrationV2SearchThreadInput["skills"]>;
}> {}

function textKey(item: SearchableItem, cwd: string | undefined, skills: TextKey["skills"]) {
  return new TextKey({
    text: item.type === "proposed_plan" ? item.markdown : item.text,
    role:
      item.type === "proposed_plan" ? "plan" : item.type === "user_message" ? "user" : "assistant",
    streaming: item.type !== "user_message" && item.streaming,
    messageId: item.type === "user_message" ? item.messageId : undefined,
    createdBy: item.type === "user_message" ? item.createdBy : undefined,
    scheduledTaskId: item.type === "user_message" ? item.scheduledTaskId : undefined,
    cwd,
    skills,
  });
}

function parseText(key: TextKey): readonly string[] {
  if (key.role === "plan") return searchablePlanSegments(key.text, key.cwd);
  return (
    searchableMessageSegments(
      {
        role: key.role,
        text: key.text,
        streaming: key.streaming,
        ...(key.messageId === undefined ? {} : { id: key.messageId }),
        ...(key.createdBy === undefined ? {} : { createdBy: key.createdBy }),
        ...(key.scheduledTaskId === undefined ? {} : { scheduledTaskId: key.scheduledTaskId }),
      },
      key.cwd,
      key.skills,
    ) ?? []
  );
}

function isSearchableItem(item: OrchestrationV2TurnItem): item is SearchableItem {
  return SEARCHABLE_ITEM_TYPES.has(item.type);
}

/** Messages are addressed by message id (the timeline row id); plans by turn item id. */
function entryIdFor(item: SearchableItem): string {
  return item.type === "proposed_plan" ? item.id : item.messageId;
}

function documentFor(row: FindRow, item: SearchableItem, count: number): FindDocument {
  return {
    position: row.position,
    visibility: row.visibility,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
    entryId: entryIdFor(item),
    runId: item.runId,
    count,
  };
}

function countSegments(segments: readonly string[], query: string) {
  return segments.reduce((sum, text) => sum + countThreadSearchOccurrences(text, query), 0);
}

function selectMatch(
  documents: readonly FindDocument[],
  input: Pick<OrchestrationV2SearchThreadInput, "index" | "start" | "offset">,
) {
  const totalMatches = documents.reduce((sum, doc) => sum + doc.count, 0);
  let requestedIndex = input.index ?? 0;
  if (input.index === undefined && input.start) {
    const startIndex = documents.findIndex((doc) => doc.entryId === input.start?.entryId);
    if (startIndex >= 0) {
      requestedIndex =
        documents.slice(0, startIndex).reduce((sum, doc) => sum + doc.count, 0) +
        Math.min(input.start.occurrence, documents[startIndex]!.count);
      if (requestedIndex >= totalMatches) requestedIndex = 0;
    }
  }
  const activeIndex =
    input.index === undefined && totalMatches > 0
      ? (((requestedIndex + (input.offset ?? 0)) % totalMatches) + totalMatches) % totalMatches
      : Math.min(requestedIndex, Math.max(0, totalMatches - 1));
  let occurrence = activeIndex;
  for (const document of documents) {
    if (occurrence < document.count) return { totalMatches, activeIndex, document, occurrence };
    occurrence -= document.count;
  }
  return { totalMatches, activeIndex, document: null, occurrence: 0 };
}

const NAVIGATION_WINDOW = 17;

function resultForSelection(
  selected: ReturnType<typeof selectMatch>,
  documents: readonly FindDocument[],
  snapshotSequence: number,
): OrchestrationV2SearchThreadResult {
  let startIndex = 0;
  const entries = documents.flatMap(({ entryId, runId, count }) => {
    const entry = { entryId, runId, count, startIndex };
    startIndex += count;
    return count > 0 ? [entry] : [];
  });
  const selectedEntry = entries.findIndex((entry) => entry.entryId === selected.document?.entryId);
  const navigation =
    entries.length <= NAVIGATION_WINDOW
      ? entries
      : Array.from(
          { length: NAVIGATION_WINDOW },
          (_, i) =>
            entries[
              (selectedEntry + i - (NAVIGATION_WINDOW - 1) / 2 + entries.length) % entries.length
            ]!,
        );
  return {
    snapshotSequence,
    totalMatches: selected.totalMatches,
    activeIndex: selected.activeIndex,
    navigation,
    match:
      selected.document === null
        ? null
        : {
            entryId: selected.document.entryId,
            runId: selected.document.runId,
            occurrence: selected.occurrence,
          },
  };
}

/** The memory projection uses the same match ordering as SQLite. */
export function findProjectedThreadItems(
  items: readonly OrchestrationV2ProjectedTurnItem[],
  input: OrchestrationV2SearchThreadInput,
  snapshotSequence: number,
  cwd?: string,
): OrchestrationV2SearchThreadResult {
  const docs = items.flatMap((row) => {
    const { item } = row;
    if (!isSearchableItem(item)) return [];
    const count = countSegments(parseText(textKey(item, cwd, input.skills ?? [])), input.query);
    return [documentFor(row, item, count)];
  });
  return resultForSelection(selectMatch(docs, input), docs, snapshotSequence);
}

/**
 * Reads the visible-row index once per scan, including inherited fork rows,
 * and only the payloads of searchable rows. Parsed text is cached per message
 * body, and finished scans per query, so typing and stepping reuse both.
 */
export const makeThreadFind = Effect.fn("makeThreadFind")(function* (input: {
  readonly readIndex: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ThreadFindIndexRow>, ProjectionStoreV2Error>;
  /** Pins one read snapshot without taking the write lock. */
  readonly withReadTransaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError, R>;
}) {
  const { readIndex, withReadTransaction } = input;
  const sql = yield* SqlClient.SqlClient;
  const encodeCacheKey = Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        threadId: ThreadId,
        cwd: Schema.optional(Schema.String),
        query: Schema.String,
        skills: OrchestrationV2SearchThreadInput.fields.skills,
      }),
    ),
  );
  const encodeThreadIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ThreadId)));
  const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
  const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
  const isSnapshotError = Schema.is(
    Schema.Union([ProjectionStoreReadError, ProjectionStoreThreadNotFoundError]),
  );
  const load = Effect.fn("ThreadFind.load")(function* (
    threadId: ThreadId,
    rows: readonly FindRow[],
  ) {
    if (rows.length === 0) return [];
    // Turn item ids are globally unique, so inherited rows read by id alone.
    const ids = yield* encodeIds(rows.map((row) => row.sourceItemId)).pipe(
      Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
    );
    const payloads = yield* sql<{
      turn_item_id: string;
      payload_json: string;
      entry_id: string;
    }>`
      SELECT item.turn_item_id, item.payload_json,
        COALESCE(json_extract(item.payload_json, '$.messageId'), item.turn_item_id) AS entry_id
      FROM orchestration_v2_projection_turn_items AS item
      WHERE item.turn_item_id IN (SELECT value FROM json_each(${ids}))
    `.pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })));
    const byId = new Map(payloads.map((row) => [row.turn_item_id, row]));
    return yield* Effect.forEach(rows, (row) => {
      const payload = byId.get(row.sourceItemId);
      return payload === undefined
        ? Effect.fail(new ProjectionStoreReadError({ threadId }))
        : Effect.succeed({ ...row, payload: payload.payload_json, entryId: payload.entry_id });
    });
  });
  // Cache rendered segments, not queries; typing and navigation reuse Markdown parsing.
  const textCache = yield* Cache.make({
    capacity: 512,
    timeToLive: "1 minute",
    lookup: (key: TextKey) => Effect.sync(() => parseText(key)),
  });
  // Bounded separately because each entry can hold a large body; typing reuses the parse.
  const largeTextCache = yield* Cache.make({
    capacity: 32,
    timeToLive: "1 minute",
    lookup: (key: TextKey) => Effect.sync(() => parseText(key)),
  });
  // Scans retain counts and item references, never message bodies. Navigation checks
  // the current revision in its transaction without reloading message payloads.
  const scans = new Map<
    string,
    {
      sequence: number;
      documents: readonly FindDocument[];
      sourceThreadIds: readonly ThreadId[];
    }
  >();
  const readRevision = Effect.fn("ThreadFind.readRevision")(function* (
    threadIds: readonly ThreadId[],
  ) {
    const sources = yield* encodeThreadIds(threadIds);
    const revision = yield* sql<{ sequence: number }>`
      WITH RECURSIVE source_threads(thread_id) AS (
        SELECT value FROM json_each(${sources})
        UNION
        SELECT json_extract(t.payload_json, '$.forkedFrom.threadId')
        FROM orchestration_v2_projection_threads t
        JOIN source_threads s ON s.thread_id = t.thread_id
        WHERE json_extract(t.payload_json, '$.forkedFrom.type') = 'run'
      )
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
      WHERE application_event_version = 2 AND aggregate_kind = 'thread'
        AND stream_id IN (SELECT thread_id FROM source_threads)
    `;
    return revision[0]?.sequence ?? 0;
  });
  const snapshot = (input: OrchestrationV2SearchThreadInput) =>
    withReadTransaction(
      Effect.gen(function* () {
        const { threadId } = input;
        // Same base the web resolves relative file links against.
        const active = yield* sql<{ cwd: string | null }>`
          SELECT COALESCE(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) AS cwd
          FROM orchestration_v2_projection_threads t
          LEFT JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL
          WHERE t.thread_id = ${threadId} AND t.deleted_at IS NULL
        `;
        if (!active[0]) return yield* new ProjectionStoreThreadNotFoundError({ threadId });
        const cwd = active[0].cwd ?? undefined;
        const cacheKey = yield* encodeCacheKey({
          threadId,
          cwd,
          query: input.query,
          skills: input.skills ?? [],
        });
        const cached = scans.get(cacheKey);
        if (cached && cached.sequence === (yield* readRevision(cached.sourceThreadIds))) {
          const selected = selectMatch(cached.documents, input);
          scans.delete(cacheKey);
          scans.set(cacheKey, cached);
          return { result: resultForSelection(selected, cached.documents, cached.sequence) };
        }
        const index = yield* readIndex(threadId);
        const sourceThreadIds = [...new Set([threadId, ...index.map((row) => row.sourceThreadId)])];
        const sequence = yield* readRevision(sourceThreadIds);
        const candidates = index
          .map(({ item, ...row }, position) => ({ ...row, type: item.type, position }))
          .filter((row) => SEARCHABLE_ITEM_TYPES.has(row.type))
          .map(({ type: _type, ...row }) => row);
        const payloads: FindPayload[] = [];
        for (let start = 0; start < candidates.length; start += 128) {
          payloads.push(...(yield* load(threadId, candidates.slice(start, start + 128))));
        }
        return { payloads, cwd, sequence, cacheKey, sourceThreadIds };
      }),
    ).pipe(
      Effect.mapError((cause) =>
        isSnapshotError(cause)
          ? cause
          : new ProjectionStoreReadError({ threadId: input.threadId, cause }),
      ),
    );
  const searchThreadStream = (input: OrchestrationV2SearchThreadInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Release SQLite before decoding and parsing. Both frames describe one snapshot.
        const data = yield* snapshot(input);
        if ("result" in data) return Stream.succeed(data.result);
        const { payloads: rows, cwd, sequence, cacheKey, sourceThreadIds } = data;
        const documents = new Map<number, FindDocument>();
        const count = Effect.fnUntraced(function* (row: FindPayload) {
          const cached = documents.get(row.position);
          if (cached) return cached;
          const item = yield* decodeItem(row.payload).pipe(
            Effect.mapError(
              (cause) => new ProjectionStoreReadError({ threadId: input.threadId, cause }),
            ),
          );
          if (!isSearchableItem(item)) {
            return yield* new ProjectionStoreReadError({ threadId: input.threadId });
          }
          const key = textKey(item, cwd, input.skills ?? []);
          const segments = yield* Cache.get(
            key.text.length <= 32_768 ? textCache : largeTextCache,
            key,
          );
          const document = documentFor(row, item, countSegments(segments, input.query));
          documents.set(row.position, document);
          yield* Effect.yieldNow;
          return document;
        });
        const finish = Effect.gen(function* () {
          for (const row of rows) yield* count(row);
          const ordered = rows.map((row) => documents.get(row.position)!);
          scans.delete(cacheKey);
          scans.set(cacheKey, { sequence, documents: ordered, sourceThreadIds });
          if (scans.size > 8) {
            const oldest = scans.keys().next().value;
            if (oldest !== undefined) scans.delete(oldest);
          }
          return resultForSelection(selectMatch(ordered, input), ordered, sequence);
        });
        // Relative navigation needs the final counts. Initial searches can reveal an
        // identity immediately, scanning at/below the reading anchor before wrapping.
        if (input.index !== undefined || (input.offset ?? 0) !== 0)
          return Stream.fromEffect(finish);
        const anchor = Math.max(
          0,
          rows.findIndex((row) => row.entryId === input.start?.entryId),
        );
        for (let step = 0; step <= rows.length; step++) {
          const index = (anchor + step) % rows.length;
          const row = rows[index];
          if (!row) break;
          const document = yield* count(row);
          const occurrence =
            step === 0 && row.entryId === input.start?.entryId
              ? Math.min(input.start.occurrence, document.count)
              : 0;
          if (occurrence >= document.count) continue;
          const first: OrchestrationV2SearchThreadResult = {
            complete: false,
            snapshotSequence: sequence,
            totalMatches: 1,
            activeIndex: 0,
            match: { entryId: document.entryId, runId: document.runId, occurrence },
          };
          // The remainder is pulled only after the first frame has been delivered.
          return Stream.concat(Stream.succeed(first), Stream.fromEffect(finish));
        }
        return Stream.fromEffect(finish);
      }),
    );
  return {
    searchThreadStream,
    searchThread: (input: OrchestrationV2SearchThreadInput) =>
      searchThreadStream(input).pipe(
        Stream.runCollect,
        Effect.map((results) => results[results.length - 1]!),
      ),
  };
});
